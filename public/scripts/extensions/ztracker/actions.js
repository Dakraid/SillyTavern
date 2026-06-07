import { chat, saveChatConditional } from '../../../script.js';
import { getContext } from '../../st-context.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { ToolManager } from '../../tool-calling.js';
import { getActiveSchemaPreset, getZTrackerSettings } from './config.js';
import { CHAT_MESSAGE_SCHEMA_VALUE_KEY, EXTENSION_KEY } from './metadata.js';
import { renderTracker } from './tracker.js';

let initialized = false;
let activeGenerationMessageId = null;

function resolveMessageIndex(messageIndex) {
    const numericIndex = Number(messageIndex);
    if (!Number.isInteger(numericIndex)) {
        throw new Error('Message index must be an integer.');
    }
    if (numericIndex < 0 || numericIndex >= chat.length) {
        throw new Error(`Message index out of range: ${messageIndex}`);
    }
    return numericIndex;
}

function getMessageElement(messageId) {
    return document.querySelector(`.mes[mesid="${messageId}"]`);
}

function getMessageIdFromButton(button) {
    const raw = button?.dataset?.mesid;
    if (raw !== undefined) {
        return Number(raw);
    }
    const messageBlock = button?.closest?.('.mes');
    return Number(messageBlock?.getAttribute?.('mesid'));
}

function getTrackerData(messageId) {
    return chat[messageId]?.extra?.[EXTENSION_KEY]?.[
        CHAT_MESSAGE_SCHEMA_VALUE_KEY
    ];
}

async function confirmAction(message) {
    return callGenericPopup(message, POPUP_TYPE.CONFIRM);
}

async function promptJson(title, value) {
    const textarea = document.createElement('textarea');
    textarea.className = 'text_pole textarea_compact ztracker-json-editor';
    textarea.value = JSON.stringify(value ?? {}, null, 4);
    textarea.rows = 18;
    textarea.spellcheck = false;

    const wrapper = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = title;
    const hint = document.createElement('p');
    hint.textContent = 'Edit JSON, then confirm to update zTracker state.';
    wrapper.append(heading, hint, textarea);

    const confirmed = await callGenericPopup(wrapper, POPUP_TYPE.CONFIRM, '', {
        wide: true,
        large: true,
        okButton: 'Update Tracker',
        cancelButton: 'Cancel',
    });
    if (!confirmed) return undefined;
    return JSON.parse(textarea.value || '{}');
}

function parseToolResult(result) {
    if (result instanceof Error) {
        return { ok: false, errors: [result.message] };
    }
    if (typeof result === 'string') {
        try {
            return JSON.parse(result);
        } catch {
            return { ok: true, errors: [], message: result };
        }
    }
    return result ?? { ok: true, errors: [] };
}

async function invokeTrackerTool(name, parameters) {
    const result = parseToolResult(
        await ToolManager.invokeFunctionTool(name, parameters),
    );
    if (!result?.ok) {
        const errors = Array.isArray(result?.errors)
            ? result.errors.join('\n')
            : String(result?.errors ?? 'Unknown zTracker error');
        throw new Error(errors);
    }
    return result;
}

/**
 * Ask the active model to update tracker data for one message by calling
 * the update_tracker tool. This is user-initiated, so a generation request is
 * expected; automatic retries must not call this function.
 * @param {number|string} messageIndex Chat message index.
 * @returns {Promise<{ok:boolean, errors:string[], message_index?:number}>}
 */
export async function generateTrackerForMessage(messageIndex) {
    const messageId = resolveMessageIndex(messageIndex);
    const settings = getZTrackerSettings();
    if (!settings?.enabled) {
        return { ok: false, errors: ['zTracker is not enabled.'] };
    }

    const preset = getActiveSchemaPreset(settings);
    if (!preset?.value || typeof preset.value !== 'object') {
        return {
            ok: false,
            errors: ['No active zTracker schema preset configured.'],
        };
    }

    if (activeGenerationMessageId !== null) {
        return {
            ok: false,
            errors: [
                `Tracker update already in progress for message ${activeGenerationMessageId}.`,
            ],
        };
    }

    activeGenerationMessageId = messageId;
    try {
        const context = getContext();
        const messageText = String(chat[messageId]?.mes ?? '').trim();
        const schemaName = String(preset.name ?? settings.schemaPreset ?? 'active schema');
        const quietPrompt = [
            `Update the state tracker for message index ${messageId} by calling the update_tracker tool.`,
            `Use tracker_data that matches the active zTracker schema preset: ${schemaName}.`,
            'Base the tracker_data only on the target message and relevant prior chat context.',
            'Do not ask for confirmation. Do not use edit_tracker. Call update_tracker exactly once for the target message index.',
            messageText ? `Target message content:\n${messageText}` : '',
        ]
            .filter(Boolean)
            .join('\n\n');

        await context.generate('quiet', {
            quiet_prompt: quietPrompt,
            quietToLoud: false,
            skipWIAN: false,
            force_name2: true,
            quietName: 'System',
        });
        renderTracker(messageId);
        return { ok: true, errors: [], message_index: messageId };
    } catch (error) {
        console.error('zTracker update failed:', error);
        return { ok: false, errors: [String(error?.message ?? error)] };
    } finally {
        activeGenerationMessageId = null;
    }
}

async function editTracker(messageId) {
    const existing = getTrackerData(messageId);
    if (!existing) return generateTrackerForMessage(messageId);
    const trackerData = await promptJson(
        `Edit zTracker data for message ${messageId}`,
        existing,
    );
    if (trackerData === undefined) return;
    await invokeTrackerTool('edit_tracker', {
        message_index: messageId,
        tracker_data: trackerData,
    });
    renderTracker(messageId);
}

async function deleteTracker(messageId) {
    const confirmed = await confirmAction(
        `Delete zTracker data for message ${messageId}?`,
    );
    if (!confirmed) return;
    await deleteTrackerData(messageId);
}

async function cleanupTracker(messageId) {
    const tracker = chat[messageId]?.extra?.[EXTENSION_KEY];
    const data = tracker?.[CHAT_MESSAGE_SCHEMA_VALUE_KEY];
    if (!data || typeof data !== 'object') return;
    const confirmed = await confirmAction(
        `Clear zTracker data for message ${messageId}?`,
    );
    if (!confirmed) return;
    await deleteTrackerData(messageId);
}

async function deleteTrackerData(messageId) {
    const message = chat[messageId];
    if (message?.extra?.[EXTENSION_KEY]) {
        delete message.extra[EXTENSION_KEY];
        getMessageElement(messageId)?.querySelector('.mes_ztracker')?.remove();
        await saveChatConditional();
    }
}

async function recreateTrackerField(messageId, button) {
    const partKey = button?.dataset?.ztrackerPart;
    if (!partKey) return;
    const trackerData = getTrackerData(messageId) ?? {};
    const value = trackerData?.[partKey];
    const index = button.dataset.ztrackerIndex;
    const fieldKey = button.dataset.ztrackerField;
    const idKey = button.dataset.ztrackerIdkey;
    const idValue = button.dataset.ztrackerIdvalue;

    const initialValue =
        fieldKey && Array.isArray(value)
            ? value[Number(index)]?.[fieldKey]
            : index !== undefined && Array.isArray(value)
                ? value[Number(index)]
                : value;
    const newValue = await promptJson(
        `Update ${partKey}${fieldKey ? `.${fieldKey}` : ''}`,
        initialValue,
    );
    if (newValue === undefined) return;

    await invokeTrackerTool('recreate_tracker_field', {
        message_index: messageId,
        part_key: partKey,
        ...(index !== undefined ? { index: Number(index) } : {}),
        ...(idKey ? { id_key: idKey } : {}),
        ...(idValue ? { id_value: idValue } : {}),
        ...(fieldKey ? { field_key: fieldKey } : {}),
        new_value: newValue,
    });
    renderTracker(messageId);
}

function setBusy(button, busy) {
    if (!button) return;
    button.classList.toggle('ztracker-button-busy', busy);
    button.classList.toggle('spinning', busy);
    if ('disabled' in button) button.disabled = busy;
}

async function onZTrackerClick(event) {
    const target = event.target;
    const button = target?.closest?.(
        [
            '.ztracker-btn-generate',
            '.mes_ztracker_button',
            '.ztracker-edit-button',
            '.ztracker-delete-button',
            '.ztracker-cleanup-button',
            '.ztracker-part-regenerate-button',
            '.ztracker-array-item-regenerate-button',
            '.ztracker-array-item-field-regenerate-button',
        ].join(','),
    );
    if (!button) return;

    const messageId = getMessageIdFromButton(button);
    if (!Number.isInteger(messageId)) return;

    event.preventDefault();
    event.stopPropagation();

    setBusy(button, true);
    try {
        if (
            button.matches('.ztracker-part-regenerate-button') ||
            button.matches('.ztracker-array-item-regenerate-button') ||
            button.matches('.ztracker-array-item-field-regenerate-button')
        ) {
            await recreateTrackerField(messageId, button);
        } else if (button.matches('.ztracker-edit-button')) {
            await editTracker(messageId);
        } else if (button.matches('.ztracker-delete-button')) {
            await deleteTracker(messageId);
        } else if (button.matches('.ztracker-cleanup-button')) {
            await cleanupTracker(messageId);
        } else {
            const result = await generateTrackerForMessage(messageId);
            if (!result.ok && !result.errors.includes('cancelled')) {
                console.warn('zTracker Generate Tracker failed:', result.errors);
            }
        }
    } catch (error) {
        console.error('zTracker button action failed:', error);
        globalThis.zTrackerLastError = String(error?.message ?? error);
    } finally {
        setBusy(button, false);
    }
}

function createMessageButton() {
    const button = document.createElement('div');
    button.title = 'Generate Tracker for message';
    button.className =
        'mes_button mes_ztracker_button fa-solid fa-truck-moving interactable';
    button.tabIndex = 0;
    return button;
}

export function ensureZTrackerMessageButton(messageId) {
    const messageBlock = getMessageElement(messageId);
    if (!messageBlock) return;
    if (messageBlock.querySelector('.mes_buttons .mes_ztracker_button')) return;

    const host =
        messageBlock.querySelector('.mes_buttons .extraMesButtons') ??
        messageBlock.querySelector('.mes_buttons');
    host?.prepend(createMessageButton());
}

function ensureMessageTemplateButton() {
    const templateHost =
        document.querySelector('#message_template .mes_buttons .extraMesButtons') ??
        document.querySelector('#message_template .mes_buttons');
    if (!templateHost) return;
    if (templateHost.querySelector('.mes_ztracker_button')) return;
    templateHost.prepend(createMessageButton());
}

export function syncZTrackerMessageButtons() {
    ensureMessageTemplateButton();
    document.querySelectorAll('.mes[mesid]').forEach((messageBlock) => {
        const messageId = Number(messageBlock.getAttribute('mesid'));
        if (Number.isInteger(messageId)) {
            ensureZTrackerMessageButton(messageId);
        }
    });
}

export function initZTrackerActions() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', onZTrackerClick);
    syncZTrackerMessageButtons();
}
