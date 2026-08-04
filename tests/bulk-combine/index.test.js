'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/index.js` (task-creation
 * entry). Covers:
 *
 * - characters are unshallowed BEFORE their core payloads are snapshotted
 *   (lazy loading must not yield empty durable source snapshots);
 * - the legacy metadata-rerun seam is gone (no rerunConfig seeding);
 * - the client handed to the wizard persists resolved token windows to
 *   `task.settings` before a pass run (server preflight seam).
 *
 * `resolveCompletionSettings.js` (the decorator source) loads for real; all
 * other bulk-combine modules and the script.js chain are mocked.
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

/** @type {jest.Mock} Mocked `unshallowCharacter` (script.js). */
const mockUnshallowCharacter = jest.fn(async () => {});

/** @type {jest.Mock} Mocked `openTaskWizard` (TaskWizardController.js). */
const mockOpenTaskWizard = jest.fn(async () => {});

/** @type {jest.Mock} Mocked `openTaskHistoryPopup` (TaskWizardController.js). */
const mockOpenTaskHistoryPopup = jest.fn(async () => {});

/**
 * Fake TaskClient instance returned by `createTaskClient`. Rebuilt per test:
 * the window-persistence decorator mutates the instance (own-property
 * shadow), so a shared singleton would leak its non-mock wrapper between
 * tests.
 *
 * @type {object}
 */
let mockClient;

/** Builds a fresh fake TaskClient. */
function makeMockClient() {
    return {
        createTask: jest.fn(async ({ name }) => ({ id: 'task-1', name, revision: 1 })),
        patchTask: jest.fn(async (id, patch) => ({ id, ...patch })),
        runPass: jest.fn(async () => ({ status: 'accepted' })),
    };
}

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    unshallowCharacter: mockUnshallowCharacter,
    substituteParams: (value) => String(value ?? ''),
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: {},
    openai_settings: [],
    proxies: [],
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/helpers.js', () => ({
    CORE_CHARACTER_FIELDS: ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'],
    ALWAYS_INCLUDED_CHARACTER_FIELDS: ['name', 'description'],
    OPTIONAL_CHARACTER_FIELDS: ['personality', 'scenario', 'first_mes', 'mes_example'],
    GROUP_CARD_WIZARD_METADATA_KEY: 'group_card_wizard',
    getGroupCardWizardMetadata: jest.fn(),
    normalizeSelectedFields: (fields) => fields,
    normalizeName: (name) => String(name ?? '').trim().toLowerCase(),
    // Faithful minimal mirrors (the entry point's behavior depends on these).
    getCharacterName: (character) => character?.name ?? character?.ch_name ?? '',
    getValidSelectedCharacters: (selected) => selected,
    getCoreCharacterField: (character, field) => String(character?.[field] ?? ''),
    getCoreCharacterPayload: (character) => ({
        name: String(character?.name ?? ''),
        description: String(character?.description ?? ''),
        personality: String(character?.personality ?? ''),
        scenario: String(character?.scenario ?? ''),
        first_mes: String(character?.first_mes ?? ''),
        mes_example: String(character?.mes_example ?? ''),
    }),
    buildCoreCharacterPromptBlock: jest.fn(),
    buildGroupCardCombineQuietPrompt: jest.fn(),
    formatLorebookSummaryField: jest.fn(),
    buildLorebookEntryContent: jest.fn(),
    buildLorebookEntry: jest.fn(),
    buildLorebookData: jest.fn(),
    extractAllTopLevelXmlBlocks: jest.fn(),
    extractCharacterNameFromBlock: jest.fn(),
    extractGeneratedCharacterBlocks: jest.fn(),
    buildDynamicLorebookData: jest.fn(),
    buildDynamicSummaryDescription: jest.fn(),
    validateGroupCardRequest: jest.fn(),
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/JobClient.js', () => ({
    sendJsonRequest: jest.fn(),
    throwIfNotOk: jest.fn(),
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/CardCreator.js', () => ({
    createGeneratedGroupCard: jest.fn(),
    rollbackGeneratedLorebook: jest.fn(),
    rollbackGeneratedCharacter: jest.fn(),
    readCreatedCharacterAvatar: jest.fn(),
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/TaskClient.js', () => ({
    createTaskClient: () => mockClient,
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/wizard/TaskWizardController.js', () => ({
    openTaskWizard: mockOpenTaskWizard,
    openTaskHistoryPopup: mockOpenTaskHistoryPopup,
    TaskWizardController: class {},
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/wizard/TaskWizardState.js', () => ({
    TaskWizardState: class {},
    computePageStates: () => [],
    TASK_WIZARD_PAGES: [],
}));

let openCombineWizard;
let initBulkCombine;

beforeAll(async () => {
    ({ openCombineWizard, initBulkCombine } = await import('../../public/scripts/bulk-combine/index.js'));
});

beforeEach(() => {
    mockCharacters.length = 0;
    mockClient = makeMockClient();
    jest.clearAllMocks();
    delete global.toastr;
});

describe('openCombineWizard task creation', () => {
    test('unshallows every selected character BEFORE snapshotting core payloads', async () => {
        // Shallow roster: payloads are empty until unshallowed (lazy loading).
        mockCharacters.push(
            { name: 'Alice', avatar: 'alice.png', description: '', shallow: true },
            { name: 'Bob', avatar: 'bob.png', description: '', shallow: true },
        );
        mockUnshallowCharacter.mockImplementation(async (id) => {
            mockCharacters[id].description = `Full description of ${mockCharacters[id].name}`;
            mockCharacters[id].shallow = false;
        });

        await openCombineWizard([0, 1]);

        expect(mockUnshallowCharacter).toHaveBeenCalledTimes(2);
        expect(mockUnshallowCharacter).toHaveBeenCalledWith(0);
        expect(mockUnshallowCharacter).toHaveBeenCalledWith(1);
        // Unshallow strictly precedes task creation (and thus the snapshot).
        expect(mockUnshallowCharacter.mock.invocationCallOrder[1])
            .toBeLessThan(mockClient.createTask.mock.invocationCallOrder[0]);
        // The durable source snapshots carry the unshallowed payloads.
        expect(mockClient.patchTask).toHaveBeenCalledTimes(1);
        const [, patch] = mockClient.patchTask.mock.calls[0];
        expect(patch.sources).toEqual([
            {
                key: 'alice.png',
                name: 'Alice',
                avatar: 'alice.png',
                fields: expect.objectContaining({ description: 'Full description of Alice' }),
            },
            {
                key: 'bob.png',
                name: 'Bob',
                avatar: 'bob.png',
                fields: expect.objectContaining({ description: 'Full description of Bob' }),
            },
        ]);
        // The wizard opens with the seeded task and the client.
        expect(mockOpenTaskWizard).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1' }),
            { client: mockClient },
        );
    });

    test('derives the task name from the selected characters', async () => {
        mockCharacters.push(
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'bob.png' },
        );

        await openCombineWizard([0, 1]);

        expect(mockClient.createTask).toHaveBeenCalledWith({ name: 'Alice + Bob' });
    });

    test('legacy rerunConfig seeding is gone: extra arguments are ignored', async () => {
        mockCharacters.push(
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'bob.png' },
        );

        await openCombineWizard([0, 1], {
            groupName: 'Legacy Rerun Name',
            rerunMeta: { config: { prompt: 'Legacy prompt', createLorebook: true } },
        });

        // Name still derives from the characters, not rerunConfig.groupName.
        expect(mockClient.createTask).toHaveBeenCalledWith({ name: 'Alice + Bob' });
        // The task seed carries ONLY the sources — no settings/prompts fragments.
        const [, patch] = mockClient.patchTask.mock.calls[0];
        expect(Object.keys(patch)).toEqual(['sources']);
    });

    test('warns and aborts when fewer than two valid characters are selected', async () => {
        const warning = jest.fn();
        global.toastr = { warning };
        mockCharacters.push({ name: 'Alice', avatar: 'alice.png' });

        await openCombineWizard([0, 42]); // 42 is not a valid roster index.

        expect(warning).toHaveBeenCalledTimes(1);
        expect(mockClient.createTask).not.toHaveBeenCalled();
        expect(mockOpenTaskWizard).not.toHaveBeenCalled();
    });

    test('the wizard client persists resolved token windows to task.settings before a pass run', async () => {
        mockCharacters.push(
            { name: 'Alice', avatar: 'alice.png' },
            { name: 'Bob', avatar: 'bob.png' },
        );
        // The decorator replaces runPass with a non-mock wrapper at wiring
        // time; keep a handle on the inner mock for call assertions.
        const innerRunPass = mockClient.runPass;
        await openCombineWizard([0, 1]);
        const { client } = mockOpenTaskWizard.mock.calls[0][1];

        // What transformPage does at run time, against the wired client.
        await client.runPass('task-1', 'transform1', {
            completionSettings: { max_tokens: 500, max_context: 64000, stream: false },
        });

        const callIndex = mockClient.patchTask.mock.calls.findIndex(
            (call) => call[1]?.settings,
        );
        expect(callIndex).toBeGreaterThanOrEqual(0);
        const settingsPatch = mockClient.patchTask.mock.calls[callIndex];
        expect(settingsPatch[0]).toBe('task-1');
        // Exactly the keys the server preflight reads
        // (src/util/bulk-combine/task-runner.js: task.settings.outputTokens /
        // task.settings.totalContextTokens).
        expect(settingsPatch[1].settings).toEqual({
            outputTokens: 500,
            totalContextTokens: 64000,
        });
        expect(mockClient.patchTask.mock.invocationCallOrder[callIndex])
            .toBeLessThan(innerRunPass.mock.invocationCallOrder[0]);
    });
});

describe('initBulkCombine', () => {
    const originalDocument = global.document;

    afterEach(() => {
        delete global.document;
        if (originalDocument) {
            global.document = originalDocument;
        }
    });

    test('binds the button-bar history button to the standalone history popup', () => {
        const listeners = new Map();
        const button = {
            addEventListener: jest.fn((type, fn) => listeners.set(type, fn)),
        };
        global.document = {
            getElementById: jest.fn((id) => (id === 'rm_button_combine_history' ? button : null)),
        };

        initBulkCombine();

        expect(document.getElementById).toHaveBeenCalledWith('rm_button_combine_history');
        expect(button.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));

        listeners.get('click')();
        expect(mockOpenTaskHistoryPopup).toHaveBeenCalledTimes(1);
    });

    test('missing button is a safe no-op', () => {
        global.document = { getElementById: jest.fn(() => null) };

        expect(() => initBulkCombine()).not.toThrow();
        expect(mockOpenTaskHistoryPopup).not.toHaveBeenCalled();
    });
});
