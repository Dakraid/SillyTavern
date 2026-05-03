'use strict';

export const PROMPT_WRAPPER_VERSION = 1;
export const PROMPT_WRAPPER_ROLE_ASSISTANT = 'assistant';
export const PROMPT_WRAPPER_ROLE_USER = 'user';

/**
 * Gets or creates persisted wrapper settings.
 * @param {Record<string, any>} extensionSettings SillyTavern extension_settings object.
 * @returns {{assistant: boolean, user: boolean, chara: Record<string, string>}}
 */
export function getPromptWrapperSettings(extensionSettings) {
    extensionSettings.wrappers ??= {};
    const settings = extensionSettings.wrappers;
    settings.assistant = !!settings.assistant;
    settings.user = !!settings.user;
    settings.chara = settings.chara && typeof settings.chara === 'object' && !Array.isArray(settings.chara) ? settings.chara : {};
    return settings;
}

/**
 * Gets or creates active-chat wrapper settings, seeded once from legacy globals.
 * @param {Record<string, any>} chatMetadata Active chat metadata object.
 * @param {Record<string, any>} extensionSettings SillyTavern extension_settings object.
 * @returns {{assistant: boolean, user: boolean}}
 */
export function getChatPromptWrapperSettings(chatMetadata, extensionSettings) {
    const legacySettings = getPromptWrapperSettings(extensionSettings);
    const fallback = { assistant: legacySettings.assistant, user: legacySettings.user };

    if (!chatMetadata || typeof chatMetadata !== 'object' || Array.isArray(chatMetadata)) {
        return fallback;
    }

    if (!chatMetadata.prompt_wrappers || typeof chatMetadata.prompt_wrappers !== 'object' || Array.isArray(chatMetadata.prompt_wrappers)) {
        chatMetadata.prompt_wrappers = { ...fallback };
        return chatMetadata.prompt_wrappers;
    }

    const settings = chatMetadata.prompt_wrappers;
    settings.assistant = typeof settings.assistant === 'boolean' ? settings.assistant : fallback.assistant;
    settings.user = typeof settings.user === 'boolean' ? settings.user : fallback.user;
    delete settings.chara;
    return settings;
}

/**
 * Escapes only characters that would break tag boundaries.
 * @param {string} tag Tag name.
 * @returns {string}
 */
export function normalizePromptWrapperTag(tag) {
    const normalized = String(tag ?? '').trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    return normalized || 'Unknown';
}

/**
 * @param {string} text Text to test.
 * @param {string} tag Normalized tag name.
 * @returns {RegExpMatchArray|null}
 */
function matchOpeningTag(text, tag) {
    return String(text ?? '').match(new RegExp(`^\\s*<${escapeRegExp(tag)}>`, 'u'));
}

/**
 * @param {string} text Text to test.
 * @param {string} tag Normalized tag name.
 * @returns {RegExpMatchArray|null}
 */
function matchClosingTag(text, tag) {
    return String(text ?? '').match(new RegExp(`</${escapeRegExp(tag)}>\\s*$`, 'u'));
}

/**
 * @param {string} text Text to escape for RegExp.
 * @returns {string}
 */
function escapeRegExp(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Removes repeated same outer tags from the start/end of a string.
 * @param {string} text Message text.
 * @param {string} tag Raw or normalized tag name.
 * @returns {string}
 */
export function stripPromptWrapperTags(text, tag) {
    const normalizedTag = normalizePromptWrapperTag(tag);
    let result = String(text ?? '');
    let changed = true;

    while (changed) {
        changed = false;
        const opening = matchOpeningTag(result, normalizedTag);
        if (opening) {
            result = result.slice(opening[0].length);
            changed = true;
        }

        const closing = matchClosingTag(result, normalizedTag);
        if (closing) {
            result = result.slice(0, result.length - closing[0].length);
            changed = true;
        }
    }

    return result;
}

/**
 * Wraps text with exactly one normalized outer tag pair.
 * @param {string} text Message text.
 * @param {string} tag Raw tag name.
 * @param {string?} baseOverride Optional exact base content.
 * @returns {{mes: string, base_mes: string, tag: string}}
 */
export function wrapPromptWrapperText(text, tag, baseOverride = null) {
    const normalizedTag = normalizePromptWrapperTag(tag);
    const base = typeof baseOverride === 'string' ? baseOverride : stripPromptWrapperTags(text, normalizedTag);
    return {
        mes: `<${normalizedTag}>${base}</${normalizedTag}>`,
        base_mes: base,
        tag: normalizedTag,
    };
}

/**
 * @param {string} text Message text.
 * @param {string} tag Raw tag name.
 * @param {object?} metadata Existing prompt wrapper metadata.
 * @returns {string}
 */
export function unwrapPromptWrapperText(text, tag, metadata = null) {
    if (typeof metadata?.base_mes === 'string') {
        return metadata.base_mes;
    }

    return stripPromptWrapperTags(text, tag);
}

/**
 * Resolves the wrapper role for a normal chat message.
 * @param {Record<string, any>} message Chat message-like object.
 * @returns {'assistant'|'user'|null} Wrapper role, or null for system/narrator/small-system/invalid messages.
 */
export function getPromptWrapperRole(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.is_system || message.extra?.isSmallSys || message.extra?.type === 'narrator') return null;
    return message.is_user ? PROMPT_WRAPPER_ROLE_USER : PROMPT_WRAPPER_ROLE_ASSISTANT;
}

/**
 * Creates a normalized wrapper state object.
 * @param {object} params Params.
 * @param {boolean} params.enabled Whether this role is enabled.
 * @param {string} params.tag Raw tag name.
 * @returns {{enabled: boolean, tag: string}}
 */
export function resolvePromptWrapperState({ enabled, tag }) {
    return { enabled: !!enabled, tag: normalizePromptWrapperTag(tag) };
}

/**
 * Ephemerally wraps prompt content without mutating source chat data.
 * @param {string} content Raw prompt content.
 * @param {{enabled: boolean, tag: string}|null} state Wrapper state.
 * @returns {string} Wrapped content when enabled, otherwise raw content.
 */
export function wrapPromptWrapperContent(content, state) {
    const text = String(content ?? '');
    if (!state?.enabled) return text;
    return wrapPromptWrapperText(text, state.tag).mes;
}

/**
 * Builds display-only XML tag parts for rendering around formatted message content.
 * @param {{enabled: boolean, tag: string}|null} state Wrapper state.
 * @returns {{enabled: boolean, tag: string, opening: string, closing: string}|null} Display parts or null when disabled.
 */
export function getPromptWrapperDisplayParts(state) {
    if (!state?.enabled) return null;
    const tag = normalizePromptWrapperTag(state.tag);
    return {
        enabled: true,
        tag,
        opening: `<${tag}>`,
        closing: `</${tag}>`,
    };
}

/**
 * Removes legacy persisted wrapper metadata from a text slot without touching unmetadataed XML text.
 * @param {string} text Current slot text.
 * @param {object?} extra Message or swipe extra metadata.
 * @returns {{text: string, extra: object, changed: boolean}} Cleaned slot state.
 */
export function cleanupPersistedPromptWrapperSlot(text, extra = {}) {
    const nextExtra = extra && typeof extra === 'object' ? structuredClone(extra) : {};
    const metadata = nextExtra.prompt_wrapper;
    if (!metadata || typeof metadata !== 'object') {
        return { text: String(text ?? ''), extra: nextExtra, changed: false };
    }

    const tag = normalizePromptWrapperTag(metadata.tag || 'Unknown');
    const nextText = typeof metadata.base_mes === 'string'
        ? metadata.base_mes
        : stripPromptWrapperTags(text, tag);
    delete nextExtra.prompt_wrapper;

    return {
        text: nextText,
        extra: nextExtra,
        changed: true,
    };
}

/**
 * Calculates bulk order values for visible prompt order.
 * @param {number} count Number of prompts.
 * @param {number} start Starting order.
 * @param {'first-inc'|'first-dec'|'last-inc'|'last-dec'} mode Renumber mode.
 * @returns {number[]}
 */
export function calculatePromptOrderRenumber(count, start, mode) {
    const total = Math.max(0, Number(count) || 0);
    const initial = Number(start);
    if (!Number.isInteger(initial) || initial < 0) {
        throw new Error('Order must be a non-negative integer');
    }

    const values = Array(total).fill(0);
    const fromLast = mode.startsWith('last');
    const delta = mode.endsWith('dec') ? -1 : 1;

    for (let step = 0; step < total; step++) {
        const index = fromLast ? total - 1 - step : step;
        values[index] = initial + (step * delta);
    }

    if (values.some(value => value < 0)) {
        throw new Error('Renumbering would create a negative order');
    }

    return values;
}

/**
 * Builds identifier-keyed updates for a bulk prompt manager operation.
 * @param {Array<Record<string, any>>} prompts Visible prompts to update.
 * @param {{operation: string, value: number, mode: string}} params Operation params.
 * @param {{relative: number, inChat: number}} [positions] Injection position values.
 * @returns {Array<Record<string, any>>} Partial prompt updates with identifiers.
 */
export function createPromptBulkUpdates(prompts, params, positions = { relative: 0, inChat: 1 }) {
    const updates = prompts
        .filter(prompt => prompt?.identifier)
        .map(prompt => ({ identifier: prompt.identifier }));

    switch (params.operation) {
        case 'position-relative':
            updates.forEach(update => update.injection_position = positions.relative);
            break;
        case 'position-inchat':
            updates.forEach(update => update.injection_position = positions.inChat);
            break;
        case 'depth':
            updates.forEach(update => update.injection_depth = params.value);
            break;
        case 'order':
            updates.forEach(update => update.injection_order = params.value);
            break;
        case 'renumber': {
            const values = calculatePromptOrderRenumber(updates.length, params.value, params.mode);
            updates.forEach((update, index) => update.injection_order = values[index]);
            break;
        }
    }

    return updates;
}

/**
 * Applies a bulk prompt manager operation to prompt-like objects in place.
 * @param {Array<Record<string, any>>} prompts Visible prompts to mutate.
 * @param {{operation: string, value: number, mode: string}} params Operation params.
 * @param {{relative: number, inChat: number}} [positions] Injection position values.
 * @returns {Array<Record<string, any>>} The mutated prompt array.
 */
export function applyPromptBulkOperation(prompts, params, positions = { relative: 0, inChat: 1 }) {
    const updatesById = new Map(createPromptBulkUpdates(prompts, params, positions).map(update => [update.identifier, update]));
    prompts.forEach(prompt => {
        const update = updatesById.get(prompt?.identifier);
        if (update) Object.assign(prompt, update);
    });

    return prompts;
}
