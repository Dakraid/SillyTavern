import { chat } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { getActiveSchemaPreset, getZTrackerSettings } from './config.js';
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

function getGenerateFunction(context) {
    if (typeof context?.generate === 'function') {
        return context.generate.bind(context);
    }
    /** @type {any} */
    const globalContext = globalThis.SillyTavern?.getContext?.();
    const globalGenerate = globalContext?.generate;
    if (typeof globalGenerate === 'function') {
        return globalGenerate.bind(globalContext);
    }
    throw new Error('SillyTavern generate() is unavailable.');
}

function buildTrackerGenerationPrompt(messageId) {
    return [
        `Update zTracker state for chat message index ${messageId}.`,
        `Call the update_tracker tool with message_index ${messageId}.`,
        'Use complete tracker_data matching the active zTracker schema.',
        'If existing tracker data is present, update it from the current conversation context.',
        'Do not ask the user for confirmation before calling update_tracker.',
    ].join('\n');
}

/**
 * Trigger a model pass that updates tracker data for one message through the update_tracker tool.
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
        return { ok: false, errors: ['No active zTracker schema preset configured.'] };
    }

    if (activeGenerationMessageId !== null) {
        return {
            ok: false,
            errors: [`Tracker generation already in progress for message ${activeGenerationMessageId}.`],
        };
    }

    const context = getContext?.() ?? globalThis.SillyTavern?.getContext?.();
    const generate = getGenerateFunction(context);
    activeGenerationMessageId = messageId;

    try {
        await generate(undefined, {
            automatic_trigger: true,
            quiet_prompt: buildTrackerGenerationPrompt(messageId),
            quietToLoud: true,
        });
        renderTracker(messageId);
        return { ok: true, errors: [], message_index: messageId };
    } catch (error) {
        console.error('zTracker Generate Tracker failed:', error);
        return { ok: false, errors: [String(error?.message ?? error)] };
    } finally {
        activeGenerationMessageId = null;
    }
}

function getMessageIdFromButton(button) {
    const raw = button?.dataset?.mesid;
    if (raw !== undefined) {
        return Number(raw);
    }
    const messageBlock = button?.closest?.('.mes');
    return Number(messageBlock?.getAttribute?.('mesid'));
}

async function onGenerateButtonClick(event) {
    const button = event.target?.closest?.('.ztracker-btn-generate');
    if (!button) {
        return;
    }

    event.preventDefault();
    event.stopPropagation();

    const messageId = getMessageIdFromButton(button);
    button.disabled = true;
    button.classList.add('ztracker-button-busy');
    try {
        const result = await generateTrackerForMessage(messageId);
        if (!result.ok) {
            console.warn('zTracker Generate Tracker failed:', result.errors);
        }
    } finally {
        button.disabled = false;
        button.classList.remove('ztracker-button-busy');
    }
}

export function initZTrackerActions() {
    if (initialized) return;
    initialized = true;
    document.addEventListener('click', onGenerateButtonClick);
}
