'use strict';

/**
 * @file Resolves a Bulk Combine task's connection/preset/override settings
 * into the `completionSettings` body sent to the durable task run routes
 * (`run*`, `assist`). The backend sanitizes this body (stripping anything
 * that looks like a secret, allowlisting `secret_id`) and checkpoints it to
 * `task.completion`; the task runner then spreads it into the
 * `/api/backends/chat-completions/generate` request body.
 *
 * Precedence (highest first), mirroring the SPEC and
 * `ConnectionManagerRequestService.sendRequest`:
 *
 *   1. Connection Profile (`task.settings.connectionProfile`, a profile id):
 *      model, chat source (via `CONNECT_API_MAP`), `secret_id`, `custom_url`.
 *      Only chat-completion-capable profiles (apiMap `selected === 'openai'`)
 *      participate; text-generation profiles fall through to the preset.
 *   2. Chat Completion preset (`task.settings.preset`, a preset name):
 *      source, per-source model (`<source>_model`, with the
 *      `makersuite → google_model` exception), context/output windows, and
 *      sampling parameters.
 *   3. Explicit task overrides (`totalContextTokens`, `outputTokens`):
 *      blank/0 means "inherit from the preset".
 *
 * Defensive by contract: a missing layer falls through to the next one,
 * unresolvable keys are omitted, and plaintext secrets / proxy passwords /
 * profile-carried reverse-proxy settings are NEVER emitted (the object is
 * built key-by-key from an allowlist, so nothing leaks by accident). Proxy
 * support mirrors the Connection Manager: the profile's `proxy` field names
 * a proxy PRESET whose `url` is emitted as `reverse_proxy`. The preset's
 * `password` is deliberately NOT emitted — the backend sanitizer strips
 * `/password/` keys (`src/endpoints/bulk-combine.js`) before checkpointing,
 * so a plaintext proxy password could never reach the executor anyway.
 * `stream` is always pinned to `false` — task runs are not streamed.
 */

import { extension_settings } from '../../extensions.js';
import { openai_setting_names, openai_settings, proxies } from '../../openai.js';

/**
 * Fallback api map used when the caller does not inject `CONNECT_API_MAP`
 * (e.g. unit tests, or a page that runs before slash commands populate it).
 * Shaped like the real map: `{ selected, source }` per alias.
 *
 * @type {Readonly<Record<string, {selected: string, source: string}>>}
 */
const DEFAULT_API_MAP = Object.freeze({
    oai: Object.freeze({ selected: 'openai', source: 'openai' }),
    openai: Object.freeze({ selected: 'openai', source: 'openai' }),
    google: Object.freeze({ selected: 'openai', source: 'makersuite' }),
});

/**
 * Sampling keys copied verbatim from a resolved Chat Completion preset.
 * Same key name on both sides of the mapping. This is the full generation
 * set the chat-completions executor honors (`src/endpoints/backends/
 * chat-completions.js` reads each from the request body); `seed` is handled
 * separately because ST's "unset" sentinel (-1) must not be forwarded.
 *
 * @type {ReadonlyArray<string>}
 */
const SAMPLING_KEYS = Object.freeze([
    'temperature',
    'frequency_penalty',
    'presence_penalty',
    'top_p',
    'top_k',
    'top_a',
    'min_p',
    'repetition_penalty',
]);

/**
 * Profile endpoint fields mirrored from `ConnectionManagerRequestService
 * .sendRequest` (public/scripts/extensions/shared.js): every chat-completion
 * profile carries its `api-url` into all provider-specific endpoint slots;
 * the executor uses only the slot matching the resolved source.
 *
 * @type {ReadonlyArray<string>}
 */
const PROFILE_ENDPOINT_KEYS = Object.freeze([
    'custom_url',
    'vertexai_region',
    'zai_endpoint',
    'siliconflow_endpoint',
    'minimax_endpoint',
    'pollinations_endpoint',
]);

/**
 * Resolves a connection-profile `api` alias to its chat-completion map
 * entry. Unknown aliases pass through as a raw chat-completion source
 * (matching the leniency of the slash-command map, which keys every source
 * plus aliases). Returns null for blank input.
 *
 * @param {unknown} api Profile `api` field (alias or source key).
 * @param {Record<string, {selected: string, source: string}>} [apiMap] Map to consult (defaults to the small built-in alias table).
 * @returns {{selected: string, source: string}|null} Resolved entry, or null.
 */
export function resolveApiEntry(api, apiMap) {
    if (typeof api !== 'string' || !api.trim()) {
        return null;
    }
    const map = apiMap && typeof apiMap === 'object' ? apiMap : DEFAULT_API_MAP;
    const entry = map[api];
    if (entry && typeof entry === 'object') {
        return entry;
    }
    // Raw passthrough: treat the alias as an already-resolved CC source.
    return { selected: 'openai', source: api };
}

/**
 * Returns the value when it is a non-empty string, else null.
 *
 * @param {unknown} value Candidate.
 * @returns {string|null} Trimmed non-empty string, or null.
 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Returns the value as a positive truncated integer, else null. Blank, 0,
 * negative, and non-numeric input all mean "not set" (inherit).
 *
 * @param {unknown} value Candidate.
 * @returns {number|null} Positive integer, or null.
 */
function positiveInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
}

/**
 * Returns the value as a finite number, else null.
 *
 * @param {unknown} value Candidate.
 * @returns {number|null} Finite number, or null.
 */
function finiteNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

/**
 * Finds the connection profile for `task.settings.connectionProfile`.
 *
 * @param {string|null} id Profile id (null/blank → no profile).
 * @param {unknown} profiles Profile records (`ConnectionProfile[]`).
 * @returns {object|null} Matching profile, or null.
 */
function resolveProfile(id, profiles) {
    if (!id || !Array.isArray(profiles)) {
        return null;
    }
    return profiles.find((profile) => profile?.id === id) ?? null;
}

/**
 * Finds the Chat Completion preset body for `task.settings.preset` (a preset
 * NAME). Accepts a `{ name → body }` record or the raw `openai_settings`
 * array (indexed via `openai_setting_names`).
 *
 * @param {string|null} name Preset name (null/blank → no preset).
 * @param {unknown} presets Record of preset bodies, or the preset array.
 * @param {unknown} presetNames `{ name → index }` map for array form.
 * @returns {object|null} Preset body, or null.
 */
function resolvePreset(name, presets, presetNames) {
    if (!name) {
        return null;
    }
    if (Array.isArray(presets)) {
        const index = presetNames && typeof presetNames === 'object' ? presetNames[name] : undefined;
        if (Number.isSafeInteger(index)) {
            return presets[index] ?? null;
        }
        return presets.find((preset) => preset?.name === name) ?? null;
    }
    if (presets && typeof presets === 'object') {
        return presets[name] ?? null;
    }
    return null;
}

/**
 * Reads the injected or live connection-profile list.
 *
 * @param {object} deps Injected dependencies.
 * @returns {object[]} Profile records.
 */
function profileList(deps) {
    if (Array.isArray(deps?.profiles)) {
        return deps.profiles;
    }
    const profiles = extension_settings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

/**
 * Reads the injected or live proxy-preset list (`{ name, url, password }`,
 * same shape as `proxies` in openai.js). Tolerates the live export being
 * unloaded (unit tests, early boot).
 *
 * @param {object} deps Injected dependencies.
 * @returns {object[]} Proxy preset records.
 */
function proxyList(deps) {
    if (Array.isArray(deps?.proxies)) {
        return deps.proxies;
    }
    return Array.isArray(proxies) ? proxies : [];
}

/**
 * Resolves a task's completion settings into a sanitized generate body.
 * Pure and total: never throws, never returns secret material, and always
 * includes `stream: false`.
 *
 * @param {object} [task] Bulk Combine task (`{ settings }`).
 * @param {object} [deps] Injectable dependencies (tests).
 * @param {object[]} [deps.profiles] Connection profiles (defaults to `extension_settings.connectionManager?.profiles`).
 * @param {object|object[]} [deps.presets] Preset bodies as `{ name → body }` or array (defaults to `openai_settings`).
 * @param {Record<string, number>} [deps.presetNames] `{ name → index }` map (defaults to `openai_setting_names`).
 * @param {Record<string, {selected: string, source: string}>} [deps.apiMap] Api alias map (page passes `CONNECT_API_MAP`).
 * @returns {object} Sanitized completion settings (only resolvable keys + `stream: false`).
 */
export function resolveCompletionSettings(task, deps = {}) {
    const settings = task?.settings && typeof task.settings === 'object' ? task.settings : {};
    const profiles = profileList(deps);
    const presets = deps?.presets ?? openai_settings;
    const presetNames = deps?.presetNames ?? openai_setting_names;
    const apiMap = deps?.apiMap ?? DEFAULT_API_MAP;

    const result = { stream: false };

    // --- Layer 1: Connection Profile (chat-completion-capable only). ---
    const profile = resolveProfile(nonEmptyString(settings.connectionProfile), profiles);
    let profileSource = null;
    if (profile) {
        const entry = resolveApiEntry(profile.api, apiMap);
        if (entry?.selected === 'openai') {
            profileSource = nonEmptyString(entry.source);
        }
    }
    const profileActive = profile !== null && profileSource !== null;

    // --- Layer 2: Chat Completion preset (by name). ---
    const preset = resolvePreset(nonEmptyString(settings.preset), presets, presetNames);

    // Source: profile (via api map) → preset.
    const source = profileSource ?? nonEmptyString(preset?.chat_completion_source);
    if (source) {
        result.chat_completion_source = source;
    }

    // Model (required by the runner's preflight): profile.model → preset
    // `<source>_model`, with the makersuite → google_model exception.
    const profileModel = profileActive ? nonEmptyString(profile.model) : null;
    let presetModel = null;
    if (source && preset) {
        const modelKey = source === 'makersuite' ? 'google_model' : `${source}_model`;
        presetModel = nonEmptyString(preset[modelKey]);
    }
    const model = profileModel ?? presetModel;
    if (model) {
        result.model = model;
    }

    // --- Layer 3: explicit task windows override the preset windows. ---
    // (blank/0 means "inherit"; the key names are max_tokens/max_context —
    // the task runner spreads this body verbatim, so amount_gen is wrong.)
    const maxTokens = positiveInteger(settings.outputTokens) ?? positiveInteger(preset?.openai_max_tokens);
    if (maxTokens !== null) {
        result.max_tokens = maxTokens;
    }
    const maxContext = positiveInteger(settings.totalContextTokens) ?? positiveInteger(preset?.openai_max_context);
    if (maxContext !== null) {
        result.max_context = maxContext;
    }

    // Sampling parameters come from the preset layer only (profiles carry no
    // sampling settings of their own here).
    if (preset) {
        for (const key of SAMPLING_KEYS) {
            const value = finiteNumber(preset[key]);
            if (value !== null) {
                result[key] = value;
            }
        }
        // Seed: ST's sentinel for "unset" is -1; only forward real seeds.
        const seed = finiteNumber(preset.seed);
        if (seed !== null && seed >= 0) {
            result.seed = Math.trunc(seed);
        }
        const reasoningPrefill = nonEmptyString(preset.reasoning_prefill);
        if (reasoningPrefill !== null) {
            result.reasoning_prefill = reasoningPrefill;
        }
    }

    // Profile transport, mirroring `ConnectionManagerRequestService
    // .sendRequest` (chat-completion branch): the secret REFERENCE, all
    // provider endpoint slots (fed from the profile's `api-url`), the named
    // proxy preset's URL, and the prompt post-processing mode. NEVER
    // plaintext keys or proxy passwords (the backend sanitizer would strip
    // those before checkpointing anyway).
    if (profileActive) {
        const secretId = nonEmptyString(profile['secret-id']);
        if (secretId) {
            result.secret_id = secretId;
        }
        const apiUrl = nonEmptyString(profile['api-url']);
        if (apiUrl) {
            for (const key of PROFILE_ENDPOINT_KEYS) {
                result[key] = apiUrl;
            }
        }
        const proxyName = nonEmptyString(profile.proxy);
        const proxyPreset = proxyName
            ? proxyList(deps).find((candidate) => candidate?.name === proxyName)
            : null;
        const reverseProxy = nonEmptyString(proxyPreset?.url);
        if (reverseProxy) {
            result.reverse_proxy = reverseProxy;
        }
        const postProcessing = nonEmptyString(profile['prompt-post-processing']);
        if (postProcessing) {
            result.custom_prompt_post_processing = postProcessing;
        }
    }

    return result;
}

/**
 * Maps resolved completion settings back onto the task SETTINGS keys the
 * server preflight reads (`task.settings.outputTokens` /
 * `task.settings.totalContextTokens`, src/util/bulk-combine/task-runner.js).
 *
 * The resolver already applies the "blank/0 means inherit the preset"
 * contract, so `max_tokens`/`max_context` in the resolved body ARE the
 * effective windows the generation runs with — persisting them keeps the
 * preflight context-overflow block in lockstep with the actual generation
 * windows instead of silently running unguarded on preset-inherited values.
 *
 * @param {unknown} completionSettings Resolved body from {@link resolveCompletionSettings}.
 * @returns {{outputTokens?: number, totalContextTokens?: number}|null} Sparse settings patch, or null when nothing is resolvable.
 */
export function windowSettingsPatchFromCompletion(completionSettings) {
    if (!completionSettings || typeof completionSettings !== 'object') {
        return null;
    }
    const patch = {};
    const outputTokens = positiveInteger(completionSettings.max_tokens);
    if (outputTokens !== null) {
        patch.outputTokens = outputTokens;
    }
    const totalContextTokens = positiveInteger(completionSettings.max_context);
    if (totalContextTokens !== null) {
        patch.totalContextTokens = totalContextTokens;
    }
    return Object.keys(patch).length > 0 ? patch : null;
}

/** Marker preventing double-decoration of the same client. */
const WINDOW_PERSISTENCE_MARKER = Symbol('resolvedWindowPersistence');

/**
 * Decorates a TaskClient so every pass run first persists the resolved
 * token windows to `task.settings` via the client's own `patchTask` (the
 * existing update mechanism). Without this, workflows that inherit their
 * windows from the preset leave `task.settings.outputTokens` /
 * `totalContextTokens` null, and the server preflight runs with NO
 * context-overflow block — violating "block, never silently truncate".
 *
 * The persist fails closed: when the PATCH rejects, the run is aborted
 * rather than executed without a guard. Idempotent per client instance.
 *
 * @param {import('./TaskClient.js').TaskClient} client Task client to decorate.
 * @returns {import('./TaskClient.js').TaskClient} The same client, decorated.
 */
export function withResolvedWindowPersistence(client) {
    if (
        !client ||
        typeof client.runPass !== 'function' ||
        typeof client.patchTask !== 'function' ||
        client.runPass[WINDOW_PERSISTENCE_MARKER]
    ) {
        return client;
    }
    const innerRunPass = client.runPass.bind(client);
    const decoratedRunPass = async (id, passKey, options = {}) => {
        const patch = windowSettingsPatchFromCompletion(options?.completionSettings);
        if (patch) {
            await client.patchTask(id, { settings: patch });
        }
        return innerRunPass(id, passKey, options);
    };
    decoratedRunPass[WINDOW_PERSISTENCE_MARKER] = true;
    // Own-property shadow: keeps the instance (and its private fields)
    // intact, unlike a prototype clone.
    client.runPass = decoratedRunPass;
    return client;
}
