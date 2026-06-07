import { chat } from '../../../script.js';
import { DOMPurify, Handlebars } from '../../../lib.js';
import {
    DEFAULT_EMBED_SNAPSHOT_HEADER,
    getZTrackerSettings,
} from './config.js';
import {
    CHAT_MESSAGE_PARTS_META_KEY,
    CHAT_MESSAGE_PARTS_ORDER_KEY,
    CHAT_MESSAGE_PENDING_REDACTIONS_KEY,
    CHAT_MESSAGE_SCHEMA_HTML_KEY,
    CHAT_MESSAGE_SCHEMA_PRESET_KEY,
    CHAT_MESSAGE_SCHEMA_VALUE_KEY,
    EXTENSION_KEY,
} from './metadata.js';

export {
    CHAT_MESSAGE_PARTS_META_KEY,
    CHAT_MESSAGE_PARTS_ORDER_KEY,
    CHAT_MESSAGE_PENDING_REDACTIONS_KEY,
    CHAT_MESSAGE_SCHEMA_HTML_KEY,
    CHAT_MESSAGE_SCHEMA_PRESET_KEY,
    CHAT_MESSAGE_SCHEMA_VALUE_KEY,
};

function ensureHandlebarsHelpers(handlebars = Handlebars) {
    if (!handlebars?.helpers?.join) {
        handlebars.registerHelper('join', (value, separator = ', ') =>
            Array.isArray(value) ? value.join(separator) : '',
        );
    }
}

function escapeHtmlAttr(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function toShortTrackerLabel(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of ['name', 'id', 'uid', 'key', 'title']) {
            const candidate = value[key];
            if (typeof candidate === 'string' && candidate.trim())
                return candidate.trim();
            if (typeof candidate === 'number') return String(candidate);
        }
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
    return JSON.stringify(value)?.slice(0, 40) || '(empty)';
}

function sanitizeArrayItemFieldKeys(fieldKeys, idKey, schemaFieldKeys) {
    const allowedFieldKeys =
        Array.isArray(schemaFieldKeys) && schemaFieldKeys.length > 0
            ? new Set(schemaFieldKeys)
            : undefined;
    return fieldKeys.filter(
        (fieldKey) =>
            typeof fieldKey === 'string' &&
            fieldKey.trim().length > 0 &&
            fieldKey !== 'name' &&
            fieldKey !== idKey &&
            fieldKey !== 'required' &&
            (!allowedFieldKeys || allowedFieldKeys.has(fieldKey)),
    );
}

function deriveArrayItemFieldsFallback(items, idKey) {
    if (!Array.isArray(items) || items.length === 0) return [];
    const fields = new Set();
    for (const item of items.slice(0, 5)) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        for (const key of Object.keys(item)) fields.add(key);
    }
    return sanitizeArrayItemFieldKeys(Array.from(fields), idKey).sort((a, b) =>
        a.localeCompare(b),
    );
}

function getPendingRedactionTargets(extra) {
    const targets = extra?.[CHAT_MESSAGE_PENDING_REDACTIONS_KEY]?.targets;
    return Array.isArray(targets) ? targets : [];
}

/**
 * Re-render tracker block for chat message.
 * @param {number} messageId
 * @param {boolean|object} forceOrOptions Pass true to force; object for tests: {context, document, handlebars}.
 */
export function renderTracker(messageId, forceOrOptions = false) {
    const options =
        typeof forceOrOptions === 'object' && forceOrOptions !== null
            ? forceOrOptions
            : {};
    const context = options.context ?? { chat };
    const doc = options.document ?? globalThis.document;
    const handlebars = options.handlebars ?? Handlebars;

    if (!doc) throw new Error('renderTracker: document is required');
    if (!handlebars)
        throw new Error('renderTracker: Handlebars reference is required');
    ensureHandlebarsHelpers(handlebars);

    const message = context.chat?.[messageId];
    const messageBlock = doc.querySelector(`.mes[mesid="${messageId}"]`);
    messageBlock?.querySelector('.mes_ztracker')?.remove();

    const tracker = message?.extra?.[EXTENSION_KEY];
    if (!tracker) return;

    const trackerData = tracker[CHAT_MESSAGE_SCHEMA_VALUE_KEY];
    const trackerHtmlSchema = tracker[CHAT_MESSAGE_SCHEMA_HTML_KEY];
    if (!trackerData || !trackerHtmlSchema || !messageBlock) return;

    const template = handlebars.compile(trackerHtmlSchema, { strict: true });
    const renderedHtml = template({ data: trackerData });
    const container = doc.createElement('div');
    container.className = 'mes_ztracker';
    container.append(
        doc
            .createRange()
            .createContextualFragment(DOMPurify.sanitize(renderedHtml)),
    );

    const partsOrder =
        tracker[CHAT_MESSAGE_PARTS_ORDER_KEY] ?? Object.keys(trackerData ?? {});
    const partsMeta = tracker[CHAT_MESSAGE_PARTS_META_KEY] ?? {};
    const pendingTargets = getPendingRedactionTargets(tracker);
    const partsButtons = partsOrder
        .map((partKey) => {
            const safeKey = escapeHtmlAttr(partKey);
            const value = trackerData?.[partKey];
            const arrayItems = Array.isArray(value)
                ? `<div class="ztracker-part-items">${value
                    .map((item, index) => {
                        const idKey =
                                typeof partsMeta?.[partKey]?.idKey === 'string' &&
                                partsMeta[partKey].idKey.trim()
                                    ? partsMeta[partKey].idKey.trim()
                                    : 'name';
                        const idValue =
                                item && typeof item === 'object' && item[idKey] !== undefined
                                    ? String(item[idKey])
                                    : '';
                        const safeId = idValue
                            ? ` data-ztracker-idkey="${escapeHtmlAttr(idKey)}" data-ztracker-idvalue="${escapeHtmlAttr(idValue)}"`
                            : '';
                        const fieldsFromMeta = Array.isArray(partsMeta?.[partKey]?.fields)
                            ? partsMeta[partKey].fields
                            : [];
                        const fields = fieldsFromMeta.length
                            ? sanitizeArrayItemFieldKeys(fieldsFromMeta, idKey)
                            : deriveArrayItemFieldsFallback(value, idKey);
                        const fieldButtons = fields
                            .map(
                                (fieldKey) =>
                                    `<div class="ztracker-array-item-field-regenerate-button" data-ztracker-part="${safeKey}" data-ztracker-index="${index}" data-ztracker-field="${escapeHtmlAttr(fieldKey)}"${safeId}>${escapeHtmlAttr(fieldKey)}</div>`,
                            )
                            .join('');
                        return `<div class="ztracker-array-item-row"><div class="ztracker-array-item-regenerate-button" data-ztracker-part="${safeKey}" data-ztracker-index="${index}"${safeId}>${escapeHtmlAttr(toShortTrackerLabel(item))}</div>${fieldButtons ? `<div class="ztracker-array-item-fields">${fieldButtons}</div>` : ''}</div>`;
                    })
                    .join('')}</div>`
                : '';
            return `<div class="ztracker-part-row"><div class="ztracker-part-regenerate-button" data-ztracker-part="${safeKey}">${safeKey}</div>${arrayItems}</div>`;
        })
        .join('');

    const controls = doc.createElement('div');
    controls.className = 'ztracker-controls';
    controls.append(
        doc.createRange().createContextualFragment(
            DOMPurify.sanitize(`
        <div class="ztracker-regenerate-button fa-solid fa-arrows-rotate" title="Regenerate Tracker"></div>
        <details class="ztracker-parts-details" title="Regenerate individual parts">
            <summary class="ztracker-parts-summary fa-solid fa-list"></summary>
            <div class="ztracker-parts-list">${partsButtons}</div>
        </details>
        <div class="ztracker-cleanup-button fa-solid fa-eraser" title="Clear or recreate selected tracker targets"></div>
        <div class="ztracker-edit-button fa-solid fa-code" title="Edit Tracker Data"></div>
        <div class="ztracker-delete-button fa-solid fa-trash-can" title="Delete Tracker"></div>
    `),
        ),
    );

    if (pendingTargets.length > 0) {
        const pendingStatus = doc.createElement('div');
        pendingStatus.className = 'ztracker-pending-redactions-status';
        pendingStatus.textContent = `${pendingTargets.length} tracker ${pendingTargets.length === 1 ? 'target' : 'targets'} cleared`;
        container.prepend(pendingStatus);
    }

    container.prepend(controls);
    messageBlock.querySelector('.mes_text')?.before(container);
}

export function applyTrackerUpdateAndRender(messageOrId, options) {
    const message =
        typeof messageOrId === 'number' ? chat[messageOrId] : messageOrId;
    if (!message)
        throw new Error('applyTrackerUpdateAndRender: message is required');
    if (!options?.render)
        throw new Error('applyTrackerUpdateAndRender: render callback is required');

    const hadExisting = !!message.extra?.[EXTENSION_KEY];
    const previousValue = hadExisting
        ? structuredClone(message.extra[EXTENSION_KEY])
        : undefined;
    const rollback = () => {
        if (hadExisting) {
            message.extra = message.extra || {};
            message.extra[EXTENSION_KEY] = structuredClone(previousValue);
            return;
        }
        if (message.extra) delete message.extra[EXTENSION_KEY];
    };

    message.extra = message.extra || {};
    message.extra[EXTENSION_KEY] = message.extra[EXTENSION_KEY] || {};
    if (options.extensionData) {
        for (const [key, value] of Object.entries(options.extensionData)) {
            if (value === undefined) delete message.extra[EXTENSION_KEY][key];
            else message.extra[EXTENSION_KEY][key] = value;
        }
    }
    message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_VALUE_KEY] =
        options.trackerData;
    message.extra[EXTENSION_KEY][CHAT_MESSAGE_SCHEMA_HTML_KEY] =
        options.trackerHtml;
    warnOnDependentArrayMismatches(
        options.trackerData,
        message.extra[EXTENSION_KEY][CHAT_MESSAGE_PARTS_META_KEY],
    );

    try {
        options.render();
    } catch (error) {
        rollback();
        throw error;
    }
    return rollback;
}

function normalizeDependsOn(value) {
    if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
    if (Array.isArray(value))
        return value
            .filter((v) => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean);
    return [];
}

function getTopLevelSchemaKeys(schema) {
    const props = schema?.properties;
    return props && typeof props === 'object' && !Array.isArray(props)
        ? Object.keys(props)
        : [];
}

export function resolveTopLevelPartsOrder(schema) {
    const baseOrder = getTopLevelSchemaKeys(schema);
    if (baseOrder.length <= 1) return baseOrder;
    const props = schema?.properties;
    const nodes = new Set(baseOrder);
    const inDegree = new Map(baseOrder.map((key) => [key, 0]));
    const dependents = new Map(baseOrder.map((key) => [key, new Set()]));

    for (const key of baseOrder) {
        for (const dep of normalizeDependsOn(
            props?.[key]?.['x-ztracker-dependsOn'],
        ).filter((dep) => nodes.has(dep))) {
            inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
            dependents.get(dep)?.add(key);
        }
    }

    const rank = new Map(baseOrder.map((key, index) => [key, index]));
    const ready = baseOrder
        .filter((key) => (inDegree.get(key) ?? 0) === 0)
        .sort((a, b) => rank.get(a) - rank.get(b));
    const out = [];
    while (ready.length) {
        const next = ready.shift();
        out.push(next);
        for (const dep of dependents.get(next) ?? []) {
            const value = (inDegree.get(dep) ?? 0) - 1;
            inDegree.set(dep, value);
            if (value === 0) ready.push(dep);
        }
        ready.sort((a, b) => rank.get(a) - rank.get(b));
    }
    return out.length === baseOrder.length ? out : baseOrder;
}

function getArrayItemIdentityKey(schema, partKey) {
    const key = schema?.properties?.[partKey]?.['x-ztracker-idKey'];
    return typeof key === 'string' && key.trim() ? key.trim() : 'name';
}

export function buildPartsMeta(schema) {
    const meta = {};
    const props = schema?.properties;
    if (!props || typeof props !== 'object') return meta;

    for (const key of Object.keys(props)) {
        const def = props[key];
        if (def?.type !== 'array') continue;
        const idKey = getArrayItemIdentityKey(schema, key);
        const dependsOn = normalizeDependsOn(def?.['x-ztracker-dependsOn']);
        const itemProps =
            def?.items?.type === 'object' ? def.items.properties : undefined;
        const fields =
            itemProps && typeof itemProps === 'object'
                ? Object.keys(itemProps).filter(
                    (fieldKey) => fieldKey !== idKey && fieldKey !== 'name',
                )
                : undefined;
        meta[key] = {
            idKey,
            ...(fields?.length ? { fields } : {}),
            ...(dependsOn.length ? { dependsOn } : {}),
        };
    }
    return meta;
}

export function getSchemaRenderMetadata(schema) {
    return {
        partsOrder: resolveTopLevelPartsOrder(schema),
        partsMeta: buildPartsMeta(schema),
    };
}

function warnOnDependentArrayMismatches(trackerData, partsMeta) {
    if (!trackerData || typeof trackerData !== 'object' || !partsMeta) return;
    for (const [partKey, meta] of Object.entries(partsMeta)) {
        const dependsOn = Array.isArray(meta?.dependsOn) ? meta.dependsOn : [];
        if (!dependsOn.length) continue;
        const detailItems = trackerData[partKey];
        if (!Array.isArray(detailItems)) continue;
        const idKey =
            typeof meta?.idKey === 'string' && meta.idKey.trim()
                ? meta.idKey.trim()
                : 'name';
        const availableIds = new Set(
            detailItems
                .map((item) =>
                    item && typeof item === 'object' ? item[idKey] : undefined,
                )
                .filter((value) => typeof value === 'string' && value.trim()),
        );
        for (const dependencyKey of dependsOn) {
            const sourceItems = trackerData[dependencyKey];
            if (!Array.isArray(sourceItems)) continue;
            const missingIds = sourceItems
                .map((item) => {
                    if (typeof item === 'string') return item.trim();
                    if (
                        item &&
                        typeof item === 'object' &&
                        typeof item[idKey] === 'string'
                    )
                        return item[idKey].trim();
                    return '';
                })
                .filter((value) => value && !availableIds.has(value));
            if (missingIds.length)
                console.warn('zTracker: dependent array mismatch', {
                    partKey,
                    dependsOn: dependencyKey,
                    idKey,
                    missingIds,
                });
        }
    }
}

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function formatScalarMinimal(value) {
    if (value === null) return 'null';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean')
        return String(value);
    return JSON.stringify(value);
}

function buildTopLevelLines(value, indent = '') {
    if (Array.isArray(value)) {
        if (!value.length) return `${indent}(empty)\n`;
        return value
            .map((item) =>
                isPlainObject(item) || Array.isArray(item)
                    ? `${indent}-\n${buildTopLevelLines(item, `${indent}  `)}`
                    : `${indent}- ${formatScalarMinimal(item)}\n`,
            )
            .join('');
    }
    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        if (!entries.length) return `${indent}(empty)\n`;
        return entries
            .map(([key, val]) =>
                isPlainObject(val) || Array.isArray(val)
                    ? `${indent}${key}:\n${buildTopLevelLines(val, `${indent}  `)}`
                    : `${indent}${key}: ${formatScalarMinimal(val)}\n`,
            )
            .join('');
    }
    return `${indent}${formatScalarMinimal(value)}\n`;
}

function formatToonLike(value, indent = '') {
    if (Array.isArray(value))
        return value
            .map(
                (item, index) =>
                    `${indent}[${index}]\n${formatToonLike(item, `${indent}\t`)}`,
            )
            .join('');
    if (isPlainObject(value))
        return Object.entries(value)
            .map(([key, val]) =>
                isPlainObject(val) || Array.isArray(val)
                    ? `${indent}${key}:\n${formatToonLike(val, `${indent}\t`)}`
                    : `${indent}${key}: ${formatScalarMinimal(val)}\n`,
            )
            .join('');
    return `${indent}${formatScalarMinimal(value)}\n`;
}

export function formatEmbeddedTrackerSnapshot(
    trackerValue,
    settings = getZTrackerSettings(),
) {
    const format =
        settings.embedSnapshotFormat ??
        settings.embedZTrackerSnapshotTransformPreset ??
        'pretty_json';
    switch (format) {
        case 'top_level_lines':
            return {
                lang: 'text',
                text: buildTopLevelLines(trackerValue ?? {}).trimEnd(),
                wrapInCodeFence: false,
            };
        case 'toon':
            return {
                lang: 'toon',
                text: formatToonLike(trackerValue ?? {}).trimEnd(),
                wrapInCodeFence: true,
            };
        default:
            return {
                lang: 'json',
                text: JSON.stringify(trackerValue ?? {}, null, 2),
                wrapInCodeFence: true,
            };
    }
}

function getMessageExtra(message) {
    return 'source' in message ? message.source?.extra : message.extra;
}

function getMessageText(message) {
    if (typeof message.content === 'string' && message.content.trim())
        return message.content;
    if (typeof message.mes === 'string' && message.mes.trim()) return message.mes;
    return '';
}

function deriveEmbeddedTrackerSpeakerName(settings) {
    const header =
        settings.embedSnapshotHeader ??
        settings.embedZTrackerSnapshotHeader ??
        DEFAULT_EMBED_SNAPSHOT_HEADER;
    const trimmedLabel = header.replace(/:+\s*$/, '').trim();
    return trimmedLabel || 'Tracker';
}

export function includeZTrackerMessages(
    messages,
    settings = getZTrackerSettings(),
) {
    const count = Number.isFinite(Number(settings.includeLastXZTrackerMessages))
        ? Number(settings.includeLastXZTrackerMessages)
        : 1;
    if (count <= 0) return structuredClone(messages);

    const copyMessages = structuredClone(messages);
    const role = settings.embedZTrackerRole ?? 'user';
    const header =
        settings.embedSnapshotHeader ??
        settings.embedZTrackerSnapshotHeader ??
        DEFAULT_EMBED_SNAPSHOT_HEADER;
    const useCharacterName = settings.embedZTrackerAsCharacter ?? false;
    const speakerName = useCharacterName
        ? deriveEmbeddedTrackerSpeakerName(settings)
        : undefined;
    let inserted = 0;

    for (
        let index = copyMessages.length - 1;
        index >= 0 && inserted < count;
        index--
    ) {
        const message = copyMessages[index];
        const trackerValue =
            getMessageExtra(message)?.[EXTENSION_KEY]?.[
                CHAT_MESSAGE_SCHEMA_VALUE_KEY
            ];
        if (!trackerValue) continue;
        const { lang, text, wrapInCodeFence } = formatEmbeddedTrackerSnapshot(
            trackerValue,
            settings,
        );
        const prefix = !useCharacterName && header ? `${header}\n` : '';
        const content = wrapInCodeFence
            ? `${prefix}\`\`\`${lang}\n${text}\n\`\`\``
            : `${prefix}${text}`;
        const embeddedTrackerMessage = {
            content,
            role,
            is_user: role === 'user',
            is_system: role === 'system',
            ...(speakerName ? { name: speakerName } : {}),
            mes: content,
        };
        if (role === 'assistant' && getMessageText(message).length === 0) {
            copyMessages[index].content = content;
            copyMessages[index].mes = content;
        } else {
            copyMessages.splice(index + 1, 0, embeddedTrackerMessage);
        }
        inserted++;
    }

    return copyMessages;
}
