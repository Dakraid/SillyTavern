'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/services/CardCreator.js`.
 *
 * Covers both entry points of the shared creation pipeline:
 *
 * - `createGeneratedGroupCard` — the legacy signature, replaying the
 *   behavior pinned by the (environmentally Node-incompatible)
 *   bulk-edit-overlay.test.js scenarios: lorebook-skip, full
 *   lorebook+character+link order, wizard metadata embedding, and the
 *   collision rename flow;
 * - `createGroupCardFromTask` — the Step 11g task-friendly wrapper: review
 *   edits winning over payload defaults, snapshot-sourced characters,
 *   verbatim assembled lorebook data, composite-avatar application, and
 *   non-fatal avatar failures.
 *
 * The import chain (script.js / utils.js / world-info.js / popup.js /
 * JobClient.js) is mocked; `group-card-xml-parser.js` and `helpers.js`
 * load for real (helpers.js only needs the mocked chain above).
 */

import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

/** @type {object[]} Mutable roster backing the mocked `characters` export. */
const mockCharacters = [];

/** @type {string[]} Mutable lorebook-name list backing `world_names`. */
const mockWorldNames = [];

/** @type {jest.Mock} Mocked collision popup. */
const mockCallGenericPopup = jest.fn(async () => null);

/** @type {jest.Mock} Mocked JSON request transport. */
const mockSendJsonRequest = jest.fn();

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    substituteParams: (value) => String(value ?? ''),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }),
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (value) => String(value ?? ''),
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
    world_names: mockWorldNames,
    // Plain object constant (helpers.js structuredClones it) — NOT a factory.
    newWorldInfoEntryTemplate: {},
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: mockCallGenericPopup,
    POPUP_TYPE: { DISPLAY: 0, TEXT: 1, CONFIRM: 2, INPUT: 4 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/JobClient.js', () => ({
    sendJsonRequest: mockSendJsonRequest,
    throwIfNotOk: async (response, fallback) => {
        if (response?.ok) {
            return response;
        }
        const text = typeof response?.text === 'function' ? await response.text() : '';
        throw new Error(text ? `${fallback} ${text}` : String(fallback));
    },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds an ok JSON-transport response whose body text is `text`. */
function okResponse(text = '') {
    return { ok: true, text: async () => text, json: async () => (text ? JSON.parse(text) : {}) };
}

/** Reads the parsed JSON body of the n-th sendJsonRequest call. */
function callBody(index) {
    return mockSendJsonRequest.mock.calls[index]?.[1];
}

/** Reads the URL of the n-th sendJsonRequest call. */
function callUrl(index) {
    return mockSendJsonRequest.mock.calls[index]?.[0];
}

function makeSources() {
    return [
        { key: 'alice.png', name: 'Alice', avatar: 'alice.png', fields: { name: 'Alice', description: 'A.' } },
        { key: 'bob.png', name: 'Bob', avatar: 'bob.png', fields: { name: 'Bob', description: 'B.' } },
    ];
}

function makeTask(overrides = {}) {
    return {
        id: 'task-1',
        sources: makeSources(),
        settings: { destination: 'card' },
        review: {},
        ...overrides,
    };
}

function makePayload(overrides = {}) {
    return {
        destination: 'card',
        cardBlocks: [{ name: 'Alice' }, { name: 'Bob' }],
        mergedDescription: 'Merged.',
        post: { enabled: false, output: '' },
        lorebookData: { entries: {} },
        ...overrides,
    };
}

let createGeneratedGroupCard;
let createGroupCardFromTask;

beforeAll(async () => {
    ({ createGeneratedGroupCard, createGroupCardFromTask } = await import('../../public/scripts/bulk-combine/services/CardCreator.js'));
});

beforeEach(() => {
    mockCharacters.length = 0;
    mockWorldNames.length = 0;
    global.fetch = jest.fn(async () => okResponse());
    global.FormData = class {
        constructor() {
            this.entries = [];
        }

        append(...args) {
            this.entries.push(args);
        }
    };
});

afterEach(() => {
    jest.clearAllMocks();
    delete global.fetch;
    delete global.FormData;
});

// ---------------------------------------------------------------------------
// createGeneratedGroupCard (legacy signature — refactor contract)
// ---------------------------------------------------------------------------

describe('createGeneratedGroupCard', () => {
    test('skips lorebook creation and link when requested', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('{"avatar":"group.png"}'));

        await expect(
            createGeneratedGroupCard('Group', '<character>Group</character>', [{ name: 'Alice' }, { name: 'Bob' }], false),
        ).resolves.toEqual({ avatar: 'group.png', world: '' });

        expect(mockSendJsonRequest).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe('/api/characters/create');
        expect(callBody(0).extensions).toEqual({ world: '' });
    });

    test('creates lorebook, character, and link by default', async () => {
        mockSendJsonRequest
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce(okResponse('group.png'))
            .mockResolvedValueOnce(okResponse());

        await expect(
            createGeneratedGroupCard('Group', '<character>Group</character>', [{ name: 'Alice' }, { name: 'Bob' }]),
        ).resolves.toEqual({ avatar: 'group.png', world: 'Group' });

        expect(mockSendJsonRequest.mock.calls.map((call) => call[0])).toEqual([
            '/api/worldinfo/edit',
            '/api/characters/create',
            '/api/characters/merge-attributes',
        ]);
        expect(callBody(2)).toEqual({ avatar: 'group.png', data: { extensions: { world: 'Group' } } });
    });

    test('embeds rerun metadata and greeting fields in the created card', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('{"avatar":"group.png"}'));
        const wizardMeta = {
            version: 1,
            sourceCharacterNames: ['Alice', 'Bob'],
            sourceCharacterAvatars: ['alice.png', 'bob.png'],
            config: { prompt: 'Transform' },
            createdAt: '2026-08-02T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
            runCount: 1,
        };

        await expect(
            createGeneratedGroupCard(
                'Group',
                '<character>Group</character>',
                [{ name: 'Alice' }, { name: 'Bob' }],
                false,
                undefined,
                false,
                '<character>Group</character>',
                wizardMeta,
                false,
                false,
                'Welcome.',
                ['Hello.', 'Greetings.'],
            ),
        ).resolves.toEqual({ avatar: 'group.png', world: '' });

        expect(callBody(0).first_mes).toBe('Welcome.');
        expect(callBody(0).alternate_greetings).toEqual(['Hello.', 'Greetings.']);
        expect(callBody(0).creator_notes).toContain('[group_card_wizard]');
        expect(callBody(0).creator_notes).toContain('Alice, Bob');
        expect(callBody(0).extensions.group_card_wizard).toEqual(wizardMeta);
    });

    test('renames automatically on collision when the user declines overwrite', async () => {
        mockCharacters.push({ name: 'Group', avatar: 'existing.png' });
        mockWorldNames.push('Group');
        mockCallGenericPopup.mockResolvedValueOnce(null); // "Rename Automatically"
        mockSendJsonRequest
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce(okResponse('renamed.png'))
            .mockResolvedValueOnce(okResponse());

        await expect(
            createGeneratedGroupCard('Group', 'desc', [{ name: 'Alice' }, { name: 'Bob' }]),
        ).resolves.toEqual({ avatar: 'renamed.png', world: 'Group (1)' });

        expect(mockCallGenericPopup).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe('/api/worldinfo/edit');
        expect(callBody(0).name).toBe('Group (1)');
        expect(callBody(1).name).toBe('Group (1)');
    });

    test('overwrites on collision when the user confirms', async () => {
        mockCharacters.push({ name: 'Group', avatar: 'existing.png' });
        mockCallGenericPopup.mockResolvedValueOnce(1); // POPUP_RESULT.AFFIRMATIVE
        mockSendJsonRequest.mockResolvedValueOnce(okResponse());

        await expect(
            createGeneratedGroupCard('Group', 'desc', [{ name: 'Alice' }, { name: 'Bob' }], false),
        ).resolves.toEqual({ avatar: 'existing.png', world: '' });

        // Overwrite path: merge-attributes on the existing avatar, no create.
        expect(mockSendJsonRequest).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe('/api/characters/merge-attributes');
        expect(callBody(0).avatar).toBe('existing.png');
    });
});

// ---------------------------------------------------------------------------
// createGroupCardFromTask (Step 11g task wrapper)
// ---------------------------------------------------------------------------

describe('createGroupCardFromTask', () => {
    test('card destination: review edits win, no lorebook, snapshot-sourced characters', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('{"avatar":"group.png"}'));
        const task = makeTask({ review: { name: 'My Group', description: 'Edited description.' } });

        const result = await createGroupCardFromTask(task, makePayload(), null);

        expect(result).toEqual({
            characterName: 'My Group',
            characterAvatar: 'group.png',
            lorebookName: '',
            avatarError: '',
        });
        expect(mockSendJsonRequest).toHaveBeenCalledTimes(1);
        expect(callUrl(0)).toBe('/api/characters/create');
        expect(callBody(0).name).toBe('My Group');
        expect(callBody(0).description).toBe('Edited description.');
        expect(callBody(0).creator_notes).toBe('Generated group card from: Alice, Bob');
        expect(callBody(0).creator_notes).not.toContain('[group_card_wizard]');
        expect(callBody(0).extensions).toEqual({ world: '' });
        expect(global.fetch).not.toHaveBeenCalled(); // no avatar data URL
    });

    test('falls back to the assembled defaults when the review carries no edits', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('group.png'));

        const result = await createGroupCardFromTask(makeTask(), makePayload({ mergedDescription: 'Assembled.' }), null);

        expect(result.characterName).toBe('Alice + Bob');
        expect(callBody(0).description).toBe('Assembled.');
    });

    test('post-processed output is the description default when enabled', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('group.png'));
        const payload = makePayload({ post: { enabled: true, output: 'CLEAN.' }, mergedDescription: 'merged' });

        await createGroupCardFromTask(makeTask(), payload, null);
        expect(callBody(0).description).toBe('CLEAN.');
    });

    test('lorebook destination uses the assembled lorebook data verbatim and links it', async () => {
        mockSendJsonRequest
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce(okResponse('group.png'))
            .mockResolvedValueOnce(okResponse());
        const lorebookData = { entries: { '0': { comment: 'Entry A', key: ['a'], content: 'A body' } } };
        const task = makeTask({ settings: { destination: 'lorebook' } });

        const result = await createGroupCardFromTask(task, makePayload({ destination: 'lorebook', lorebookData }), null);

        expect(result.lorebookName).toBe('Alice + Bob');
        expect(mockSendJsonRequest.mock.calls.map((call) => call[0])).toEqual([
            '/api/worldinfo/edit',
            '/api/characters/create',
            '/api/characters/merge-attributes',
        ]);
        expect(callBody(0)).toEqual({ name: 'Alice + Bob', data: lorebookData });
        expect(callBody(2)).toEqual({ avatar: 'group.png', data: { extensions: { world: 'Alice + Bob' } } });
    });

    test('task.review.lorebookData overrides the payload lorebook data', async () => {
        mockSendJsonRequest
            .mockResolvedValueOnce(okResponse())
            .mockResolvedValueOnce(okResponse('group.png'))
            .mockResolvedValueOnce(okResponse());
        const reviewLorebook = { entries: { '0': { comment: 'Edited', key: ['e'], content: 'E body' } } };
        const task = makeTask({
            settings: { destination: 'lorebook' },
            review: { lorebookData: reviewLorebook },
        });

        await createGroupCardFromTask(task, makePayload({ destination: 'lorebook' }), null);
        expect(callBody(0).data).toBe(reviewLorebook);
    });

    test('applies the composite avatar via /api/characters/edit-avatar', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('group.png'));
        global.fetch
            .mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['png']) }) // data URL read
            .mockResolvedValueOnce(okResponse()); // edit-avatar

        const result = await createGroupCardFromTask(makeTask(), makePayload(), 'data:image/png;base64,COMPOSED');

        expect(result.avatarError).toBe('');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[0][0]).toBe('data:image/png;base64,COMPOSED');
        expect(global.fetch.mock.calls[1][0]).toBe('/api/characters/edit-avatar');
        expect(global.fetch.mock.calls[1][1].method).toBe('POST');
        expect(global.fetch.mock.calls[1][1].headers['Content-Type']).toBe(undefined);
        const formData = global.fetch.mock.calls[1][1].body;
        expect(formData.entries.map((entry) => entry[0])).toEqual(['avatar_url', 'avatar']);
        expect(formData.entries[0][1]).toBe('group.png');
    });

    test('an avatar application failure is non-fatal and reported via avatarError', async () => {
        mockSendJsonRequest.mockResolvedValueOnce(okResponse('group.png'));
        global.fetch.mockRejectedValueOnce(new Error('blob read failed'));

        const result = await createGroupCardFromTask(makeTask(), makePayload(), 'data:image/png;base64,COMPOSED');

        expect(result.characterAvatar).toBe('group.png'); // card still created
        expect(result.avatarError).toContain('blob read failed');
    });

    test('throws when the request is invalid (no name, fewer than two sources)', async () => {
        const noName = makeTask({ review: { name: '' } });
        await expect(createGroupCardFromTask(noName, makePayload({ cardBlocks: [] }), null))
            .rejects.toThrow('no longer valid');

        const oneSource = makeTask({ sources: [makeSources()[0]] });
        await expect(createGroupCardFromTask(oneSource, makePayload(), null))
            .rejects.toThrow('no longer valid');

        expect(mockSendJsonRequest).not.toHaveBeenCalled();
    });

    test('rolls back the lorebook when character creation fails', async () => {
        mockSendJsonRequest
            .mockResolvedValueOnce(okResponse()) // lorebook created
            .mockResolvedValueOnce({ ok: false, text: async () => 'db exploded' }) // create fails
            .mockResolvedValueOnce(okResponse()); // rollback delete
        const task = makeTask({ settings: { destination: 'lorebook' } });

        await expect(createGroupCardFromTask(task, makePayload({ destination: 'lorebook' }), null))
            .rejects.toThrow('db exploded');

        expect(callUrl(2)).toBe('/api/worldinfo/delete');
    });
});
