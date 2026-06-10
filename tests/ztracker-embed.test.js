import { describe, expect, test } from '@jest/globals';
import {
    CHAT_MESSAGE_SCHEMA_VALUE_KEY,
    EXTENSION_KEY,
    includeZTrackerMessages,
} from '../public/scripts/extensions/ztracker/embed.js';

const trackerExtra = (value) => ({
    [EXTENSION_KEY]: {
        [CHAT_MESSAGE_SCHEMA_VALUE_KEY]: value,
    },
});

const toonSettings = {
    includeLastXZTrackerMessages: 1,
    embedZTrackerRole: 'user',
    embedZTrackerAsCharacter: false,
    embedZTrackerSnapshotHeader: 'Tracker:',
    embedZTrackerSnapshotTransformPreset: 'toon',
    embedZTrackerSnapshotTransformPresets: {
        toon: {
            input: 'toon',
            codeFenceLang: 'toon',
            wrapInCodeFence: true,
        },
    },
};

describe('zTracker embedded prompt snapshots', () => {
    test('does not inject a duplicate snapshot when message already contains it', () => {
        const messages = [
            {
                role: 'assistant',
                is_user: false,
                mes: 'Tracker:\n```toon\ntime: noon\n```',
                extra: trackerExtra({ time: 'noon' }),
            },
        ];

        const result = includeZTrackerMessages(messages, toonSettings);

        expect(result).toHaveLength(1);
        expect(result[0].mes).toBe('Tracker:\n```toon\ntime: noon\n```');
    });

    test('embedded synthetic snapshot has no name when character embedding is disabled', () => {
        const messages = [
            {
                role: 'assistant',
                is_user: false,
                mes: 'Story text',
                extra: trackerExtra({ time: 'noon' }),
            },
        ];

        const result = includeZTrackerMessages(messages, toonSettings);

        expect(result).toHaveLength(2);
        expect(result[1].mes).toBe('Tracker:\n```toon\ntime: noon\n```');
        expect(result[1]).not.toHaveProperty('name');
    });

    test('replaces adjacent stale embedded snapshot instead of appending another', () => {
        const messages = [
            {
                role: 'assistant',
                is_user: false,
                mes: 'Story text',
                extra: trackerExtra({ time: 'noon' }),
            },
            {
                role: 'user',
                is_user: true,
                mes: 'Tracker:\n```toon\ntime: morning\n```',
                content: 'Tracker:\n```toon\ntime: morning\n```',
                extra: { zTrackerEmbeddedSnapshot: true },
            },
        ];

        const result = includeZTrackerMessages(messages, toonSettings);

        expect(result).toHaveLength(2);
        expect(result[1].mes).toBe('Tracker:\n```toon\ntime: noon\n```');
    });

    test('uses legacy snapshot header and format settings', () => {
        const messages = [
            {
                role: 'assistant',
                is_user: false,
                mes: 'Story text',
                extra: trackerExtra({ time: 'noon' }),
            },
        ];
        const settings = {
            ...toonSettings,
            embedZTrackerSnapshotHeader: undefined,
            embedZTrackerSnapshotTransformPreset: undefined,
            embedSnapshotHeader: 'Legacy Tracker:',
            embedSnapshotFormat: 'top_level_lines',
        };

        const result = includeZTrackerMessages(messages, settings);

        expect(result).toHaveLength(2);
        expect(result[1].mes).toBe('Legacy Tracker:\ntime: "noon"\n');
    });

    test('does not duplicate raw terminal assistant snapshots', () => {
        const settings = { ...toonSettings, embedZTrackerRole: 'assistant' };
        const messages = [
            {
                role: 'user',
                is_user: true,
                mes: 'Tracker:\n```toon\ntime: noon\n```\nAssistant:',
                extra: trackerExtra({ time: 'noon' }),
            },
            {
                role: 'assistant',
                is_user: false,
                mes: '',
                content: '',
                name: 'Assistant',
            },
        ];

        const result = includeZTrackerMessages(messages, settings, {
            preserveTextCompletionTurnAlternation: true,
            assistantReplyLabel: 'Assistant',
        });

        expect(result).toHaveLength(2);
        expect(result[0].mes).toBe(
            'Tracker:\n```toon\ntime: noon\n```\nAssistant:',
        );
    });
});
