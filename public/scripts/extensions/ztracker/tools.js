import { chat, saveChatConditional } from '../../../script.js';
import { Handlebars } from '../../../lib.js';
import { ToolManager } from '../../tool-calling.js';
import { getActiveSchemaPreset, getZTrackerSettings } from './config.js';
import { addPendingRedactions, clearPendingRedactions } from './cleanup.js';
import {
    CHAT_MESSAGE_PARTS_META_KEY,
    CHAT_MESSAGE_PARTS_ORDER_KEY,
    CHAT_MESSAGE_PENDING_REDACTIONS_KEY,
    CHAT_MESSAGE_SCHEMA_HTML_KEY,
    CHAT_MESSAGE_SCHEMA_PRESET_KEY,
    CHAT_MESSAGE_SCHEMA_VALUE_KEY,
    EXTENSION_KEY,
} from './metadata.js';
import {
    mergeTrackerPart,
    replaceTrackerArrayItem,
    replaceTrackerArrayItemByIdentity,
} from './parts.js';
import {
    applyTrackerUpdateAndRender,
    getSchemaRenderMetadata,
    renderTracker,
} from './tracker.js';

let trackerToolsRegistered = false;

const TOOL_NAMES = ['update_tracker', 'recreate_tracker_field', 'cleanup_tracker', 'edit_tracker'];

function initializeToolDiagnostics() {
    globalThis.zTrackerToolStatus = globalThis.zTrackerToolStatus || {};
    for (const name of TOOL_NAMES) {
        if (!(name in globalThis.zTrackerToolStatus)) {
            globalThis.zTrackerToolStatus[name] = 'registered';
        }
    }
    if (
        Object.values(globalThis.zTrackerToolStatus).every((status) =>
            status === 'registered' || status === 'ok',
        )
    ) {
        globalThis.zTrackerLastError = null;
    }
}

function ok(extra = {}) {
    return { ok: true, errors: [], ...extra };
}

function fail(message, extra = {}) {
    return { ok: false, errors: [String(message)], ...extra };
}

function recordToolResult(toolName, result) {
    globalThis.zTrackerToolStatus = globalThis.zTrackerToolStatus || {};
    globalThis.zTrackerToolStatus[toolName] = result?.ok ? 'ok' : 'error';
    if (!result?.ok) {
        const errors = Array.isArray(result?.errors)
            ? result.errors
            : [result?.errors ?? 'Unknown zTracker tool error'];
        globalThis.zTrackerLastError = errors.map(String).join('; ');
    }
    return result;
}

function resolveMessageIndex(messageIndex) {
    const numericIndex = Number(messageIndex);
    const resolvedIndex = numericIndex === -1 ? chat.length - 1 : numericIndex;
    if (!Number.isInteger(resolvedIndex)) {
        throw new Error('message_index must be an integer');
    }
    if (resolvedIndex < 0 || resolvedIndex >= chat.length) {
        throw new Error(`message_index out of range: ${messageIndex}`);
    }
    return resolvedIndex;
}

function getExistingTracker(message) {
    const tracker = message?.extra?.[EXTENSION_KEY];
    const value = tracker?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('No existing tracker data found for message');
    }
    return tracker;
}

function getActiveSchema() {
    const settings = getZTrackerSettings();
    const preset = getActiveSchemaPreset(settings);
    if (!preset?.value || typeof preset.value !== 'object') {
        throw new Error('No active zTracker schema preset is configured');
    }
    return { settings, preset };
}

function assertSchemaPart(schema, partKey) {
    if (!partKey || typeof partKey !== 'string') {
        throw new Error('part_key is required');
    }
    if (!schema?.properties?.[partKey]) {
        throw new Error(`Unknown schema part: ${partKey}`);
    }
}

function hasIdentityTarget(args) {
    return (
        typeof args.id_key === 'string' &&
        args.id_key.trim() &&
        args.id_value !== undefined
    );
}

function hasIndexTarget(args) {
    return args.index !== undefined && args.index !== null;
}

function replaceArrayItemField(
    trackerData,
    partKey,
    index,
    fieldKey,
    newValue,
) {
    const next = structuredClone(trackerData);
    const arrayValue = next[partKey];
    if (!Array.isArray(arrayValue)) {
        throw new Error(`Tracker field is not an array: ${partKey}`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= arrayValue.length) {
        throw new Error(`Array index out of range for ${partKey}: ${index}`);
    }
    const item = arrayValue[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(
            `Tracker array item is not an object: ${partKey}[${index}]`,
        );
    }
    if (!fieldKey || typeof fieldKey !== 'string') {
        throw new Error('field_key is required for field update');
    }
    arrayValue[index] = {
        ...item,
        [fieldKey]: newValue,
    };
    return next;
}

function findIdentityIndex(trackerData, partKey, idKey, idValue) {
    const arrayValue = trackerData?.[partKey];
    if (!Array.isArray(arrayValue)) {
        throw new Error(`Tracker field is not an array: ${partKey}`);
    }
    const exact = arrayValue.findIndex(
        (item) => item && typeof item === 'object' && item[idKey] === idValue,
    );
    if (exact !== -1) {
        return exact;
    }

    const lowered = String(idValue).toLowerCase();
    const matches = [];
    arrayValue.forEach((item, index) => {
        if (
            item &&
            typeof item === 'object' &&
            typeof item[idKey] === 'string' &&
            item[idKey].toLowerCase() === lowered
        ) {
            matches.push(index);
        }
    });

    if (matches.length !== 1) {
        throw new Error(`Array item not found for ${partKey}.${idKey}: ${idValue}`);
    }
    return matches[0];
}

function applyPartialUpdate(trackerData, args, schema) {
    const partKey = String(args.part_key);
    assertSchemaPart(schema, partKey);

    if (hasIdentityTarget(args)) {
        const idKey = args.id_key.trim();
        if (args.field_key) {
            const index = findIdentityIndex(
                trackerData,
                partKey,
                idKey,
                args.id_value,
            );
            return replaceArrayItemField(
                trackerData,
                partKey,
                index,
                String(args.field_key),
                args.new_value,
            );
        }
        return replaceTrackerArrayItemByIdentity(
            trackerData,
            partKey,
            idKey,
            args.id_value,
            args.new_value,
        );
    }

    if (hasIndexTarget(args)) {
        const index = Number(args.index);
        if (args.field_key) {
            return replaceArrayItemField(
                trackerData,
                partKey,
                index,
                String(args.field_key),
                args.new_value,
            );
        }
        return replaceTrackerArrayItem(trackerData, partKey, index, args.new_value);
    }

    if (args.field_key) {
        const base = structuredClone(trackerData);
        const partValue = base[partKey];
        if (
            !partValue ||
            typeof partValue !== 'object' ||
            Array.isArray(partValue)
        ) {
            throw new Error(`Tracker part is not an object: ${partKey}`);
        }
        base[partKey] = {
            ...partValue,
            [String(args.field_key)]: args.new_value,
        };
        return base;
    }

    return mergeTrackerPart(trackerData, partKey, { [partKey]: args.new_value });
}

function shouldRegisterTrackerTool() {
    const settings = getZTrackerSettings();
    return Boolean(
        settings.enabled &&
            getActiveSchemaPreset(settings)?.value &&
            ToolManager.isToolCallingSupported(),
    );
}

function normalizeCleanupTargets(targets) {
    if (!Array.isArray(targets)) {
        throw new Error('targets must be an array');
    }
    return targets.map((target) => {
        if (!target || typeof target !== 'object' || Array.isArray(target)) {
            throw new Error('Each cleanup target must be an object');
        }
        const partKey =
            typeof target.partKey === 'string' ? target.partKey.trim() : '';
        if (!partKey) throw new Error('Each cleanup target requires partKey');
        return {
            kind: target.kind,
            partKey,
            ...(Number.isInteger(target.index) ? { index: target.index } : {}),
            ...(typeof target.idKey === 'string' && target.idKey.trim()
                ? { idKey: target.idKey.trim() }
                : {}),
            ...(target.idValue !== undefined
                ? { idValue: String(target.idValue) }
                : {}),
            ...(typeof target.fieldKey === 'string' && target.fieldKey.trim()
                ? { fieldKey: target.fieldKey.trim() }
                : {}),
        };
    });
}

function redactCleanupTarget(trackerData, target) {
    const next = structuredClone(trackerData);
    switch (target.kind) {
        case 'part':
            delete next[target.partKey];
            return next;
        case 'field':
            if (!target.fieldKey)
                throw new Error(
                    `field cleanup for ${target.partKey} requires fieldKey`,
                );
            if (
                next[target.partKey] &&
                typeof next[target.partKey] === 'object' &&
                !Array.isArray(next[target.partKey])
            ) {
                delete next[target.partKey][target.fieldKey];
            }
            return next;
        case 'arrayItem':
        case 'arrayItemById': {
            const arrayValue = next[target.partKey];
            if (!Array.isArray(arrayValue))
                throw new Error(`Tracker field is not an array: ${target.partKey}`);
            const index =
                target.kind === 'arrayItem'
                    ? Number(target.index)
                    : findIdentityIndex(
                        next,
                        target.partKey,
                        target.idKey,
                        target.idValue,
                    );
            if (!Number.isInteger(index) || index < 0 || index >= arrayValue.length) {
                throw new Error(`Array item not found for ${target.partKey}`);
            }
            arrayValue.splice(index, 1);
            return next;
        }
        default:
            throw new Error(`Unsupported cleanup target kind: ${target.kind}`);
    }
}

function validateTrackerData(trackerData, schema) {
    const errors = [];
    if (
        !trackerData ||
        typeof trackerData !== 'object' ||
        Array.isArray(trackerData)
    ) {
        errors.push('tracker_data must be an object.');
        return errors;
    }

    const required = Array.isArray(schema?.required) ? schema.required : [];
    for (const key of required) {
        if (typeof key === 'string' && !(key in trackerData)) {
            errors.push(`Missing required tracker_data field: ${key}`);
        }
    }
    return errors;
}

function ensureHandlebarsHelpers() {
    if (!Handlebars?.helpers?.join) {
        Handlebars.registerHelper('join', (value, separator = ', ') =>
            Array.isArray(value) ? value.join(separator) : '',
        );
    }
}

function renderTrackerHtml(trackerData, template) {
    if (!Handlebars) return undefined;
    ensureHandlebarsHelpers();
    return Handlebars.compile(template, { strict: true })({ data: trackerData });
}

async function persistTrackerUpdate(
    messageId,
    message,
    tracker,
    trackerData,
    preset,
    extensionData = {},
) {
    const settings = getZTrackerSettings();
    const renderMetadata = getSchemaRenderMetadata(preset.value);
    const rollback = applyTrackerUpdateAndRender(message, {
        trackerData,
        trackerHtml: tracker?.[CHAT_MESSAGE_SCHEMA_HTML_KEY] ?? preset.html,
        extensionData: {
            [CHAT_MESSAGE_SCHEMA_PRESET_KEY]:
                tracker?.[CHAT_MESSAGE_SCHEMA_PRESET_KEY] ??
                settings.schemaPreset ??
                'default',
            [CHAT_MESSAGE_PARTS_ORDER_KEY]: renderMetadata.partsOrder,
            [CHAT_MESSAGE_PARTS_META_KEY]: renderMetadata.partsMeta,
            ...extensionData,
        },
        render: () => renderTracker(messageId),
    });
    try {
        await saveChatConditional();
    } catch (error) {
        rollback?.();
        renderTracker(messageId);
        throw error;
    }
}

function registerUpdateTrackerTool() {
    ToolManager.registerFunctionTool({
        name: 'update_tracker',
        displayName: 'Update Tracker',
        description:
            'Update the state tracker for the current message with complete tracker data matching the active zTracker schema.',
        parameters: Object.freeze({
            type: 'object',
            properties: {
                message_index: {
                    type: 'number',
                    description:
                        'Index of the message to update. Use -1 for the latest message.',
                },
                tracker_data: {
                    type: 'object',
                    description:
                        'Complete tracker state data matching the active zTracker schema.',
                },
            },
            required: ['message_index', 'tracker_data'],
        }),
        action: async (args) => {
            const rawMessageIndex = args?.message_index;
            let messageId;
            try {
                messageId = resolveMessageIndex(rawMessageIndex);
            } catch {
                return recordToolResult('update_tracker', fail(`Invalid message index: ${rawMessageIndex}`));
            }

            try {
                const message = chat[messageId];
                const tracker = message?.extra?.[EXTENSION_KEY];
                const { preset } = getActiveSchema();
                const trackerData = args?.tracker_data;
                const validationErrors = validateTrackerData(trackerData, preset.value);
                if (validationErrors.length) {
                    return recordToolResult('update_tracker', { ok: false, errors: validationErrors });
                }

                try {
                    renderTrackerHtml(trackerData, preset.html);
                } catch (error) {
                    return recordToolResult('update_tracker', fail(`Template render failed: ${error?.message ?? error}`));
                }

                await persistTrackerUpdate(
                    messageId,
                    message,
                    tracker,
                    trackerData,
                    preset,
                );
                return recordToolResult('update_tracker', ok({ message: 'Tracker updated', message_index: messageId }));
            } catch (error) {
                const message = error?.message ?? error;
                if (String(message).includes('No active zTracker schema preset')) {
                    return recordToolResult('update_tracker', fail('No schema preset configured'));
                }
                return recordToolResult('update_tracker', fail(`Failed to save: ${message}`));
            }
        },
        shouldRegister: shouldRegisterTrackerTool,
        stealth: false,
        formatMessage: (args) =>
            `Updating tracker for message ${args?.message_index ?? 'unknown'}`,
    });
}

function registerRecreateTrackerFieldTool() {
    ToolManager.registerFunctionTool({
        name: 'recreate_tracker_field',
        displayName: 'Recreate Tracker Field',
        description:
            'Regenerate a specific field or part of the tracker. Can target a top-level part, a specific array item by index or identity, or a single field within an item.',
        parameters: Object.freeze({
            type: 'object',
            properties: {
                message_index: {
                    type: 'number',
                    description: 'Index of the message to update (-1 for latest)',
                },
                part_key: {
                    type: 'string',
                    description: 'Top-level key of the part to regenerate',
                },
                new_value: {
                    description: 'New value for the targeted field/part',
                },
                id_key: {
                    type: 'string',
                    description: 'Optional: identity key for array item lookup',
                },
                id_value: {
                    description: 'Optional: identity value for array item lookup',
                },
                field_key: {
                    type: 'string',
                    description: 'Optional: specific field within the item to update',
                },
                index: {
                    type: 'number',
                    description: 'Optional: array index for direct item targeting',
                },
            },
            required: ['message_index', 'part_key', 'new_value'],
        }),
        action: async (args) => {
            try {
                const messageId = resolveMessageIndex(args?.message_index);
                const message = chat[messageId];
                const tracker = getExistingTracker(message);
                const { preset } = getActiveSchema();
                const trackerData = structuredClone(
                    tracker[CHAT_MESSAGE_SCHEMA_VALUE_KEY],
                );
                const nextTrackerData = applyPartialUpdate(
                    trackerData,
                    args ?? {},
                    preset.value,
                );
                await persistTrackerUpdate(
                    messageId,
                    message,
                    tracker,
                    nextTrackerData,
                    preset,
                );
                return recordToolResult('recreate_tracker_field', ok({ message_index: messageId }));
            } catch (error) {
                console.warn('zTracker recreate_tracker_field failed:', error);
                return recordToolResult('recreate_tracker_field', fail(error?.message ?? error));
            }
        },
        shouldRegister: shouldRegisterTrackerTool,
        stealth: false,
    });
}

function registerCleanupTrackerTool() {
    ToolManager.registerFunctionTool({
        name: 'cleanup_tracker',
        displayName: 'Cleanup Tracker',
        description:
            'Clear and optionally recreate specific parts of the tracker. Use to remove stale entries or reset fields.',
        parameters: Object.freeze({
            type: 'object',
            properties: {
                message_index: {
                    type: 'number',
                    description: 'Index of the message (-1 for latest)',
                },
                targets: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            kind: {
                                type: 'string',
                                enum: ['part', 'arrayItem', 'arrayItemById', 'field'],
                            },
                            partKey: { type: 'string' },
                            index: { type: 'number' },
                            idKey: { type: 'string' },
                            idValue: { type: 'string' },
                            fieldKey: { type: 'string' },
                        },
                        required: ['kind', 'partKey'],
                    },
                    description: 'List of targets to clean up',
                },
                recreate: {
                    type: 'boolean',
                    description:
                        'If true, targets will be recreated (pending redaction). If false, they are just cleared.',
                },
            },
            required: ['message_index', 'targets'],
        }),
        action: async (args) => {
            try {
                const messageId = resolveMessageIndex(args?.message_index);
                const message = chat[messageId];
                const tracker = getExistingTracker(message);
                const { preset } = getActiveSchema();
                const targets = normalizeCleanupTargets(args?.targets);
                let nextTrackerData = structuredClone(
                    tracker[CHAT_MESSAGE_SCHEMA_VALUE_KEY],
                );
                for (const target of targets) {
                    nextTrackerData = redactCleanupTarget(nextTrackerData, target);
                }

                const extensionData = args?.recreate
                    ? {
                        [CHAT_MESSAGE_PENDING_REDACTIONS_KEY]: addPendingRedactions(
                            message,
                            tracker?.[CHAT_MESSAGE_SCHEMA_PRESET_KEY] ??
                                    preset.name ??
                                    'default',
                            targets,
                        ),
                    }
                    : { [CHAT_MESSAGE_PENDING_REDACTIONS_KEY]: undefined };
                if (!args?.recreate) clearPendingRedactions(message);

                await persistTrackerUpdate(
                    messageId,
                    message,
                    tracker,
                    nextTrackerData,
                    preset,
                    extensionData,
                );
                return recordToolResult('cleanup_tracker', ok({
                    message_index: messageId,
                    targets_cleared: targets.length,
                    recreate: Boolean(args?.recreate),
                }));
            } catch (error) {
                console.warn('zTracker cleanup_tracker failed:', error);
                return recordToolResult('cleanup_tracker', fail(error?.message ?? error));
            }
        },
        shouldRegister: shouldRegisterTrackerTool,
        stealth: false,
    });
}

function registerEditTrackerTool() {
    ToolManager.registerFunctionTool({
        name: 'edit_tracker',
        displayName: 'Edit Tracker',
        description:
            'Apply an edit to the tracker data. The model sees the edit result and can acknowledge or make further changes.',
        parameters: Object.freeze({
            type: 'object',
            properties: {
                message_index: {
                    type: 'number',
                    description: 'Index of the message (-1 for latest)',
                },
                tracker_data: {
                    type: 'object',
                    description: 'Complete updated tracker data',
                },
            },
            required: ['message_index', 'tracker_data'],
        }),
        action: async (args) => {
            try {
                const messageId = resolveMessageIndex(args?.message_index);
                const message = chat[messageId];
                const tracker = getExistingTracker(message);
                const { preset } = getActiveSchema();
                const trackerData = args?.tracker_data;
                if (
                    !trackerData ||
                    typeof trackerData !== 'object' ||
                    Array.isArray(trackerData)
                ) {
                    throw new Error('tracker_data must be an object');
                }
                await persistTrackerUpdate(
                    messageId,
                    message,
                    tracker,
                    trackerData,
                    preset,
                    {
                        [CHAT_MESSAGE_PENDING_REDACTIONS_KEY]: undefined,
                    },
                );
                clearPendingRedactions(message);
                return recordToolResult('edit_tracker', ok({
                    message_index: messageId,
                    rendered_html: renderTrackerHtml(
                        trackerData,
                        tracker?.[CHAT_MESSAGE_SCHEMA_HTML_KEY] ?? preset.html,
                    ),
                }));
            } catch (error) {
                console.warn('zTracker edit_tracker failed:', error);
                return recordToolResult('edit_tracker', fail(error?.message ?? error));
            }
        },
        shouldRegister: shouldRegisterTrackerTool,
        stealth: false,
    });
}

export function registerTrackerTools() {
    initializeToolDiagnostics();
    if (trackerToolsRegistered) return;
    trackerToolsRegistered = true;
    registerUpdateTrackerTool();
    registerRecreateTrackerFieldTool();
    registerCleanupTrackerTool();
    registerEditTrackerTool();
}

export { shouldRegisterTrackerTool };
