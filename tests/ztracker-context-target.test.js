import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const chat = [];

jest.unstable_mockModule('../public/script.js', () => ({
    chat,
    eventSource: { on: jest.fn() },
    event_types: {},
    generateRawData: jest.fn(),
    saveChatConditional: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_TYPE: { TEXT: 'text' },
    callGenericPopup: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
    ToolManager: {
        tools: [],
        invokeFunctionTool: jest.fn(),
    },
}));

jest.unstable_mockModule('../public/lib.js', () => ({
    Handlebars: { compile: jest.fn(() => jest.fn()) },
}));

jest.unstable_mockModule(
    '../public/scripts/extensions/ztracker/config.js',
    () => ({
        getActiveSchemaPreset: jest.fn(),
        getZTrackerSettings: jest.fn(() => ({})),
    }),
);

jest.unstable_mockModule(
    '../public/scripts/extensions/ztracker/cleanup.js',
    () => ({
        addPendingRedactions: jest.fn(),
        clearPendingRedactions: jest.fn(),
    }),
);

jest.unstable_mockModule(
    '../public/scripts/extensions/ztracker/tracker.js',
    () => ({
        applyTrackerUpdateAndRender: jest.fn(),
        getSchemaRenderMetadata: jest.fn(() => ({})),
        renderTracker: jest.fn(),
    }),
);

const { CHAT_MESSAGE_SCHEMA_VALUE_KEY, EXTENSION_KEY } = await import(
    '../public/scripts/extensions/ztracker/metadata.js'
);
const { buildGenerationContext } = await import(
    '../public/scripts/extensions/ztracker/actions.js'
);
const { resolveActiveTrackerTarget, setActiveTrackerTarget } = await import(
    '../public/scripts/extensions/ztracker/tools.js'
);

const trackerExtra = (value) => ({
    [EXTENSION_KEY]: {
        [CHAT_MESSAGE_SCHEMA_VALUE_KEY]: value,
    },
});

const userMessage = (mes, extra = {}) => ({
    role: 'user',
    is_user: true,
    mes,
    extra,
});

const assistantMessage = (mes, extra = {}) => ({
    role: 'assistant',
    is_user: false,
    mes,
    extra,
});

const systemMessage = (mes) => ({
    role: 'system',
    is_system: true,
    mes,
});

describe('zTracker message-action context', () => {
    describe('messages strategy', () => {
        test('returns the last N non-system messages before the target', () => {
            const messages = [
                userMessage('one'),
                systemMessage('system'),
                assistantMessage('two'),
                userMessage('three'),
                assistantMessage('target'),
            ];

            const result = buildGenerationContext(messages, 4, {
                generateContextStrategy: 'messages',
                generateContextMessageCount: 3,
            });

            expect(result.map((entry) => entry.index)).toEqual([2, 3]);
            expect(result.map((entry) => entry.message.mes)).toEqual([
                'two',
                'three',
            ]);
        });

        test('returns an empty context when targetId is 0', () => {
            const messages = [assistantMessage('target')];

            expect(
                buildGenerationContext(messages, 0, {
                    generateContextStrategy: 'messages',
                    generateContextMessageCount: 3,
                }),
            ).toEqual([]);
        });

        test('returns an empty context for empty chat', () => {
            expect(
                buildGenerationContext([], 0, {
                    generateContextStrategy: 'messages',
                    generateContextMessageCount: 3,
                }),
            ).toEqual([]);
        });

        test('returns all available prior non-system messages when N is larger than available', () => {
            const messages = [
                systemMessage('system'),
                userMessage('one'),
                assistantMessage('two'),
                userMessage('target'),
            ];

            const result = buildGenerationContext(messages, 3, {
                generateContextStrategy: 'messages',
                generateContextMessageCount: 99,
            });

            expect(result.map((entry) => entry.index)).toEqual([1, 2]);
        });
    });

    describe('trackers strategy', () => {
        test('walks back to the Nth prior tracker and includes messages between in chronological order', () => {
            const firstTracker = { mood: 'calm' };
            const messages = [
                userMessage('before'),
                assistantMessage('first tracked', trackerExtra(firstTracker)),
                userMessage('between'),
                assistantMessage('target'),
            ];

            const result = buildGenerationContext(messages, 3, {
                generateContextStrategy: 'trackers',
                generateContextTrackerCount: 1,
                generateContextMessageCount: 2,
            });

            expect(result.map((entry) => entry.index)).toEqual([1, 2]);
            expect(result[0].trackerValue).toBe(firstTracker);
        });

        test('includes two trackers when count is 2 and at least two prior trackers exist', () => {
            const firstTracker = { scene: 'start' };
            const secondTracker = { scene: 'middle' };
            const messages = [
                userMessage('ignored before earliest tracker'),
                assistantMessage('first tracked', trackerExtra(firstTracker)),
                userMessage('between one'),
                assistantMessage('second tracked', trackerExtra(secondTracker)),
                userMessage('between two'),
                assistantMessage('target'),
            ];

            const result = buildGenerationContext(messages, 5, {
                generateContextStrategy: 'trackers',
                generateContextTrackerCount: 2,
                generateContextMessageCount: 2,
            });

            expect(result.map((entry) => entry.index)).toEqual([1, 2, 3, 4]);
            expect(
                result
                    .filter((entry) => entry.trackerValue)
                    .map((entry) => entry.trackerValue),
            ).toEqual([firstTracker, secondTracker]);
        });

        test('falls back to message count when there are zero prior trackers', () => {
            const messages = [
                userMessage('one'),
                assistantMessage('two'),
                userMessage('three'),
                assistantMessage('target'),
            ];

            const result = buildGenerationContext(messages, 3, {
                generateContextStrategy: 'trackers',
                generateContextTrackerCount: 2,
                generateContextMessageCount: 2,
            });

            expect(result.map((entry) => entry.index)).toEqual([1, 2]);
            expect(result.every((entry) => entry.trackerValue === undefined)).toBe(
                true,
            );
        });

        test('marks tracker values on returned context entries', () => {
            const tracker = { location: 'bridge' };
            const messages = [
                assistantMessage('tracked', trackerExtra(tracker)),
                userMessage('target'),
            ];

            const result = buildGenerationContext(messages, 1, {
                generateContextStrategy: 'trackers',
                generateContextTrackerCount: 1,
            });

            expect(result).toHaveLength(1);
            expect(result[0]).toMatchObject({ index: 0, trackerValue: tracker });
        });
    });
});

describe('zTracker target resolution', () => {
    beforeEach(() => {
        setActiveTrackerTarget(null);
    });

    test('returns the latest assistant message when no active target is set', () => {
        const messages = [
            userMessage('one'),
            assistantMessage('two'),
            userMessage('three'),
            assistantMessage('four'),
        ];

        expect(resolveActiveTrackerTarget(messages)).toBe(3);
    });

    test('returns the active target when one is set', () => {
        setActiveTrackerTarget(3);

        expect(resolveActiveTrackerTarget([userMessage('one')])).toBe(3);
    });

    test('returns null for chats with only user or system messages', () => {
        setActiveTrackerTarget(null);

        expect(
            resolveActiveTrackerTarget([
                systemMessage('system'),
                userMessage('user'),
            ]),
        ).toBeNull();
    });

    test('returns null for empty chat', () => {
        setActiveTrackerTarget(null);

        expect(resolveActiveTrackerTarget([])).toBeNull();
    });
});
