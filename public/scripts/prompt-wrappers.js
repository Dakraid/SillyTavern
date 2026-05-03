'use strict';

export const PROMPT_WRAPPER_VERSION = 1;

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
 * Applies or removes a persistent wrapper around a message text slot.
 * @param {object} params Params.
 * @param {string} params.text Current slot text.
 * @param {object?} params.extra Message or swipe info extra object.
 * @param {'assistant'|'user'} params.role Wrapper role.
 * @param {string} params.tag Raw tag name.
 * @param {boolean} params.enabled Whether wrapper should be enabled.
 * @returns {{text: string, extra: object, changed: boolean}}
 */
export function applyPromptWrapperToText({ text, extra = {}, role, tag, enabled }) {
    const normalizedTag = normalizePromptWrapperTag(tag);
    const nextExtra = extra && typeof extra === 'object' ? structuredClone(extra) : {};
    const metadata = nextExtra.prompt_wrapper;
    let nextText;

    if (enabled) {
        const base = typeof metadata?.base_mes === 'string'
            ? metadata.base_mes
            : stripPromptWrapperTags(text, normalizedTag);
        const wrapped = wrapPromptWrapperText(text, normalizedTag, base);
        nextText = wrapped.mes;
        nextExtra.prompt_wrapper = {
            role,
            tag: normalizedTag,
            base_mes: wrapped.base_mes,
            version: PROMPT_WRAPPER_VERSION,
        };
    } else {
        nextText = unwrapPromptWrapperText(text, normalizedTag, metadata);
        delete nextExtra.prompt_wrapper;
    }

    return {
        text: nextText,
        extra: nextExtra,
        changed: nextText !== String(text ?? '') || JSON.stringify(nextExtra.prompt_wrapper ?? null) !== JSON.stringify(metadata ?? null),
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
