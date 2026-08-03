import fs from 'node:fs';
import path from 'node:path';

import {
    CHAT_COMPLETION_SOURCES,
    TEXTGEN_TYPES,
} from '../constants.js';

const LLM_TIMEOUT_MS = 2 * 60 * 1000;

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
        } else if (settings.pres_pen != null) {
            body.presence_penalty = Number(settings.pres_pen);
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
