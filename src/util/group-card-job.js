import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import {
    CHAT_COMPLETION_SOURCES,
    DEFAULT_AVATAR_PATH,
    TEXTGEN_TYPES,
} from '../constants.js';
import {
    JobManager,
    runWithConcurrency,
    throwIfAborted,
    withRetries,
} from './job-manager.js';
import { write as writeCharacterPngData } from '../character-card-parser.js';
import { getUniqueName } from '../util.js';
import { generateVoronoiComposite, generateGridComposite, generateMosaicComposite } from './voronoi-composite.js';
import {
    escapeXml,
    validateGeneratedGroupCardDescription,
    countXmlCorpus,
    extractXmlBlocksByTag,
    stripSummaryFromCharacterBlock,
    extractCommentFromCharacterBlock,
    extractKeysFromCharacterBlock,
    buildSummaryCharacterBlock,
    minifyXml,
} from '../../public/scripts/group-card-xml-parser.js';

const LLM_TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 50;

const API_OPENAI = 'https://api.openai.com/v1';
const API_OPENROUTER = 'https://openrouter.ai/api/v1';
const API_MISTRAL = 'https://api.mistral.ai/v1';
const API_GROQ = 'https://api.groq.com/openai/v1';
const API_CHUTES = 'https://llm.chutes.ai/v1';
const API_ELECTRONHUB = 'https://api.electronhub.ai/v1';
const API_NANOGPT = 'https://nano-gpt.com/api/v1';
const API_DEEPSEEK = 'https://api.deepseek.com/v1';
const API_XAI = 'https://api.x.ai/v1';
const API_AIMLAPI = 'https://api.aimlapi.com/v1';
const API_MOONSHOT = 'https://api.moonshot.ai/v1';
const API_FIREWORKS = 'https://api.fireworks.ai/inference/v1';
const API_COMETAPI = 'https://api.cometapi.com/v1';
const API_ZAI = 'https://api.z.ai/api/paas/v4';
const API_SILICONFLOW = 'https://api.siliconflow.com/v1';

const SECRETS_FILE = 'secrets.json';
const SECRET_KEYS = {
    VLLM: 'api_key_vllm',
    APHRODITE: 'api_key_aphrodite',
    TABBY: 'api_key_tabby',
    OPENAI: 'api_key_openai',
    OPENROUTER: 'api_key_openrouter',
    MISTRALAI: 'api_key_mistralai',
    CUSTOM: 'api_key_custom',
    LLAMACPP: 'api_key_llamacpp',
    GROQ: 'api_key_groq',
    CHUTES: 'api_key_chutes',
    ELECTRONHUB: 'api_key_electronhub',
    NANOGPT: 'api_key_nanogpt',
    GENERIC: 'api_key_generic',
    DEEPSEEK: 'api_key_deepseek',
    AIMLAPI: 'api_key_aimlapi',
    XAI: 'api_key_xai',
    FIREWORKS: 'api_key_fireworks',
    MOONSHOT: 'api_key_moonshot',
    COMETAPI: 'api_key_cometapi',
    ZAI: 'api_key_zai',
    SILICONFLOW: 'api_key_siliconflow',
};

const ALWAYS_INCLUDED_FIELDS = ['name', 'description'];
const OPTIONAL_FIELDS = ['personality', 'scenario', 'first_mes', 'mes_example'];
const CHARACTER_OPEN_TAG = '<character>';
const CHARACTER_CLOSE_TAG = '</character>';

function readSecret(directories, key, id = null) {
    const filePath = path.join(directories.root, SECRETS_FILE);

    if (!fs.existsSync(filePath)) {
        return '';
    }

    const secrets = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const secretArray = secrets[key];

    if (Array.isArray(secretArray) && secretArray.length > 0) {
        const activeSecret = secretArray.find((secret) =>
            id ? secret.id === id : secret.active,
        );
        return activeSecret?.value || '';
    }

    return '';
}

function normalizeSelectedFields(fields) {
    const includedFields = new Set(Array.isArray(fields) ? fields : []);
    return [
        ...ALWAYS_INCLUDED_FIELDS,
        ...OPTIONAL_FIELDS.filter((field) => includedFields.has(field)),
    ];
}

function getCharacterName(character) {
    return String(character?.name ?? character?.data?.name ?? '').trim();
}

function getCharacterField(character, field) {
    if (field === 'name') {
        return getCharacterName(character);
    }

    return String(character?.[field] ?? character?.data?.[field] ?? '');
}

function buildCharacterXmlBlock(character, fields) {
    const fieldXml = normalizeSelectedFields(fields)
        .map(
            (field) =>
                `  <${field}>${escapeXml(getCharacterField(character, field))}</${field}>`,
        )
        .join('\n');

    return `${CHARACTER_OPEN_TAG}\n${fieldXml}\n${CHARACTER_CLOSE_TAG}`;
}

function buildCombinePrompt(prompt, characters, fields, nudge) {
    const payload = characters
        .map((character) => buildCharacterXmlBlock(character, fields))
        .join('\n\n');

    let result = `${String(prompt ?? '').trim()}\n\nInput characters:\n${payload}`;
    if (nudge && String(nudge).trim()) {
        result += `\n\nAdditional guidance: ${String(nudge).trim()}`;
    }
    return result;
}

function buildPostMergePrompt(prompt, mergedOutput) {
    return `${String(prompt ?? '').trim()}\n\nMerged character definitions:\n${String(mergedOutput ?? '').trim()}`;
}

function normalizeConcurrency(value) {
    const concurrency = Number(value);

    if (!Number.isFinite(concurrency) || concurrency < 1) {
        return DEFAULT_CONCURRENCY;
    }

    return Math.min(Math.floor(concurrency), MAX_CONCURRENCY);
}

function normalizeProcessingMode(_value) {
    return 'parallel';
}

function normalizePostProcessMode(value) {
    return ['replace', 'prepend', 'append'].includes(value) ? value : 'replace';
}

function buildLlmUrl(apiUrl) {
    const baseUrl = String(apiUrl ?? '')
        .trim()
        .replace(/\/+$/, '');

    if (!baseUrl) {
        throw new Error('LLM API URL is required.');
    }

    if (/\/chat\/completions$/i.test(baseUrl)) {
        return baseUrl;
    }

    return `${baseUrl}/chat/completions`;
}

export function resolveOpenAiLikeConfig(llmConfig) {
    const settings = llmConfig.openai ?? {};
    const directories = llmConfig.directories;
    const source = settings.chat_completion_source;
    const reverseProxy = String(settings.reverse_proxy ?? '').trim();

    if (reverseProxy) {
        return {
            apiUrl: reverseProxy,
            apiKey: settings.proxy_password ?? '',
            model: getOpenAiLikeModel(settings, source),
            headers: {},
            generationSettings: settings,
        };
    }

    const sourceConfig = getOpenAiSourceConfig(source, settings);

    if (!sourceConfig) {
        throw new Error(
            `Unsupported server-side group card LLM source: ${source || 'unknown'}.`,
        );
    }

    return {
        apiUrl: sourceConfig.apiUrl,
        apiKey: sourceConfig.secretKey
            ? readSecret(directories, sourceConfig.secretKey, settings.secret_id)
            : '',
        model: sourceConfig.model,
        headers: sourceConfig.headers ?? {},
        generationSettings: settings,
    };
}

function getOpenAiSourceConfig(source, settings) {
    switch (source) {
        case CHAT_COMPLETION_SOURCES.OPENAI:
            return {
                apiUrl: API_OPENAI,
                secretKey: SECRET_KEYS.OPENAI,
                model: settings.openai_model,
            };
        case CHAT_COMPLETION_SOURCES.OPENROUTER:
            return {
                apiUrl: API_OPENROUTER,
                secretKey: SECRET_KEYS.OPENROUTER,
                model: settings.openrouter_model,
                headers: {
                    'HTTP-Referer': 'https://sillytavern.app',
                    'X-Title': 'SillyTavern',
                },
            };
        case CHAT_COMPLETION_SOURCES.CUSTOM:
            return {
                apiUrl: settings.custom_url,
                secretKey: SECRET_KEYS.CUSTOM,
                model: settings.custom_model,
            };
        case CHAT_COMPLETION_SOURCES.MISTRALAI:
            return {
                apiUrl: API_MISTRAL,
                secretKey: SECRET_KEYS.MISTRALAI,
                model: settings.mistralai_model,
            };
        case CHAT_COMPLETION_SOURCES.DEEPSEEK:
            return {
                apiUrl: API_DEEPSEEK,
                secretKey: SECRET_KEYS.DEEPSEEK,
                model: settings.deepseek_model,
            };
        case CHAT_COMPLETION_SOURCES.XAI:
            return {
                apiUrl: API_XAI,
                secretKey: SECRET_KEYS.XAI,
                model: settings.xai_model,
            };
        case CHAT_COMPLETION_SOURCES.AIMLAPI:
            return {
                apiUrl: API_AIMLAPI,
                secretKey: SECRET_KEYS.AIMLAPI,
                model: settings.aimlapi_model,
            };
        case CHAT_COMPLETION_SOURCES.GROQ:
            return {
                apiUrl: API_GROQ,
                secretKey: SECRET_KEYS.GROQ,
                model: settings.groq_model,
            };
        case CHAT_COMPLETION_SOURCES.CHUTES:
            return {
                apiUrl: API_CHUTES,
                secretKey: SECRET_KEYS.CHUTES,
                model: settings.chutes_model,
            };
        case CHAT_COMPLETION_SOURCES.ELECTRONHUB:
            return {
                apiUrl: API_ELECTRONHUB,
                secretKey: SECRET_KEYS.ELECTRONHUB,
                model: settings.electronhub_model,
            };
        case CHAT_COMPLETION_SOURCES.NANOGPT:
            return {
                apiUrl: API_NANOGPT,
                secretKey: SECRET_KEYS.NANOGPT,
                model: settings.nanogpt_model,
            };
        case CHAT_COMPLETION_SOURCES.MOONSHOT:
            return {
                apiUrl: API_MOONSHOT,
                secretKey: SECRET_KEYS.MOONSHOT,
                model: settings.moonshot_model,
            };
        case CHAT_COMPLETION_SOURCES.FIREWORKS:
            return {
                apiUrl: API_FIREWORKS,
                secretKey: SECRET_KEYS.FIREWORKS,
                model: settings.fireworks_model,
            };
        case CHAT_COMPLETION_SOURCES.COMETAPI:
            return {
                apiUrl: API_COMETAPI,
                secretKey: SECRET_KEYS.COMETAPI,
                model: settings.cometapi_model,
            };
        case CHAT_COMPLETION_SOURCES.SILICONFLOW:
            return {
                apiUrl: API_SILICONFLOW,
                secretKey: SECRET_KEYS.SILICONFLOW,
                model: settings.siliconflow_model,
            };
        case CHAT_COMPLETION_SOURCES.ZAI:
            return {
                apiUrl: API_ZAI,
                secretKey: SECRET_KEYS.ZAI,
                model: settings.zai_model,
            };
        default:
            return null;
    }
}

function getOpenAiLikeModel(settings, source) {
    const sourceConfig = getOpenAiSourceConfig(source, settings);
    return sourceConfig?.model ?? settings.openai_model ?? settings.custom_model;
}

export function resolveTextGenOpenAiConfig(llmConfig) {
    const settings = llmConfig.textgenerationwebui ?? {};
    const type = settings.type;
    const apiUrl = settings.server_urls?.[type];
    const model = getTextGenModel(settings, type);
    const secretKey = getTextGenSecretKey(type);
    const apiKey = secretKey ? readSecret(llmConfig.directories, secretKey) : '';

    if (!apiUrl) {
        throw new Error(
            'Text Completion API server URL is required for server-side group card generation.',
        );
    }

    return {
        apiUrl,
        apiKey,
        model,
        headers: {},
        generationSettings: settings,
    };
}

function getTextGenModel(settings, type) {
    switch (type) {
        case TEXTGEN_TYPES.OPENROUTER:
            return settings.openrouter_model;
        case TEXTGEN_TYPES.VLLM:
            return settings.vllm_model;
        case TEXTGEN_TYPES.LLAMACPP:
            return settings.llamacpp_model;
        case TEXTGEN_TYPES.TABBY:
            return settings.tabby_model;
        case TEXTGEN_TYPES.APHRODITE:
            return settings.aphrodite_model;
        case TEXTGEN_TYPES.GENERIC:
            return settings.generic_model;
        default:
            return settings.custom_model || settings[type + '_model'] || 'default';
    }
}

function getTextGenSecretKey(type) {
    switch (type) {
        case TEXTGEN_TYPES.OPENROUTER:
            return SECRET_KEYS.OPENROUTER;
        case TEXTGEN_TYPES.VLLM:
            return SECRET_KEYS.VLLM;
        case TEXTGEN_TYPES.LLAMACPP:
            return SECRET_KEYS.LLAMACPP;
        case TEXTGEN_TYPES.TABBY:
            return SECRET_KEYS.TABBY;
        case TEXTGEN_TYPES.APHRODITE:
            return SECRET_KEYS.APHRODITE;
        case TEXTGEN_TYPES.GENERIC:
            return SECRET_KEYS.GENERIC;
        default:
            return null;
    }
}

export function resolveLlmConfig(llmConfig) {
    if (llmConfig.apiUrl) {
        return {
            apiUrl: llmConfig.apiUrl,
            apiKey: llmConfig.apiKey ?? '',
            model: llmConfig.model,
            headers: llmConfig.headers ?? {},
            generationSettings: {},
        };
    }

    if (llmConfig.type === 'openai') {
        return resolveOpenAiLikeConfig(llmConfig);
    }

    if (llmConfig.type === 'textgenerationwebui') {
        return resolveTextGenOpenAiConfig(llmConfig);
    }

    throw new Error(
        `Unsupported server-side group card API type: ${llmConfig.type || 'unknown'}.`,
    );
}

export async function callLlmApi(llmConfig, prompt, signal) {
    if (!llmConfig || typeof llmConfig !== 'object') {
        throw new Error('LLM config is required.');
    }

    const resolvedConfig = resolveLlmConfig(llmConfig);

    if (!resolvedConfig.model) {
        throw new Error('LLM model is required.');
    }

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), LLM_TIMEOUT_MS);
    const onAbort = () => timeoutController.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
        const headers = {
            ...resolvedConfig.headers,
            'Content-Type': 'application/json',
        };

        if (resolvedConfig.apiKey) {
            headers.Authorization = `Bearer ${resolvedConfig.apiKey}`;
        }

        const settings = resolvedConfig.generationSettings ?? {};

        // Read ALL generation params directly from chat preset settings.
        // No legacy fallbacks. Preset is source.
        const body = {
            model: resolvedConfig.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens:
				settings.openai_max_tokens ??
				settings.max_tokens ??
				settings.max_length ??
				settings.max_new_tokens ??
				4096,
            temperature: settings.temp_openai ?? settings.temp ?? 0.7,
            top_p: settings.top_p_openai ?? settings.top_p ?? 1,
            stream: false,
        };

        // Add frequency_penalty if set in preset
        if (settings.freq_pen_openai != null) {
            body.frequency_penalty = Number(settings.freq_pen_openai);
        } else if (settings.freq_pen != null) {
            body.frequency_penalty = Number(settings.freq_pen);
        }

        // Add presence_penalty if set in preset
        if (settings.pres_pen_openai != null) {
            body.presence_penalty = Number(settings.pres_pen_openai);
        } else if (settings.presence_pen != null) {
            body.presence_penalty = Number(settings.presence_pen);
        }

        // Add top_k if set and > 0
        if (Number(settings.top_k_openai) > 0) {
            body.top_k = Number(settings.top_k_openai);
        } else if (Number(settings.top_k) > 0) {
            body.top_k = Number(settings.top_k);
        }

        // Add min_p if set and > 0
        if (Number(settings.min_p_openai) > 0) {
            body.min_p = Number(settings.min_p_openai);
        } else if (Number(settings.min_p) > 0) {
            body.min_p = Number(settings.min_p);
        }

        // Add repetition_penalty if set and not default 1.0
        if (
            settings.repetition_penalty_openai != null &&
			Number(settings.repetition_penalty_openai) !== 1
        ) {
            body.repetition_penalty = Number(settings.repetition_penalty_openai);
        } else if (settings.rep_pen != null && Number(settings.rep_pen) !== 1) {
            body.repetition_penalty = Number(settings.rep_pen);
        }

        const response = await fetch(buildLlmUrl(resolvedConfig.apiUrl), {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: timeoutController.signal,
        });

        if (!response.ok) {
            throw new Error(
                `LLM API error: ${response.status} ${await response.text()}`,
            );
        }

        const data = await response.json();
        const output =
			data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '';

        if (!output) {
            throw new Error('LLM API returned empty output.');
        }

        return output;
    } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
    }
}

function formatLorebookSummaryField(label, value) {
    const trimmedValue = String(value ?? '').trim();
    return trimmedValue ? `${label}:\n${trimmedValue}` : '';
}

function buildLorebookEntryContent(character, fields) {
    const includedFields = normalizeSelectedFields(fields);
    const fieldSections = [
        `Name: ${getCharacterName(character)}`,
        formatLorebookSummaryField(
            'Description',
            getCharacterField(character, 'description'),
        ),
        includedFields.includes('personality')
            ? formatLorebookSummaryField(
                'Personality',
                getCharacterField(character, 'personality'),
            )
            : '',
        includedFields.includes('scenario')
            ? formatLorebookSummaryField(
                'Scenario',
                getCharacterField(character, 'scenario'),
            )
            : '',
        includedFields.includes('first_mes')
            ? formatLorebookSummaryField(
                'First message',
                getCharacterField(character, 'first_mes'),
            )
            : '',
        includedFields.includes('mes_example')
            ? formatLorebookSummaryField(
                'Example messages',
                getCharacterField(character, 'mes_example'),
            )
            : '',
    ].filter(Boolean);

    return fieldSections.join('\n\n');
}

function buildLorebookEntry(character, index, fields) {
    const name = getCharacterName(character);

    return {
        uid: index,
        key: [name],
        keysecondary: [],
        comment: name,
        content: buildLorebookEntryContent(character, fields),
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100 - index,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        aiFunctionName: name
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+/, ''),
        aiDescription: `Content for ${name}`,
    };
}

function buildLorebookData(characters, fields) {
    return {
        entries: Object.fromEntries(
            characters.map((character, index) => [
                index,
                buildLorebookEntry(character, index, fields),
            ]),
        ),
    };
}

function extractAllTopLevelXmlBlocks(xmlString) {
    const text = String(xmlString ?? '').trim();
    const anyOpenRegex = /<([a-zA-Z_][\w.-]*)(?:\s+[^>]*[^/])?>/g;
    const blocks = [];
    let consumedUpTo = 0;
    let match;

    while ((match = anyOpenRegex.exec(text)) !== null) {
        const blockStart = match.index;
        if (blockStart < consumedUpTo) {
            continue;
        }

        const tagName = match[1];
        const subBlocks = extractXmlBlocksByTag(text.slice(blockStart), tagName);
        const block = subBlocks[0];
        const nextSearchIndex = blockStart + match[0].length;

        if (!block) {
            consumedUpTo = Math.max(consumedUpTo, nextSearchIndex);
            anyOpenRegex.lastIndex = consumedUpTo;
            continue;
        }

        const blockEnd = blockStart + block.raw.length;
        blocks.push({
            tag: block.tag,
            content: block.content,
            raw: text.slice(blockStart, blockEnd),
        });
        consumedUpTo = blockEnd;
        anyOpenRegex.lastIndex = Math.max(consumedUpTo, nextSearchIndex);
    }

    return blocks;
}

function extractCharacterBlockName(block, index) {
    const name = String(
        extractXmlBlocksByTag(block?.content ?? '', 'name')[0]?.content ?? '',
    ).trim();

    return name || `Character ${index + 1}`;
}

function buildDynamicLorebookEntry(block, index) {
    const name = extractCharacterBlockName(block, index);
    const extractedComment = extractCommentFromCharacterBlock(block);
    const extractedKeys = extractKeysFromCharacterBlock(block);

    return {
        uid: index,
        key: extractedKeys.length > 0 ? extractedKeys : [name],
        keysecondary: [],
        comment: extractedComment.length > 0 ? extractedComment : name,
        content: stripSummaryFromCharacterBlock(block.raw),
        constant: false,
        vectorized: false,
        selective: true,
        selectiveLogic: 0,
        addMemo: true,
        order: 100 - index,
        position: 0,
        disable: false,
        ignoreBudget: false,
        excludeRecursion: false,
        preventRecursion: false,
        matchPersonaDescription: false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario: false,
        matchCreatorNotes: false,
        delayUntilRecursion: 0,
        probability: 100,
        useProbability: true,
        depth: 4,
        outletName: '',
        group: '',
        groupOverride: false,
        groupWeight: 100,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automationId: '',
        role: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        triggers: [],
        aiFunctionName: name
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+/, ''),
        aiDescription: `Content for ${name}`,
    };
}

function buildDynamicLorebookData(generatedDescription) {
    const characterBlocks = extractAllTopLevelXmlBlocks(
        generatedDescription,
    ).filter((block) => block.tag === 'character');

    return {
        entries: Object.fromEntries(
            characterBlocks.map((block, index) => [
                index,
                buildDynamicLorebookEntry(block, index),
            ]),
        ),
    };
}

function buildDynamicSummaryDescription(generatedDescription) {
    return extractAllTopLevelXmlBlocks(generatedDescription)
        .map((block) =>
            block.tag === 'character'
                ? buildSummaryCharacterBlock(block.raw)
                : block.raw,
        )
        .join('\n\n');
}

function buildFinalGroupDescription(generatedDescription, config) {
    let description = config.dynamicLorebook
        ? buildDynamicSummaryDescription(generatedDescription)
        : String(generatedDescription ?? '');

    if (config.minify) {
        description = minifyXml(description, {
            compact: !config.minifySingleLine,
            singleLine: config.minifySingleLine,
        });
    }

    return description;
}

function createCharacterData(
    config,
    generatedDescription,
    avatarName,
    worldName,
) {
    const groupName = String(config.groupName ?? '').trim();
    const sourceNames = config.characters
        .map((character) => getCharacterName(character))
        .join(', ');
    const chatName = `${groupName} - ${new Date().toLocaleString()}`;

    return {
        name: groupName,
        description: generatedDescription,
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creatorcomment: `Generated group card from: ${sourceNames}`,
        avatar: 'none',
        chat: chatName,
        talkativeness: '0.5',
        fav: false,
        tags: [],
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: groupName,
            description: generatedDescription,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: `Generated group card from: ${sourceNames}`,
            system_prompt: '',
            post_history_instructions: '',
            tags: [],
            creator: '',
            character_version: '',
            alternate_greetings: [],
            extensions: {
                talkativeness: '0.5',
                fav: false,
                world: worldName,
                depth_prompt: {
                    prompt: '',
                    depth: 4,
                    role: 'system',
                },
            },
        },
        extensions: {
            world: worldName,
        },
        create_date: Date.now(),
        avatar_filename: avatarName,
    };
}

function getUniqueCharacterInternalName(groupName, directories) {
    const safeName = sanitize(groupName) || 'Group Card';
    return (
        getUniqueName(
            safeName,
            (name) => fs.existsSync(path.join(directories.characters, `${name}.png`)),
            {
                nameBuilder: (base, index) => (index === 0 ? base : `${base}${index}`),
                startIndex: 0,
                maxTries: 10000,
            },
        ) ?? safeName
    );
}

/**
 * @typedef {object} GroupCardJob
 * @property {string} id
 * @property {'pending'|'running'|'completed'|'failed'|'cancelled'} status
 * @property {object} config
 * @property {object} progress
 * @property {object} results
 * @property {string|null} error
 * @property {number} createdAt
 * @property {Set<import('express').Response>} sseClients
 * @property {AbortController|null} abortController
 * @property {number} eventCounter
 * @property {Array<{id:number,eventType:string,data:object}>} eventLog
 */

export class GroupCardJobManager extends JobManager {
    /**
	 * @param {{ttlMs?: number, cleanupIntervalMs?: number}} [options]
	 */
    constructor(options = {}) {
        super(options);
    }

    /**
	 * Creates and starts a regen job for a subset of characters.
	 * @param {object} config Job config with characters, prompt, nudges, fields, concurrency, llm.
	 * @returns {Promise<{ jobId: string, job: GroupCardJob }>} Created job.
	 */
    async createRegenJob(config) {
        const validatedConfig = {
            ...(config && typeof config === 'object' ? config : {}),
            processingMode: 'parallel',
            concurrency: normalizeConcurrency(config?.concurrency),
            characters: Array.isArray(config?.characters)
                ? config.characters.filter(
                    (character) => character && typeof character === 'object',
                )
                : [],
            fields: normalizeSelectedFields(config?.fields),
            llm: {
                ...(config?.llm && typeof config.llm === 'object' ? config.llm : {}),
                directories: config.directories,
            },
            nudges: config?.nudges ?? {},
        };

        const job = this.createJob(validatedConfig, { autoStart: false });

        // Run in background — don't await.
        this.runRegenJob(job.id, validatedConfig).catch((error) => {
            if (job.abortController?.signal.aborted) return;
            job.status = 'failed';
            job.error = error?.message ?? String(error);
            this.emitEvent(job.id, 'job_failed', { error: job.error });
            setTimeout(() => this.closeSseClients(job), 50);
        });

        return { jobId: job.id, job };
    }

    /**
	 * Runs a regen job — generates only the requested characters.
	 * @param {string} jobId Job ID.
	 * @param {object} config Validated config.
	 * @returns {Promise<void>}
	 */
    async runRegenJob(jobId, config) {
        const job = this.getJob(jobId);
        if (!job || job.status !== 'pending') return;

        job.status = 'running';
        job.progress = { step: 'started' };
        this.emitEvent(jobId, 'job_started', { id: jobId });

        try {
            await this.generateIndividualMode(job, config, config.concurrency);

            job.progress = { step: 'completed' };
            job.status = 'completed';
            this.emitEvent(jobId, 'job_completed', job.results);
            setTimeout(() => this.closeSseClients(job), 50);
        } catch (error) {
            if (job.abortController?.signal.aborted) {
                this.closeSseClients(job);
                return;
            }

            job.status = 'failed';
            job.error = error?.message ?? String(error);
            this.emitEvent(jobId, 'job_failed', { error: job.error });
            setTimeout(() => this.closeSseClients(job), 50);
        }
    }

    /**
	 * Runs the group card generation pipeline.
	 * @param {string} jobId Job ID.
	 * @returns {Promise<void>}
	 */
    async runJob(jobId) {
        const job = this.getJob(jobId);
        if (!job || job.status !== 'pending') {
            return;
        }

        job.status = 'running';
        job.progress = { step: 'started' };
        this.emitEvent(jobId, 'job_started', { id: jobId });

        const createdArtifacts = {
            characterPath: '',
            lorebookPath: '',
            tempAvatarPath: '',
            chatPath: '',
        };

        try {
            const signal = job.abortController?.signal;
            const config = this.validateJobConfig(job.config);
            throwIfAborted(signal);

            let generatedDescription = await this.generateDescription(job, config);
            throwIfAborted(signal);

            if (
                config.postMergeEnabled &&
				String(config.postMergePrompt ?? '').trim()
            ) {
                job.progress = { step: 'post_merge' };
                this.emitEvent(jobId, 'post_merge_started', {});
                const postMergeOutput = await withRetries(
                    () =>
                        callLlmApi(
                            config.llm,
                            buildPostMergePrompt(
                                config.postMergePrompt,
                                generatedDescription,
                            ),
                            signal,
                        ),
                    signal,
                );
                const validatedPostMergeOutput = validateGeneratedGroupCardDescription(
                    postMergeOutput,
                    0,
                );

                switch (config.postProcessMode) {
                    case 'prepend':
                        generatedDescription = `${validatedPostMergeOutput}\n\n${generatedDescription}`;
                        break;
                    case 'append':
                        generatedDescription = `${generatedDescription}\n\n${validatedPostMergeOutput}`;
                        break;
                    case 'replace':
                    default: {
                        const inputCorpusCount = countXmlCorpus(generatedDescription);
                        const outputCorpusCount = countXmlCorpus(validatedPostMergeOutput);

                        if (
                            inputCorpusCount > 0 &&
							outputCorpusCount !== inputCorpusCount
                        ) {
                            throw new Error(
                                `Post-processing returned ${outputCorpusCount} root XML corpus block(s), expected ${inputCorpusCount}.`,
                            );
                        }

                        generatedDescription = validatedPostMergeOutput;
                        break;
                    }
                }

                job.results.postProcessOutput = generatedDescription;
                this.emitEvent(jobId, 'post_merge_completed', {
                    output: generatedDescription,
                });
            }

            const result = await this.createGeneratedArtifacts(
                job,
                config,
                generatedDescription,
                createdArtifacts,
            );

            job.progress = { step: 'completed' };
            job.results = { ...job.results, ...result };
            job.status = 'completed';
            this.emitEvent(jobId, 'job_completed', job.results);
            // Defer close to allow SSE event to flush to clients
            setTimeout(() => this.closeSseClients(job), 50);
        } catch (error) {
            this.cleanupArtifacts(createdArtifacts);

            if (job.abortController?.signal.aborted) {
                this.closeSseClients(job);
                return;
            }

            job.status = 'failed';
            job.error = error?.message ?? String(error);
            this.emitEvent(jobId, 'job_failed', { error: job.error });
            // Defer close to allow SSE event to flush to clients
            setTimeout(() => this.closeSseClients(job), 50);
        }
    }

    /**
	 * @param {object} config Raw job config.
	 * @returns {object} Validated config.
	 */
    validateJobConfig(config) {
        if (!config || typeof config !== 'object') {
            throw new Error('Job config is required.');
        }

        const groupName = String(config.groupName ?? '').trim();
        if (!groupName) {
            throw new Error('Group name is required.');
        }

        const prompt = String(config.prompt ?? '').trim();
        if (!prompt) {
            throw new Error('Prompt is required.');
        }

        const characters = Array.isArray(config.characters)
            ? config.characters.filter((character) => getCharacterName(character))
            : [];
        if (characters.length < 2) {
            throw new Error('At least two valid characters are required.');
        }

        if (
            !config.directories?.characters ||
			!config.directories?.worlds ||
			!config.directories?.chats
        ) {
            throw new Error('User directories are required.');
        }

        return {
            ...config,
            groupName,
            prompt,
            parallelPrompt: String(config.parallelPrompt ?? prompt).trim() || prompt,
            characters,
            fields: Array.isArray(config.fields) ? config.fields : [],
            processingMode: normalizeProcessingMode(config.processingMode),
            concurrency: normalizeConcurrency(config.concurrency),
            postMergeEnabled: Boolean(config.postMergeEnabled),
            postMergePrompt: String(config.postMergePrompt ?? ''),
            postProcessMode: normalizePostProcessMode(config.postProcessMode),
            createLorebook: Boolean(config.createLorebook || config.dynamicLorebook),
            dynamicLorebook: Boolean(config.dynamicLorebook),
            minify: Boolean(config.minify),
            minifySingleLine: Boolean(config.minifySingleLine),
            cropStrategy: config.cropStrategy,
            cropPadding: config.cropPadding,
            avatarOffsets: Array.isArray(config.avatarOffsets)
                ? config.avatarOffsets
                : [],
            directories: config.directories,
            llm: {
                ...(config.llm && typeof config.llm === 'object' ? config.llm : {}),
                directories: config.directories,
            },
        };
    }

    /**
	 * @param {GroupCardJob} job Job object.
	 * @param {object} config Validated config.
	 * @returns {Promise<string>} Generated and validated description.
	 */
    async generateDescription(job, config) {
        return this.generateIndividualMode(job, config, config.concurrency);
    }

    /**
	 * @param {GroupCardJob} job Job object.
	 * @param {object} config Validated config.
	 * @param {number} concurrency Max concurrent requests.
	 * @returns {Promise<string>} Generated description.
	 */
    async generateIndividualMode(job, config, concurrency) {
        const signal = job.abortController?.signal;
        const warnings = [];
        job.results.characterOutputs = [];

        this.emitEvent(job.id, 'merge_started', {
            mode: 'parallel',
            concurrency,
        });

        const tasks = config.characters.map((character, index) => async () => {
            const name = getCharacterName(character);
            throwIfAborted(signal);
            job.progress = {
                step: 'character',
                index,
                total: config.characters.length,
                name,
            };
            this.emitEvent(job.id, 'character_started', { index, name });

            try {
                const charPrompt = config.parallelPrompt || config.prompt;
                const nudge =
					config.nudges?.[index] ?? config.nudges?.[String(index)] ?? '';
                const output = await withRetries(
                    () =>
                        callLlmApi(
                            config.llm,
                            buildCombinePrompt(charPrompt, [character], config.fields, nudge),
                            signal,
                        ),
                    signal,
                );
                const validatedOutput = validateGeneratedGroupCardDescription(
                    output,
                    1,
                );
                job.results.characterOutputs.push({
                    characterIndex: index,
                    characterName: name,
                    xmlOutput: validatedOutput,
                    parseStatus: 'ok',
                });
                this.emitEvent(job.id, 'character_completed', {
                    index,
                    name,
                    output: validatedOutput,
                });
                return { ok: true, output: validatedOutput };
            } catch (error) {
                const message = error?.message ?? String(error);
                job.results.characterOutputs.push({
                    characterIndex: index,
                    characterName: name,
                    xmlOutput: '',
                    parseStatus: 'error',
                    error: message,
                });
                this.emitEvent(job.id, 'character_failed', {
                    index,
                    name,
                    error: message,
                });
                warnings.push(`Skipped ${name}: ${message}`);
                return { ok: false, error: message };
            }
        });

        const results = await runWithConcurrency(tasks, concurrency);
        throwIfAborted(signal);

        const outputs = results
            .filter((result) => result?.ok && result.output)
            .map((result) => result.output);

        if (!outputs.length) {
            throw new Error('All character generations failed.');
        }

        const mergedOutput = validateGeneratedGroupCardDescription(
            outputs.join('\n\n'),
            outputs.length,
        );
        job.results = { ...job.results, warnings };
        this.emitEvent(job.id, 'merge_completed', {
            output: mergedOutput,
            warnings,
        });
        return mergedOutput;
    }

    /**
	 * @param {GroupCardJob} job Job object.
	 * @param {object} config Validated config.
	 * @param {string} generatedDescription Final generated description.
	 * @param {{characterPath:string,lorebookPath:string,tempAvatarPath:string,chatPath:string}} createdArtifacts Artifacts to clean on failure.
	 * @returns {Promise<{avatar:string, world:string, warnings?:string[]}>} Created artifacts.
	 */
    async createGeneratedArtifacts(
        job,
        config,
        generatedDescription,
        createdArtifacts,
    ) {
        const signal = job.abortController?.signal;
        throwIfAborted(signal);

        job.progress = { step: 'avatar' };
        this.emitEvent(job.id, 'avatar_started', {});

        const avatarPaths = config.characters
            .map((character) => character.avatar)
            .filter(
                (avatar) =>
                    typeof avatar === 'string' &&
					avatar &&
					!avatar.includes('..') &&
					!avatar.includes('/') &&
					!avatar.includes('\\'),
            )
            .map((avatar) => path.join(config.directories.characters, avatar))
            .filter((avatarPath) => fs.existsSync(avatarPath));

        if (!avatarPaths.length) {
            avatarPaths.push(DEFAULT_AVATAR_PATH);
        }

        const tempAvatarPath = path.join(
            os.tmpdir(),
            `group-card-${crypto.randomUUID()}.png`,
        );
        createdArtifacts.tempAvatarPath = tempAvatarPath;
        const layout = config.layout || 'voronoi';
        let compositeResult;
        if (layout === 'mosaic') {
            compositeResult = await generateMosaicComposite(
                avatarPaths,
                tempAvatarPath,
                {
                    cropStrategy: config.cropStrategy,
                    cropPadding: config.cropPadding,
                    offsets: config.avatarOffsets,
                    gap: config.gap ?? 2,
                },
            );
        } else if (layout === 'grid-portrait' || layout === 'grid-square') {
            compositeResult = await generateGridComposite(
                avatarPaths,
                tempAvatarPath,
                {
                    cropStrategy: config.cropStrategy,
                    cropPadding: config.cropPadding,
                    offsets: config.avatarOffsets,
                    cellAspect: layout,
                    gap: config.gap ?? 2,
                    maxCols: config.maxCols ?? 0,
                    gridAlign: config.gridAlign ?? 'center',
                    gridVAlign: config.gridVAlign ?? 'center',
                    gridDirection: config.gridDirection ?? 'row',
                    cellFit: config.cellFit ?? 'cover',
                },
            );
        } else {
            compositeResult = await generateVoronoiComposite(
                avatarPaths,
                tempAvatarPath,
                {
                    cropStrategy: config.cropStrategy,
                    cropPadding: config.cropPadding,
                    offsets: config.avatarOffsets,
                },
            );
        }
        const { path: compositePath } = compositeResult;
        this.emitEvent(job.id, 'avatar_completed', {});
        throwIfAborted(signal);

        const internalName = getUniqueCharacterInternalName(
            config.groupName,
            config.directories,
        );
        const avatarName = `${internalName}.png`;
        const characterPath = path.join(config.directories.characters, avatarName);
        const worldName = config.createLorebook ? config.groupName : '';
        const finalDescription = buildFinalGroupDescription(
            generatedDescription,
            config,
        );
        const characterData = createCharacterData(
            config,
            finalDescription,
            avatarName,
            worldName,
        );
        const avatarBuffer = fs.readFileSync(compositePath);
        const outputImage = writeCharacterPngData(
            avatarBuffer,
            JSON.stringify(characterData),
        );
        writeFileAtomicSync(characterPath, outputImage);
        createdArtifacts.characterPath = characterPath;

        const chatsPath = path.join(config.directories.chats, internalName);
        if (!fs.existsSync(chatsPath)) {
            fs.mkdirSync(chatsPath, { recursive: true });
            createdArtifacts.chatPath = chatsPath;
        }

        this.emitEvent(job.id, 'card_created', { avatar: avatarName });

        if (config.createLorebook) {
            const lorebookPath = path.join(
                config.directories.worlds,
                sanitize(`${config.groupName}.json`),
            );
            const lorebookData = config.dynamicLorebook
                ? buildDynamicLorebookData(generatedDescription)
                : buildLorebookData(config.characters, config.fields);
            writeFileAtomicSync(lorebookPath, JSON.stringify(lorebookData, null, 4));
            createdArtifacts.lorebookPath = lorebookPath;
            this.emitEvent(job.id, 'lorebook_created', { world: config.groupName });
        }

        if (
            createdArtifacts.tempAvatarPath &&
			fs.existsSync(createdArtifacts.tempAvatarPath)
        ) {
            fs.rmSync(createdArtifacts.tempAvatarPath, { force: true });
            createdArtifacts.tempAvatarPath = '';
        }

        return {
            avatar: avatarName,
            world: worldName,
            warnings: job.results.warnings ?? [],
        };
    }

    /**
	 * @param {{characterPath:string,lorebookPath:string,tempAvatarPath:string,chatPath:string}} artifacts Created artifacts.
	 */
    cleanupArtifacts(artifacts) {
        for (const artifactPath of [
            artifacts.characterPath,
            artifacts.lorebookPath,
            artifacts.tempAvatarPath,
            artifacts.chatPath,
        ]) {
            if (artifactPath && fs.existsSync(artifactPath)) {
                fs.rmSync(artifactPath, { force: true, recursive: true });
            }
        }
    }
}

export const groupCardJobManager = new GroupCardJobManager();

process.once('SIGINT', () => groupCardJobManager.shutdown());
process.once('SIGTERM', () => groupCardJobManager.shutdown());
