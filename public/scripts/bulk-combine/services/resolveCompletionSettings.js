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
 * reverse-proxy settings are NEVER emitted (the object is built key-by-key
 * from an allowlist, so nothing leaks by accident). `stream` is always
 * pinned to `false` — task runs are not streamed.
 */

import { extension_settings } from '../../extensions.js';
import { openai_setting_names, openai_settings } from '../../openai.js';

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
 * Same key name on both sides of the mapping.
 *
 * @type {ReadonlyArray<string>}
 */
const SAMPLING_KEYS = Object.freeze([
    'temperature',
    'frequency_penalty',
    'presence_penalty',
    'top_p',
    'top_k',
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
    }

    // Profile transport: only the secret REFERENCE and custom URL — never
    // plaintext keys, proxy passwords, or reverse-proxy settings.
    if (profileActive) {
        const secretId = nonEmptyString(profile['secret-id']);
        if (secretId) {
            result.secret_id = secretId;
        }
        const customUrl = nonEmptyString(profile['api-url']);
        if (customUrl) {
            result.custom_url = customUrl;
        }
    }

    return result;
}
