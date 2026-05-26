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
import { write as writeCharacterPngData } from '../character-card-parser.js';
import { getUniqueName } from '../util.js';
import { readSecret, SECRET_KEYS } from '../endpoints/secrets.js';
import { generateVoronoiComposite } from './voronoi-composite.js';
import {
    escapeXml,
    validateGeneratedGroupCardDescription,
} from '../../public/scripts/group-card-xml-parser.js';

const JOB_TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const LLM_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_LLM_RETRIES = 3;
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

const ALWAYS_INCLUDED_FIELDS = ['name', 'description'];
const OPTIONAL_FIELDS = ['personality', 'scenario', 'first_mes', 'mes_example'];
const CHARACTER_OPEN_TAG = '<character>';
const CHARACTER_CLOSE_TAG = '</character>';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_EVENT_TYPES = new Set(['job_completed', 'job_failed']);
const TERMINAL_SSE_RETRY_MS = 24 * 60 * 60 * 1000;

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

function buildCombinePrompt(prompt, characters, fields) {
    const payload = characters
        .map((character) => buildCharacterXmlBlock(character, fields))
        .join('\n\n');

    return `${String(prompt ?? '').trim()}\n\nInput characters:\n${payload}`;
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

function normalizeProcessingMode(value) {
    return ['combined', 'parallel', 'serial'].includes(value)
        ? value
        : 'combined';
}

function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Job cancelled.'));
            return;
        }

        const timeout = setTimeout(resolve, ms);

        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timeout);
                reject(new Error('Job cancelled.'));
            },
            { once: true },
        );
    });
}

function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new Error('Job cancelled.');
    }
}

async function withRetries(task, signal, attempts = MAX_LLM_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        throwIfAborted(signal);

        try {
            return await task();
        } catch (error) {
            lastError = error;

            if (attempt >= attempts) {
                break;
            }

            await delay(1000 * 2 ** (attempt - 1), signal);
        }
    }

    throw lastError;
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

function resolveOpenAiLikeConfig(llmConfig) {
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

function resolveTextGenOpenAiConfig(llmConfig) {
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

function resolveLlmConfig(llmConfig) {
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

async function callLlmApi(llmConfig, prompt, signal) {
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

async function runWithConcurrency(tasks, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const taskIndex = index++;
            results[taskIndex] = await tasks[taskIndex]();
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
    );
    return results;
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

export class GroupCardJobManager {
    /**
	 * @param {{ttlMs?: number, cleanupIntervalMs?: number}} [options]
	 */
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? JOB_TTL_MS;
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
        /** @type {Map<string, GroupCardJob>} */
        this.jobs = new Map();
        this.cleanupTimer = setInterval(
            () => this.cleanup(),
            this.cleanupIntervalMs,
        );
        this.cleanupTimer.unref?.();
    }

    /**
	 * Creates a group card generation job and starts the placeholder runner.
	 * @param {object} config Full job config from client.
	 * @returns {GroupCardJob}
	 */
    createJob(config) {
        /** @type {GroupCardJob} */
        const job = {
            id: crypto.randomUUID(),
            status: 'pending',
            config: config && typeof config === 'object' ? config : {},
            progress: {},
            results: {},
            error: null,
            createdAt: Date.now(),
            sseClients: new Set(),
            abortController: new AbortController(),
            eventCounter: 0,
            eventLog: [],
        };

        this.jobs.set(job.id, job);
        setImmediate(() => this.runJob(job.id));
        return job;
    }

    /**
	 * Gets a job by ID.
	 * @param {string} id Job ID.
	 * @returns {GroupCardJob|null}
	 */
    getJob(id) {
        return this.jobs.get(id) ?? null;
    }

    /**
	 * Cancels a running or pending job.
	 * @param {string} id Job ID.
	 * @returns {boolean}
	 */
    cancelJob(id) {
        const job = this.getJob(id);
        if (!job) {
            return false;
        }

        if (TERMINAL_STATUSES.has(job.status)) {
            return true;
        }

        job.status = 'cancelled';
        job.abortController?.abort();
        this.emitEvent(id, 'job_failed', { error: 'Job cancelled.' });
        // Defer close to allow SSE event to flush to clients
        setTimeout(() => this.closeSseClients(job), 50);
        return true;
    }

    /**
	 * Adds an SSE client and replays missed events.
	 * @param {string} id Job ID.
	 * @param {import('express').Response} response Express response.
	 * @param {number} [lastEventId=0] Last received SSE event ID.
	 * @returns {boolean}
	 */
    addSseClient(id, response, lastEventId = 0) {
        const job = this.getJob(id);
        if (!job) {
            return false;
        }

        for (const event of job.eventLog) {
            if (event.id > lastEventId) {
                this.writeSseEvent(response, event.id, event.eventType, event.data);
            }
        }

        if (TERMINAL_STATUSES.has(job.status)) {
            response.flush?.();
            setImmediate(() => this.closeSseClient(response));
            return true;
        }

        job.sseClients.add(response);

        response.on('close', () => {
            job.sseClients.delete(response);
        });

        return true;
    }

    /**
	 * Emits an SSE event to all connected clients and stores it for reconnect replay.
	 * @param {string} jobId Job ID.
	 * @param {string} eventType SSE event type.
	 * @param {object} [data={}] Event payload.
	 */
    emitEvent(jobId, eventType, data = {}) {
        const job = this.getJob(jobId);
        if (!job) {
            return;
        }

        const event = {
            id: ++job.eventCounter,
            eventType,
            data: data && typeof data === 'object' ? data : {},
        };
        job.eventLog.push(event);

        for (const client of [...job.sseClients]) {
            this.writeSseEvent(client, event.id, event.eventType, event.data);
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
                generatedDescription = validateGeneratedGroupCardDescription(
                    postMergeOutput,
                    0,
                );
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
            job.results = result;
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
            createLorebook: Boolean(config.createLorebook),
            cropStrategy: config.cropStrategy,
            cropPadding: config.cropPadding,
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
        switch (config.processingMode) {
            case 'parallel':
                return this.generateIndividualMode(job, config, config.concurrency);
            case 'serial':
                return this.generateIndividualMode(job, config, 1);
            case 'combined':
            default:
                return this.generateCombinedMode(job, config);
        }
    }

    /**
	 * @param {GroupCardJob} job Job object.
	 * @param {object} config Validated config.
	 * @returns {Promise<string>} Generated description.
	 */
    async generateCombinedMode(job, config) {
        job.progress = { step: 'merge' };
        this.emitEvent(job.id, 'merge_started', { mode: 'combined' });

        const output = await withRetries(
            () =>
                callLlmApi(
                    config.llm,
                    buildCombinePrompt(config.prompt, config.characters, config.fields),
                    job.abortController?.signal,
                ),
            job.abortController?.signal,
        );
        const validatedOutput = validateGeneratedGroupCardDescription(
            output,
            config.characters.length,
        );

        this.emitEvent(job.id, 'merge_completed', { output: validatedOutput });
        return validatedOutput;
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

        this.emitEvent(job.id, 'merge_started', {
            mode: concurrency === 1 ? 'serial' : 'parallel',
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
                const output = await withRetries(
                    () =>
                        callLlmApi(
                            config.llm,
                            buildCombinePrompt(charPrompt, [character], config.fields),
                            signal,
                        ),
                    signal,
                );
                const validatedOutput = validateGeneratedGroupCardDescription(
                    output,
                    1,
                );
                this.emitEvent(job.id, 'character_completed', {
                    index,
                    name,
                    output: validatedOutput,
                });
                return { ok: true, output: validatedOutput };
            } catch (error) {
                const message = error?.message ?? String(error);
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
        await generateVoronoiComposite(avatarPaths, tempAvatarPath, {
            cropStrategy: config.cropStrategy,
            cropPadding: config.cropPadding,
        });
        this.emitEvent(job.id, 'avatar_completed', {});
        throwIfAborted(signal);

        const internalName = getUniqueCharacterInternalName(
            config.groupName,
            config.directories,
        );
        const avatarName = `${internalName}.png`;
        const characterPath = path.join(config.directories.characters, avatarName);
        const worldName = config.createLorebook ? config.groupName : '';
        const characterData = createCharacterData(
            config,
            generatedDescription,
            avatarName,
            worldName,
        );
        const avatarBuffer = fs.readFileSync(tempAvatarPath);
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
            writeFileAtomicSync(
                lorebookPath,
                JSON.stringify(
                    buildLorebookData(config.characters, config.fields),
                    null,
                    4,
                ),
            );
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

    /**
	 * Removes expired jobs and closes lingering SSE connections.
	 */
    cleanup() {
        const now = Date.now();

        for (const [id, job] of this.jobs.entries()) {
            if (now - job.createdAt <= this.ttlMs) {
                continue;
            }

            job.abortController?.abort();
            this.closeSseClients(job);
            this.jobs.delete(id);
        }
    }

    /**
	 * Closes all jobs and stops cleanup timer.
	 */
    shutdown() {
        clearInterval(this.cleanupTimer);

        for (const job of this.jobs.values()) {
            job.abortController?.abort();
            this.closeSseClients(job);
        }

        this.jobs.clear();
    }

    /**
	 * @param {GroupCardJob} job Job object.
	 */
    closeSseClients(job) {
        for (const client of [...job.sseClients]) {
            this.closeSseClient(client);
        }
        job.sseClients.clear();
    }

    /**
	 * @param {import('express').Response} response Express response.
	 */
    closeSseClient(response) {
        try {
            if (!response.writableEnded) {
                response.end();
            }
        } catch (error) {
            console.debug('Failed to close group card job SSE client:', error);
        }
    }

    /**
	 * @param {import('express').Response} response Express response.
	 * @param {number} id Event ID.
	 * @param {string} eventType Event type.
	 * @param {object} data Event payload.
	 */
    writeSseEvent(response, id, eventType, data) {
        if (response.writableEnded) {
            return;
        }

        response.write(`id: ${id}\n`);
        response.write(`event: ${eventType}\n`);
        if (TERMINAL_EVENT_TYPES.has(eventType)) {
            response.write(`retry: ${TERMINAL_SSE_RETRY_MS}\n`);
        }
        response.write(`data: ${JSON.stringify(data)}\n\n`);
        response.flush?.();
    }

    /**
	 * Creates a safe public view of a job.
	 * @param {GroupCardJob} job Job object.
	 * @returns {{id:string,status:string,progress:object,results:object,error:string|null}}
	 */
    serializeJob(job) {
        return {
            id: job.id,
            status: job.status,
            progress: job.progress,
            results: job.results,
            error: job.error,
        };
    }
}

export const groupCardJobManager = new GroupCardJobManager();

process.once('SIGINT', () => groupCardJobManager.shutdown());
process.once('SIGTERM', () => groupCardJobManager.shutdown());
