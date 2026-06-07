import { chat, eventSource, event_types, main_api } from '../../../script.js';
import { getContext } from '../../extensions.js';
import { AUTO_MODE, getZTrackerSettings } from './config.js';

const TRACKER_TOOL_NAMES = Object.freeze([
    'update_tracker',
    'recreate_tracker_field',
    'cleanup_tracker',
    'edit_tracker',
]);

const TRACKER_TOOL_NAME_SET = new Set(TRACKER_TOOL_NAMES);
const RETRY_DELAY_MS = 0;
const MAX_RETRIED_IDS = 100;
const MAX_SESSION_RETRIES = 3;

let initialized = false;
let retryInProgress = false;
let sessionRetryCount = 0;
const retriedMessageIds = new Set();

function isChatCompletion() {
    const context = getContext?.();
    return main_api === 'openai' || context?.mainApi === 'openai';
}

function isAutoUpdateEnabled(settings) {
    return (
        settings?.enabled &&
        [AUTO_MODE.OUTPUT, AUTO_MODE.BOTH, 'output', 'both'].includes(
            settings.autoMode,
        )
    );
}

function getToolInvocations(message) {
    const invocations = message?.extra?.tool_invocations;
    return Array.isArray(invocations) ? invocations : [];
}

function isTrackerInvocation(invocation) {
    return TRACKER_TOOL_NAME_SET.has(invocation?.name);
}

function hadTrackerToolCall(messageId) {
    const message = chat[messageId];
    if (getToolInvocations(message).some(isTrackerInvocation)) {
        return true;
    }

    // Tool result messages can be appended after the assistant message. Check the
    // following message as well after the deferred event tick.
    const nextMessage = chat[messageId + 1];
    return getToolInvocations(nextMessage).some(isTrackerInvocation);
}

function shouldRetry(messageId) {
    if (retryInProgress) return false;
    if (sessionRetryCount >= MAX_SESSION_RETRIES) return false;
    if (!Number.isInteger(messageId)) return false;
    if (retriedMessageIds.has(messageId)) return false;
    if (!isChatCompletion()) return false;

    const settings = getZTrackerSettings();
    if (!isAutoUpdateEnabled(settings)) return false;

    const message = chat[messageId];
    if (!message || message.is_user || message.is_system) return false;

    return !hadTrackerToolCall(messageId);
}

async function retryTrackerUpdate(messageId) {
    if (!shouldRetry(messageId)) return;

    retryInProgress = true;
    sessionRetryCount += 1;
    if (retriedMessageIds.size >= MAX_RETRIED_IDS) {
        const toRemove = [...retriedMessageIds].slice(0, MAX_RETRIED_IDS / 2);
        toRemove.forEach((id) => retriedMessageIds.delete(id));
    }
    retriedMessageIds.add(messageId);

    try {
        const context = getContext?.();
        if (typeof context?.generate !== 'function') {
            throw new Error('SillyTavern context.generate is unavailable');
        }

        await context.generate(undefined, { automatic_trigger: true });
    } catch (error) {
        console.error('zTracker auto-retry failed:', error);
    } finally {
        retryInProgress = false;
    }
}

function onMessageSent() {
    sessionRetryCount = 0;
}

function onCharacterMessageRendered(messageId) {
    setTimeout(() => {
        void retryTrackerUpdate(messageId);
    }, RETRY_DELAY_MS);
}

export function initAutoRetry() {
    if (initialized) return;
    initialized = true;

    const context = getContext?.();
    const source = context?.eventSource || eventSource;
    const events = context?.eventTypes || context?.event_types || event_types;
    const characterMessageRenderedEventName =
        events?.CHARACTER_MESSAGE_RENDERED || 'character_message_rendered';
    const messageSentEventName = events?.MESSAGE_SENT || 'message_sent';

    source?.on?.(characterMessageRenderedEventName, onCharacterMessageRendered);
    source?.on?.(messageSentEventName, onMessageSent);
}
