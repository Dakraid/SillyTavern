import {
    chat,
    chat_metadata,
    eventSource,
    event_types,
} from '../../../script.js';
import { getZTrackerSettings } from './config.js';
import { initZTrackerEmbedInterceptor } from './embed.js';
import { EXTENSION_KEY } from './metadata.js';
import { renderTracker } from './tracker.js';
import { registerTrackerTools } from './tools.js';
import { initAutoRetry } from './auto-retry.js';
import { initZTrackerActions } from './actions.js';
import { initZTrackerSettings } from './settings.js';

let initialized = false;

function rerenderTrackersForCurrentChat() {
    for (let index = 0; index < chat.length; index++) {
        if (chat[index]?.extra?.[EXTENSION_KEY]) {
            renderTracker(index);
        }
    }
}

function ensureChatMetadata() {
    chat_metadata[EXTENSION_KEY] = chat_metadata[EXTENSION_KEY] || {};
}

export async function initZTracker() {
    if (initialized) return;
    initialized = true;

    getZTrackerSettings();
    ensureChatMetadata();
    initZTrackerEmbedInterceptor({ getSettings: getZTrackerSettings });
    registerTrackerTools();
    initAutoRetry();
    initZTrackerActions();
    await initZTrackerSettings();

    eventSource?.on?.(event_types.CHAT_CHANGED, () => {
        ensureChatMetadata();
        setTimeout(rerenderTrackersForCurrentChat, 0);
    });
    const renderMessageTracker = (messageId) => {
        if (
            typeof messageId === 'number' &&
            chat[messageId]?.extra?.[EXTENSION_KEY]
        ) {
            renderTracker(messageId);
        }
    };
    eventSource?.on?.(event_types.USER_MESSAGE_RENDERED, renderMessageTracker);
    eventSource?.on?.(
        event_types.CHARACTER_MESSAGE_RENDERED,
        renderMessageTracker,
    );
}

export async function init() {
    await initZTracker();
}

export { getZTrackerSettings } from './config.js';
export * from './metadata.js';
export * from './tracker.js';
