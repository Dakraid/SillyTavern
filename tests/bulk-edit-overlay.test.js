import { beforeAll, describe, expect, jest, test } from '@jest/globals';

const mockCharacters = [];
const mockWorldNames = [];

jest.unstable_mockModule('../public/script.js', () => ({
    characterGroupOverlay: {},
    characters: mockCharacters,
    event_types: {},
    eventSource: { emit: jest.fn() },
    Generate: jest.fn(),
    getCharacters: jest.fn(),
    getRequestHeaders: () => ({}),
    buildAvatarList: jest.fn(),
    characterToEntity: jest.fn((item, id) => ({ item, id })),
    printCharactersDebounced: jest.fn(),
    deleteCharacter: jest.fn(),
    saveSettingsDebounced: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ favsToHotswap: jest.fn() }));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({ loader: { show: jest.fn(), hide: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ convertCharacterToPersona: jest.fn() }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: jest.fn(),
    POPUP_RESULT: { AFFIRMATIVE: 'affirmative' },
    POPUP_TYPE: { CONFIRM: 'confirm' },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({ power_user: {} }));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    createTagInput: jest.fn(),
    getTagKeyForEntity: jest.fn(),
    getTagsList: jest.fn(() => []),
    printTagList: jest.fn(),
    tag_map: {},
    compareTagsForSort: jest.fn(() => 0),
    removeTagFromMap: jest.fn(),
    importTags: jest.fn(),
    tag_import_setting: {},
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: value => Array.isArray(value) ? value.join('') : String(value) }));
jest.unstable_mockModule('../public/scripts/world-info.js', () => ({
    newWorldInfoEntryTemplate: {
        enabled: true,
        key: [],
        keysecondary: [],
        comment: '',
        content: '',
        selective: false,
    },
    world_names: mockWorldNames,
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeHtml: value => String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#39;'),
}));

/** @type {import('../public/scripts/BulkEditOverlay.js')} */
let mod;

beforeAll(async () => {
    mod = await import('../public/scripts/BulkEditOverlay.js');
});

function createToaster() {
    return {
        warning: jest.fn(),
        error: jest.fn(),
    };
}

describe('BulkEditOverlay group card helper tests', () => {
    test('normalizes names for collision checks', () => {
        expect(mod.normalizeName('  Mixed CASE Name  ')).toBe('mixed case name');
        expect(mod.normalizeName(null)).toBe('');
    });

    test('validates selected character indexes and rejects character name collisions', () => {
        const toaster = createToaster();
        const characterList = [
            { name: 'Alice' },
            { data: { name: 'Bob' } },
            { data: { name: 'Existing Group' } },
        ];

        expect(mod.validateGroupCardRequest(' Existing Group ', [0, 1], {
            characterList,
            worldNames: [],
            toaster,
        })).toBeNull();

        expect(toaster.error).toHaveBeenCalledWith('Character named "Existing Group" already exists.', 'Combine into Group Card');
    });

    test('rejects empty names, missing character names, and lorebook name collisions', () => {
        const toaster = createToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        expect(mod.validateGroupCardRequest('   ', [0, 1], { characterList, worldNames: [], toaster })).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith('Enter a group card name.', 'Combine into Group Card');

        expect(mod.validateGroupCardRequest('Group', [{ description: 'missing name' }, { data: {} }], { characterList, worldNames: [], toaster })).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith('Select at least two valid characters.', 'Combine into Group Card');

        expect(mod.validateGroupCardRequest('Shared Lore', [0, 1], { characterList, worldNames: [' shared lore '], toaster })).toBeNull();
        expect(toaster.error).toHaveBeenCalledWith('Lorebook named "Shared Lore" already exists.', 'Combine into Group Card');
    });

    test('builds core payload with top-level fields and .data fallback, leaving missing fields empty', () => {
        const payload = mod.getCoreCharacterPayload({
            name: 'Top Name',
            description: 'Top description',
            data: {
                name: 'Data Name',
                description: 'Data description',
                personality: 'Data personality',
                scenario: 'Data scenario',
                first_mes: 'Data first message',
            },
        });

        expect(payload).toEqual({
            name: 'Top Name',
            description: 'Top description',
            personality: 'Data personality',
            scenario: 'Data scenario',
            first_mes: 'Data first message',
            mes_example: '',
        });
    });

    test('extracts fenced generated output and trims non-character wrapper text', () => {
        const result = mod.validateGeneratedGroupCardDescription(`\`\`\`xml
Intro text
<character>one</character>
<character>two</character>
Trailing text
\`\`\``, 2);

        expect(result).toBe('<character>one</character>\n<character>two</character>');
    });

    test('rejects empty generated output and too few character tags', () => {
        expect(() => mod.validateGeneratedGroupCardDescription('', 1)).toThrow('Generation returned empty output.');
        expect(() => mod.validateGeneratedGroupCardDescription('<character>only</character>', 2))
            .toThrow('Generation returned 1 character block(s), expected at least 2.');
    });

    test('builds deterministic lorebook entry shape from original core fields', () => {
        const entry = mod.buildLorebookEntry({
            name: 'Alice',
            description: 'Original description',
            data: {
                personality: 'Curious',
                scenario: 'Shared scene',
                first_mes: 'Hello there.',
                mes_example: '<START>Example chat',
            },
        }, 3);

        expect(entry).toMatchObject({
            uid: 3,
            enabled: true,
            key: ['Alice'],
            comment: 'Alice',
            addMemo: true,
            order: 97,
            keysecondary: [],
            selective: false,
        });
        expect(entry.content).toContain('Name: Alice');
        expect(entry.content).toContain('Description:\nOriginal description');
        expect(entry.content).toContain('Personality:\nCurious');
        expect(entry.content).toContain('Scenario:\nShared scene');
        expect(entry.content).toContain('First message:\nHello there.');
        expect(entry.content).toContain('Example messages:\n<START>Example chat');
    });

    test('builds lorebook data with one keyed entry per selected character', () => {
        const lorebookData = mod.buildLorebookData([{ name: 'Alice' }, { data: { name: 'Bob' } }]);

        expect(Object.keys(lorebookData.entries)).toEqual(['0', '1']);
        expect(lorebookData.entries[0].key).toEqual(['Alice']);
        expect(lorebookData.entries[1].key).toEqual(['Bob']);
    });

});
