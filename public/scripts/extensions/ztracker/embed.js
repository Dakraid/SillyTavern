/**
 * Native zTracker prompt snapshot embedding helpers.
 *
 * This module intentionally does not import from the third-party zTracker extension.
 * It ports only the prompt embedding contract: format stored per-message tracker state
 * and inject recent snapshots into the generation chat array via
 * globalThis.ztrackerGenerateInterceptor.
 */

export const EXTENSION_KEY = 'zTracker';
export const CHAT_MESSAGE_SCHEMA_VALUE_KEY = 'value';
export const DEFAULT_EMBED_SNAPSHOT_HEADER = 'Tracker:';

const DEFAULT_SETTINGS = Object.freeze({
    includeLastXZTrackerMessages: 1,
    embedZTrackerRole: 'user',
    embedZTrackerAsCharacter: false,
    embedZTrackerSnapshotHeader: DEFAULT_EMBED_SNAPSHOT_HEADER,
    embedZTrackerSnapshotTransformPreset: 'default',
    embedZTrackerSnapshotTransformPresets: Object.freeze({
        default: Object.freeze({
            input: 'pretty_json',
            codeFenceLang: 'json',
            wrapInCodeFence: true,
        }),
        minimal: Object.freeze({
            input: 'top_level_lines',
            codeFenceLang: 'text',
            wrapInCodeFence: false,
        }),
        toon: Object.freeze({
            input: 'toon',
            codeFenceLang: 'toon',
            wrapInCodeFence: true,
        }),
    }),
});

const EMBEDDED_TRACKER_SNAPSHOT_MARKER = Symbol('embeddedTrackerSnapshot');

/**
 * Check whether a value is a non-array object.
 * @param {unknown} value Value to test.
 * @returns {value is Record<string, unknown>} True if plain object-like.
 */
function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Clone JSON-compatible data, falling back to the source value on failure.
 * @template T
 * @param {T} value Value to clone.
 * @returns {T} Clone.
 */
function safeClone(value) {
    try {
        return structuredClone(value);
    } catch {
        return JSON.parse(JSON.stringify(value));
    }
}

/**
 * Convert a scalar into compact prompt text.
 * @param {unknown} value Scalar value.
 * @returns {string} Prompt text.
 */
function formatScalarMinimal(value) {
    if (value === null) {
        return 'null';
    }

    if (typeof value === 'string') {
        const needsQuote =
			value.length === 0 ||
			value.includes('"') ||
			value.includes('\n') ||
			value.startsWith(' ') ||
			value.endsWith(' ') ||
			value.startsWith('\t') ||
			value.endsWith('\t');
        return needsQuote ? JSON.stringify(value) : value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    return JSON.stringify(value);
}

/**
 * Pick a stable label for an array item in minimal text mode.
 * @param {Record<string, unknown>} item Array item.
 * @param {number} index Item index.
 * @returns {string} Label.
 */
function pickArrayItemLabel(item, index) {
    for (const candidate of [item.name, item.id, item.uid, item.key]) {
        const value = typeof candidate === 'number' ? String(candidate) : candidate;
        if (
            typeof value === 'string' &&
			value.trim().length > 0 &&
			!value.includes(']') &&
			!value.includes('\n')
        ) {
            return value;
        }
    }

    return `item${index + 1}`;
}

/**
 * Build indented minimal lines.
 * @param {unknown} value Value to format.
 * @param {string} [indent=''] Current indentation.
 * @param {boolean} [embedding=false] Whether to use embedding-friendly scalar formatting.
 * @returns {string} Formatted text.
 */
function buildMinimalLines(value, indent = '', embedding = false) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            return `${indent}(empty)\n`;
        }

        return value
            .map((item, index) => {
                if (isPlainObject(item) || Array.isArray(item)) {
                    if (embedding) {
                        const label = isPlainObject(item)
                            ? pickArrayItemLabel(item, index)
                            : `item${index + 1}`;
                        return `${indent}[${label}:\n${buildMinimalLines(item, `${indent}  `, embedding)}${indent}]\n`;
                    }

                    return `${indent}-\n${buildMinimalLines(item, `${indent}  `, embedding)}`;
                }

                const scalar = embedding
                    ? formatScalarMinimal(item)
                    : JSON.stringify(item);
                return `${indent}- ${scalar}\n`;
            })
            .join('');
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (entries.length === 0) {
            return `${indent}(empty)\n`;
        }

        return entries
            .map(([key, item]) => {
                if (isPlainObject(item) || Array.isArray(item)) {
                    return `${indent}${key}:\n${buildMinimalLines(item, `${indent}  `, embedding)}`;
                }

                const scalar = embedding
                    ? formatScalarMinimal(item)
                    : JSON.stringify(item);
                return `${indent}${key}: ${scalar}\n`;
            })
            .join('');
    }

    const scalar = embedding ? formatScalarMinimal(value) : JSON.stringify(value);
    return `${indent}${scalar}\n`;
}

/**
 * Pretty-print tracker data as JSON.
 * @param {unknown} value Tracker value.
 * @returns {string} Pretty JSON.
 */
export function toPrettyJson(value) {
    return JSON.stringify(value ?? {}, null, 2);
}

/**
 * Format tracker data as one block per top-level key.
 * @param {unknown} value Tracker value.
 * @param {object} [options] Formatting options.
 * @param {boolean} [options.embedding=false] Use embedding-friendly unquoted strings.
 * @returns {string} Top-level-line text.
 */
export function toTopLevelLines(value, { embedding = false } = {}) {
    if (!isPlainObject(value)) {
        return buildMinimalLines(value, '', embedding);
    }

    const blocks = Object.entries(value).map(([key, item]) => {
        if (isPlainObject(item) || Array.isArray(item)) {
            return `${key}:\n${buildMinimalLines(item, '  ', embedding)}`.trimEnd();
        }

        const scalar = embedding ? formatScalarMinimal(item) : JSON.stringify(item);
        return `${key}: ${scalar}`;
    });

    return `${blocks.join(embedding ? '\n' : '\n\n')}\n`;
}

/**
 * Escape a value for a tab-separated TOON cell.
 * @param {unknown} value Cell value.
 * @returns {string} Escaped cell text.
 */
function toToonCell(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (isPlainObject(value) || Array.isArray(value)) {
        return JSON.stringify(value);
    }

    return String(value).replace(/[\t\r\n]+/g, ' ');
}

/**
 * Return shared scalar keys for a homogeneous array of objects.
 * @param {unknown[]} items Array items.
 * @returns {string[] | null} Shared keys, or null when not tabular.
 */
function getTabularKeys(items) {
    if (!items.length || !items.every(isPlainObject)) {
        return null;
    }

    const keys = Object.keys(items[0]).filter((key) => {
        const value = items[0][key];
        return !isPlainObject(value) && !Array.isArray(value);
    });

    if (!keys.length) {
        return null;
    }

    const keySet = keys.join('\u0000');
    const sameShape = items.every(
        (item) =>
            Object.keys(item)
                .filter((key) => !isPlainObject(item[key]) && !Array.isArray(item[key]))
                .join('\u0000') === keySet,
    );

    return sameShape ? keys : null;
}

/**
 * Format tracker data using a small TOON-compatible tabular subset.
 * Falls back to pretty JSON when the data is not tabular.
 * @param {unknown} value Tracker value.
 * @returns {string} TOON-ish text.
 */
export function toToon(value) {
    if (Array.isArray(value)) {
        const keys = getTabularKeys(value);
        if (!keys) {
            return toPrettyJson(value);
        }

        return [
            keys.join('\t'),
            ...value.map((item) =>
                keys.map((key) => toToonCell(item[key])).join('\t'),
            ),
        ].join('\n');
    }

    if (!isPlainObject(value)) {
        return toPrettyJson(value);
    }

    const blocks = [];
    for (const [key, item] of Object.entries(value)) {
        if (Array.isArray(item)) {
            const keys = getTabularKeys(item);
            if (keys) {
                blocks.push(
                    `${key}[${keys.join(',')}]:\n${keys.join('\t')}\n${item.map((row) => keys.map((column) => toToonCell(row[column])).join('\t')).join('\n')}`,
                );
                continue;
            }
        }

        if (isPlainObject(item) || Array.isArray(item)) {
            blocks.push(`${key}: ${JSON.stringify(item)}`);
        } else {
            blocks.push(`${key}: ${toToonCell(item)}`);
        }
    }

    return blocks.length > 0 ? blocks.join('\n\n') : toPrettyJson(value);
}

/**
 * Apply an optional regex transform preset.
 * @param {string} text Base text.
 * @param {object} preset Transform preset.
 * @returns {string} Transformed or original text.
 */
function applyTransformPreset(text, preset) {
    const pattern = preset?.pattern ?? '';
    if (!String(pattern).trim()) {
        return text;
    }

    try {
        return text.replace(
            new RegExp(pattern, preset?.flags ?? ''),
            preset?.replacement ?? '',
        );
    } catch {
        return text;
    }
}

/**
 * Resolve embed transform settings from old/new zTracker settings.
 * @param {string|object|undefined} format Format argument or settings object.
 * @returns {{input:string, preset:object, presetKey:string|undefined}}
 */
function resolveFormatSettings(format) {
    if (typeof format === 'string') {
        return {
            input: format,
            preset: {},
            presetKey: undefined,
        };
    }

    const settings = { ...DEFAULT_SETTINGS, ...(format || {}) };
    const presets =
		settings.embedZTrackerSnapshotTransformPresets ||
		DEFAULT_SETTINGS.embedZTrackerSnapshotTransformPresets;
    const legacyFormat = settings.embedSnapshotFormat;
    const presetKey = settings.embedZTrackerSnapshotTransformPreset || 'default';
    const preset = (presetKey && presets[presetKey]) || presets.default || {};

    return {
        input: legacyFormat || preset.input || 'pretty_json',
        preset,
        presetKey,
    };
}

/**
 * Resolve embedded snapshot header from old/new zTracker settings.
 * @param {object} settings zTracker settings.
 * @returns {string} Snapshot header.
 */
function getEmbeddedSnapshotHeader(settings) {
    return (
        settings.embedSnapshotHeader ??
		settings.embedZTrackerSnapshotHeader ??
		DEFAULT_EMBED_SNAPSHOT_HEADER
    );
}

/**
 * Format a tracker snapshot for prompt embedding.
 *
 * When called with a string format, returns a plain string for simple consumers.
 * When called with a zTracker settings object, returns the richer old-extension
 * shape: { lang, text, wrapInCodeFence }.
 *
 * @param {unknown} trackerData Tracker value from message.extra.zTracker.value.
 * @param {'pretty_json'|'top_level_lines'|'toon'|object} [format='pretty_json'] Format or settings.
 * @param {string} [header] Optional header for string-return compatibility.
 * @returns {string|{lang:string,text:string,wrapInCodeFence:boolean}} Formatted snapshot.
 */
export function formatEmbeddedTrackerSnapshot(
    trackerData,
    format = 'pretty_json',
    header = '',
) {
    const richResult = typeof format !== 'string';
    const { input, preset, presetKey } = resolveFormatSettings(format);
    const embedding = presetKey === 'minimal';
    let text;

    switch (input) {
        case 'toon':
            text = toToon(trackerData ?? {});
            break;
        case 'top_level_lines':
            text = toTopLevelLines(trackerData, { embedding });
            break;
        case 'pretty_json':
        default:
            text = toPrettyJson(trackerData);
            break;
    }

    text = applyTransformPreset(text, preset);

    if (!richResult) {
        return header ? `${header}\n${text}` : text;
    }

    return {
        lang:
			preset.codeFenceLang ||
			(input === 'toon' ? 'toon' : input === 'pretty_json' ? 'json' : 'text'),
        text,
        wrapInCodeFence:
			typeof preset.wrapInCodeFence === 'boolean'
			    ? preset.wrapInCodeFence
			    : input !== 'top_level_lines',
    };
}

/**
 * Resolve native zTracker settings from SillyTavern context globals.
 * @returns {object} Settings object.
 */
function getNativeZTrackerSettings() {
    const context = globalThis.SillyTavern?.getContext?.();
    const contextSettings = context?.['extensionSettings'];
    const globalSettings = globalThis.extension_settings;
    return {
        ...DEFAULT_SETTINGS,
        ...(contextSettings?.[EXTENSION_KEY] || contextSettings?.zTracker || {}),
        ...(globalSettings?.[EXTENSION_KEY] || globalSettings?.zTracker || {}),
    };
}

/**
 * Resolve embedded tracker role.
 * @param {object} settings zTracker settings.
 * @param {object} options Include options.
 * @returns {'user'|'assistant'|'system'} Role.
 */
function resolveEmbeddedTrackerRole(settings, options) {
    const configuredRole = settings.embedZTrackerRole ?? 'user';
    if (
        !options.preserveTextCompletionTurnAlternation ||
		configuredRole !== 'system'
    ) {
        return configuredRole;
    }

    return 'user';
}

/**
 * Check whether message is a user turn.
 * @param {object} message Message.
 * @returns {boolean} True if user turn.
 */
function isUserConversationTurn(message) {
    return message.role === 'user' || message.is_user === true;
}

/**
 * Check whether message is an assistant turn.
 * @param {object} message Message.
 * @returns {boolean} True if assistant turn.
 */
function isAssistantConversationTurn(message) {
    if (message.role === 'assistant') {
        return true;
    }

    if (
        message.role === 'user' ||
		message.role === 'system' ||
		message.is_system === true
    ) {
        return false;
    }

    return message.is_user === false;
}

/**
 * Check whether snapshot can be inlined into a source message without breaking roles.
 * @param {object} message Message.
 * @param {'user'|'assistant'|'system'} embedRole Embed role.
 * @returns {boolean} True if inline-compatible.
 */
function canInlineEmbeddedTracker(message, embedRole) {
    if (embedRole === 'assistant') {
        return isAssistantConversationTurn(message);
    }

    if (embedRole === 'user') {
        return isUserConversationTurn(message);
    }

    return false;
}

/**
 * Get message content text.
 * @param {object} message Message.
 * @returns {string} Content.
 */
function getMessageText(message) {
    if (
        typeof message.content === 'string' &&
		message.content.trim().length > 0
    ) {
        return message.content;
    }

    if (typeof message.mes === 'string' && message.mes.trim().length > 0) {
        return message.mes;
    }

    return '';
}

/**
 * Set prompt-facing text fields on a message copy.
 * @param {object} message Message.
 * @param {string} text New content.
 */
function setMessageText(message, text) {
    if (typeof message.content === 'string' || typeof message.mes !== 'string') {
        message.content = text;
    }

    if (typeof message.mes === 'string') {
        message.mes = text;
    }
}

/**
 * Escape a string for regex construction.
 * @param {string} value Input string.
 * @returns {string} Escaped string.
 */
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalize snapshot text for exact duplicate checks.
 * @param {string} value Text.
 * @returns {string} Normalized text.
 */
function normalizeSnapshotText(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .trim();
}

/**
 * Check whether message text already contains a snapshot.
 * @param {object} message Message.
 * @param {string} content Snapshot content.
 * @returns {boolean} True when content already exists.
 */
function messageContainsSnapshot(message, content) {
    const messageText = normalizeSnapshotText(getMessageText(message));
    const snapshotText = normalizeSnapshotText(content);

    return (
        messageText === snapshotText ||
		(snapshotText.length > 0 && messageText.includes(snapshotText))
    );
}

/**
 * Replace an existing embedded tracker block in copied prompt text.
 * @param {object} message Message.
 * @param {string} content New snapshot content.
 * @param {object} settings zTracker settings.
 * @param {{wrapInCodeFence:boolean, lang?:string}} snapshotParts Snapshot formatting parts.
 * @returns {boolean} True when replaced or exact snapshot already exists.
 */
function upsertSnapshotInMessage(message, content, settings, snapshotParts) {
    if (messageContainsSnapshot(message, content)) {
        return true;
    }

    const messageText = getMessageText(message);
    const header = getEmbeddedSnapshotHeader(settings);
    const escapedHeader = escapeRegExp(header.trim());
    const pattern = snapshotParts.wrapInCodeFence
        ? new RegExp(
            '(^|\\n\\n?)' + escapedHeader + '\\s*\\n```[\\w-]*\\n[\\s\\S]*?\\n```',
        )
        : new RegExp(`(^|\\n\\n?)${escapedHeader}\\s*\\n[\\s\\S]*$`);
    const match = messageText.match(pattern);

    if (!match) {
        return false;
    }

    const separator = match[1] ?? '';
    const replacement = `${separator}${content}`;
    setMessageText(message, messageText.replace(pattern, replacement));
    return true;
}

/**
 * Check whether a message is an embedded zTracker snapshot candidate.
 * @param {object} message Message.
 * @param {object} settings zTracker settings.
 * @param {{wrapInCodeFence:boolean, lang:string}} snapshotParts Snapshot formatting parts.
 * @returns {boolean} True when message looks like an embedded snapshot.
 */
function isEmbeddedSnapshotCandidate(message, settings, snapshotParts) {
    if (message?.[EMBEDDED_TRACKER_SNAPSHOT_MARKER]) {
        return true;
    }

    if (message?.extra?.zTrackerEmbeddedSnapshot) {
        return true;
    }

    if (getMessageExtra(message)?.[EXTENSION_KEY]) {
        return false;
    }

    const text = getMessageText(message).trimStart();
    const header = getEmbeddedSnapshotHeader(settings);

    if (text.startsWith(header)) {
        return true;
    }

    if (snapshotParts.wrapInCodeFence) {
        return text.startsWith(`\`\`\`${snapshotParts.lang}\n`);
    }

    return false;
}

/**
 * Get speaker name from message fields.
 * @param {object} message Message.
 * @returns {string|undefined} Speaker name.
 */
function getMessageSpeakerName(message) {
    if (typeof message.name === 'string' && message.name.trim().length > 0) {
        return message.name.trim();
    }

    if (
        typeof message.source?.name === 'string' &&
		message.source.name.trim().length > 0
    ) {
        return message.source.name.trim();
    }

    return undefined;
}

/**
 * Infer a single assistant label from history.
 * @param {object[]} messages Messages.
 * @returns {string|undefined} Assistant label.
 */
function getSingleAssistantReplyLabel(messages) {
    let assistantLabel;

    for (const message of messages) {
        if (!isAssistantConversationTurn(message)) {
            continue;
        }

        const speakerName = getMessageSpeakerName(message);
        if (!speakerName) {
            continue;
        }

        if (assistantLabel && assistantLabel !== speakerName) {
            return undefined;
        }

        assistantLabel = speakerName;
    }

    return assistantLabel;
}

/**
 * Derive character-style tracker speaker label from settings.
 * @param {object} settings zTracker settings.
 * @returns {string} Speaker label.
 */
function deriveEmbeddedTrackerSpeakerName(settings) {
    const header = getEmbeddedSnapshotHeader(settings);
    const trimmedLabel = header.replace(/:+\s*$/, '').trim();
    return trimmedLabel || 'Tracker';
}

/**
 * Get message extra object for Message or ChatMessage shapes.
 * @param {object} message Message.
 * @returns {object|undefined} Extra object.
 */
function getMessageExtra(message) {
    return message?.source?.extra || message?.extra;
}

/**
 * Build embedded snapshot content.
 * @param {unknown} trackerValue Tracker value.
 * @param {object} settings zTracker settings.
 * @param {boolean} useCharacterName Whether to omit header and use name.
 * @returns {{text:string, lang:string, wrapInCodeFence:boolean, prefix:string}}
 */
function buildEmbeddedContentParts(trackerValue, settings, useCharacterName) {
    const header = getEmbeddedSnapshotHeader(settings);
    const snapshot = formatEmbeddedTrackerSnapshot(trackerValue, settings);
    const richSnapshot =
		typeof snapshot === 'string'
		    ? { lang: 'text', text: snapshot, wrapInCodeFence: false }
		    : snapshot;
    const prefix = !useCharacterName && header ? `${header}\n` : '';

    return {
        ...richSnapshot,
        prefix,
    };
}

/**
 * Include recent zTracker snapshots in a generation chat array.
 * @param {object[]} messages Chat messages.
 * @param {object} [settings] zTracker settings.
 * @param {object} [options] Include options.
 * @param {boolean} [options.preserveTextCompletionTurnAlternation=false] Inline when needed for text completion alternation.
 * @param {boolean} [options.isGroupChat] Whether current chat is a group chat.
 * @param {string} [options.assistantReplyLabel] Active assistant label.
 * @returns {object[]} New chat array containing embedded tracker snapshots.
 */
export function includeZTrackerMessages(
    messages,
    settings = getNativeZTrackerSettings(),
    options = {},
) {
    const copyMessages = safeClone(messages).map((message) => {
        const fallbackName =
			typeof message?.name === 'string' && message.name.trim()
			    ? undefined
			    : typeof message?.source?.name === 'string' &&
						message.source.name.trim()
			        ? message.source.name
			        : undefined;

        return fallbackName ? { ...message, name: fallbackName } : message;
    });
    const embedRole = resolveEmbeddedTrackerRole(settings, options);
    const configuredAssistantReplyLabel =
		typeof options.assistantReplyLabel === 'string' &&
		options.assistantReplyLabel.trim().length > 0
		    ? options.assistantReplyLabel.trim()
		    : undefined;
    const includeCount = Math.max(
        0,
        Number(
            settings.includeLastXZTrackerMessages ??
				DEFAULT_SETTINGS.includeLastXZTrackerMessages,
        ) || 0,
    );

    for (let i = 0; i < includeCount; i++) {
        let foundMessage = null;
        let foundIndex = -1;

        for (let j = copyMessages.length - 1; j >= 0; j--) {
            const message = copyMessages[j];
            const extra = getMessageExtra(message);
            if (
                !message.zTrackerFound &&
				extra?.[EXTENSION_KEY]?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY]
            ) {
                Object.defineProperty(message, 'zTrackerFound', {
                    value: true,
                    configurable: true,
                });
                foundMessage = message;
                foundIndex = j;
                break;
            }
        }

        if (!foundMessage) {
            continue;
        }

        let insertionIndex = foundIndex;
        const extra = getMessageExtra(foundMessage);
        const trackerValue =
			extra?.[EXTENSION_KEY]?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY] || {};
        const useCharacterName = settings.embedZTrackerAsCharacter ?? false;
        const speakerName = useCharacterName
            ? deriveEmbeddedTrackerSpeakerName(settings)
            : undefined;
        const { lang, text, wrapInCodeFence, prefix } = buildEmbeddedContentParts(
            trackerValue,
            settings,
            useCharacterName,
        );
        const content = wrapInCodeFence
            ? `${prefix}\`\`\`${lang}\n${text}\n\`\`\``
            : `${prefix}${text}`;
        const trailingMessages = copyMessages.slice(foundIndex + 1);
        const hasTrailingAssistantPrefill =
			embedRole === 'assistant' &&
			trailingMessages.length === 1 &&
			isAssistantConversationTurn(trailingMessages[0]) &&
			getMessageText(trailingMessages[0]).length === 0;

        if (hasTrailingAssistantPrefill) {
            insertionIndex = copyMessages.length - 1;
        }

        const isTerminalTrackedUser =
			foundIndex === copyMessages.length - 1 &&
			isUserConversationTurn(foundMessage);
        let terminalAssistantReplyLabel;
        if (hasTrailingAssistantPrefill) {
            terminalAssistantReplyLabel = getMessageSpeakerName(
                copyMessages[copyMessages.length - 1],
            );
        } else if (configuredAssistantReplyLabel && isTerminalTrackedUser) {
            terminalAssistantReplyLabel = configuredAssistantReplyLabel;
        } else if (options.isGroupChat === false && isTerminalTrackedUser) {
            terminalAssistantReplyLabel = getSingleAssistantReplyLabel(
                copyMessages.slice(0, foundIndex),
            );
        }

        const shouldInlineTerminalAssistantSnapshot =
			options.preserveTextCompletionTurnAlternation &&
			embedRole === 'assistant' &&
			!hasTrailingAssistantPrefill &&
			!terminalAssistantReplyLabel &&
			isTerminalTrackedUser;
        const needsRawTerminalAssistantSnapshot =
			options.preserveTextCompletionTurnAlternation &&
			embedRole === 'assistant' &&
			(hasTrailingAssistantPrefill || Boolean(terminalAssistantReplyLabel));

        if (
            options.preserveTextCompletionTurnAlternation &&
			(canInlineEmbeddedTracker(foundMessage, embedRole) ||
				shouldInlineTerminalAssistantSnapshot)
        ) {
            const inlineHeader = useCharacterName
                ? `${speakerName ?? 'Tracker'}:\n`
                : prefix;
            const inlineContent = wrapInCodeFence
                ? `${inlineHeader}\`\`\`${lang}\n${text}\n\`\`\``
                : `${inlineHeader}${text}`;

            if (
                upsertSnapshotInMessage(foundMessage, inlineContent, settings, {
                    lang,
                    wrapInCodeFence,
                })
            ) {
                continue;
            }

            const existingContent = getMessageText(foundMessage).trimEnd();
            const mergedContent =
				existingContent.length > 0
				    ? `${existingContent}\n\n${inlineContent}`
				    : inlineContent;
            setMessageText(copyMessages[foundIndex], mergedContent);
            continue;
        }

        const rawTerminalAssistantHeader = speakerName
            ? `${speakerName}:`
            : getEmbeddedSnapshotHeader(settings);
        const rawTerminalAssistantPrefix = speakerName
            ? `${speakerName}:\n`
            : prefix || 'Tracker:\n';
        const rawTerminalAssistantSuffix = terminalAssistantReplyLabel
            ? `\n${terminalAssistantReplyLabel}:`
            : '';
        const rawTerminalAssistantContent = needsRawTerminalAssistantSnapshot
            ? wrapInCodeFence
                ? `${rawTerminalAssistantHeader}\n\`\`\`${lang}\n${text}\n\`\`\`${rawTerminalAssistantSuffix}`
                : `${rawTerminalAssistantPrefix}${text}${rawTerminalAssistantSuffix}`
            : undefined;
        const embeddedContent = rawTerminalAssistantContent ?? content;
        const snapshotParts = { lang, wrapInCodeFence };

        if (
            upsertSnapshotInMessage(
                foundMessage,
                embeddedContent,
                settings,
                snapshotParts,
            )
        ) {
            continue;
        }

        const adjacentMessage = copyMessages[insertionIndex + 1];
        if (
            adjacentMessage &&
			isEmbeddedSnapshotCandidate(adjacentMessage, settings, snapshotParts)
        ) {
            if (!messageContainsSnapshot(adjacentMessage, embeddedContent)) {
                setMessageText(adjacentMessage, embeddedContent);
            }
            adjacentMessage.role = embedRole;
            adjacentMessage.is_user = embedRole === 'user';
            adjacentMessage.is_system = embedRole === 'system';
            if (!needsRawTerminalAssistantSnapshot && speakerName) {
                adjacentMessage.name = speakerName;
            }
            continue;
        }

        const embeddedTrackerMessage = {
            content: embeddedContent,
            role: embedRole,
            is_user: embedRole === 'user',
            is_system: embedRole === 'system',
            extra: { zTrackerEmbeddedSnapshot: true },
            ...(!needsRawTerminalAssistantSnapshot && speakerName
                ? { name: speakerName }
                : {}),
            ...(needsRawTerminalAssistantSnapshot ? { ignoreInstruct: true } : {}),
            mes: embeddedContent,
        };

        Object.defineProperty(
            embeddedTrackerMessage,
            EMBEDDED_TRACKER_SNAPSHOT_MARKER,
            { value: true },
        );
        copyMessages.splice(insertionIndex + 1, 0, embeddedTrackerMessage);
    }

    return copyMessages;
}

/**
 * Register global zTracker generate interceptor.
 * @param {object} [options] Init options.
 * @param {() => object} [options.getSettings] Settings provider.
 * @param {() => object} [options.getContext] Context provider.
 * @returns {Function} Registered interceptor.
 */
export function initZTrackerEmbedInterceptor({
    getSettings = getNativeZTrackerSettings,
    getContext,
} = {}) {
    const interceptor = (chat) => {
        const context =
			typeof getContext === 'function'
			    ? getContext()
			    : globalThis.SillyTavern?.getContext?.();
        const settings = { ...DEFAULT_SETTINGS, ...(getSettings?.() || {}) };
        const isGroupChat = Boolean(context?.selected_group);
        const newChat = includeZTrackerMessages(chat, settings, {
            preserveTextCompletionTurnAlternation:
				context?.mainApi === 'textgenerationwebui',
            isGroupChat,
            assistantReplyLabel: isGroupChat ? undefined : context?.name2,
        });

        chat.length = 0;
        chat.push(...newChat);
    };

    globalThis.ztrackerGenerateInterceptor = interceptor;
    return interceptor;
}
