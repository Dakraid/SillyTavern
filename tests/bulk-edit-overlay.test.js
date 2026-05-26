import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const mockCharacters = [];
const mockWorldNames = [];
const mockPowerUser = {};
const mockCallGenericPopup = jest.fn();
const mockSaveSettingsDebounced = jest.fn();
const DEFAULT_GROUP_CARD_COMBINE_PROMPT = 'Default group card combine prompt.';

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
    saveSettingsDebounced: mockSaveSettingsDebounced,
    substituteParams: value => value,
    unshallowCharacter: jest.fn(character => character),
    getThumbnailUrl: jest.fn(() => ''),
    main_api: 'kobold',
    amount_gen: 200,
    max_context: 4096,
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({ favsToHotswap: jest.fn() }));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({ loader: { show: jest.fn(), hide: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({ convertCharacterToPersona: jest.fn() }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: mockCallGenericPopup,
    POPUP_RESULT: { AFFIRMATIVE: 'affirmative' },
    POPUP_TYPE: { CONFIRM: 'confirm', INPUT: 'input' },
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    DEFAULT_GROUP_CARD_COMBINE_PROMPT,
    DEFAULT_POST_MERGE_PROMPT: 'Default post-merge prompt.',
    power_user: mockPowerUser,
}));
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
jest.unstable_mockModule('../public/scripts/openai.js', () => ({ oai_settings: {} }));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({ textgenerationwebui_settings: {} }));
jest.unstable_mockModule('../public/scripts/nai-settings.js', () => ({ nai_settings: {} }));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({ kai_settings: {} }));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({ horde_settings: {} }));
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

beforeEach(() => {
    mockPowerUser.group_card_combine_prompt_presets = [];
    mockPowerUser.group_card_combine_prompt = DEFAULT_GROUP_CARD_COMBINE_PROMPT;
    mockPowerUser.group_card_combine_included_fields = ['personality'];
    mockCallGenericPopup.mockReset();
    mockSaveSettingsDebounced.mockReset();
    mockWorldNames.length = 0;
    global.fetch = jest.fn();
});

function createResponse({ ok = true, text = '' } = {}) {
    return {
        ok,
        text: jest.fn(async () => text),
    };
}

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

    test('allows lorebook name collision when lorebook creation is disabled', () => {
        const toaster = createToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        expect(mod.validateGroupCardRequest('Shared Lore', [0, 1], {
            characterList,
            worldNames: [' shared lore '],
            toaster,
            createLorebook: false,
        })).toEqual({ groupName: 'Shared Lore', characters: characterList });
        expect(toaster.error).not.toHaveBeenCalled();
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

        expect(result).toBe('<character>one</character>\n\n<character>two</character>');
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

    test('saves, overwrites, and deletes prompt presets', async () => {
        await expect(mod.saveGroupCardCombinePromptPreset('  My Preset  ', 'first prompt')).resolves.toEqual({
            name: 'My Preset',
            prompt: 'first prompt',
        });
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([{ name: 'My Preset', prompt: 'first prompt' }]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);

        mockCallGenericPopup.mockResolvedValueOnce('affirmative');
        await expect(mod.saveGroupCardCombinePromptPreset('my preset', 'updated prompt')).resolves.toEqual({
            name: 'my preset',
            prompt: 'updated prompt',
        });
        expect(mockCallGenericPopup).toHaveBeenCalledWith(expect.stringContaining('Overwrite prompt preset'), 'confirm', '', expect.objectContaining({ okButton: 'Overwrite' }));
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([{ name: 'my preset', prompt: 'updated prompt' }]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(2);

        expect(mod.deleteGroupCardCombinePromptPreset(0)).toBe(true);
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(3);
    });

    test('does not overwrite prompt preset when duplicate confirmation is cancelled', async () => {
        mockPowerUser.group_card_combine_prompt_presets = [{ name: 'Existing', prompt: 'old prompt' }];
        mockCallGenericPopup.mockResolvedValueOnce(false);

        await expect(mod.saveGroupCardCombinePromptPreset('existing', 'new prompt')).resolves.toBeNull();
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([{ name: 'Existing', prompt: 'old prompt' }]);
        expect(mockSaveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('skips lorebook creation and link when requested', async () => {
        global.fetch
            .mockResolvedValueOnce(createResponse({ text: '{"avatar":"group.png"}' }));

        await expect(mod.createGeneratedGroupCard('Group', '<character>Group</character>', [
            { name: 'Alice' },
            { name: 'Bob' },
        ], false)).resolves.toEqual({ avatar: 'group.png', world: '' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledWith('/api/characters/create', expect.objectContaining({
            method: 'POST',
            body: expect.any(String),
        }));
        const createBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(createBody.extensions).toEqual({ world: '' });
    });

    test('creates lorebook, character, and link by default', async () => {
        global.fetch
            .mockResolvedValueOnce(createResponse())
            .mockResolvedValueOnce(createResponse({ text: 'group.png' }))
            .mockResolvedValueOnce(createResponse());

        await expect(mod.createGeneratedGroupCard('Group', '<character>Group</character>', [
            { name: 'Alice' },
            { name: 'Bob' },
        ])).resolves.toEqual({ avatar: 'group.png', world: 'Group' });

        expect(global.fetch.mock.calls.map(call => call[0])).toEqual([
            '/api/worldinfo/edit',
            '/api/characters/create',
            '/api/characters/merge-attributes',
        ]);
    });

    test('normalizes selected optional fields with always-included fields', () => {
        expect(mod.ALWAYS_INCLUDED_CHARACTER_FIELDS).toEqual(['name', 'description']);
        expect(mod.OPTIONAL_CHARACTER_FIELDS).toEqual(['personality', 'scenario', 'first_mes', 'mes_example']);
        expect(mod.normalizeSelectedFields()).toEqual(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']);
        expect(mod.normalizeSelectedFields(null)).toEqual(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example']);
        expect(mod.normalizeSelectedFields(['personality'])).toEqual(['name', 'description', 'personality']);
        expect(mod.normalizeSelectedFields(['scenario', 'first_mes', 'mes_example'])).toEqual(['name', 'description', 'scenario', 'first_mes', 'mes_example']);
        expect(mod.normalizeSelectedFields(['invalid_field'])).toEqual(['name', 'description']);
        expect(mod.normalizeSelectedFields(['personality', 'personality'])).toEqual(['name', 'description', 'personality']);
    });

    test('builds prompt blocks with selected fields only', () => {
        const character = {
            name: 'Alice',
            description: 'Original description',
            data: {
                personality: 'Curious',
                scenario: 'Shared scene',
                first_mes: 'Hello there.',
                mes_example: '<START>Example chat',
            },
        };
        const filteredBlock = mod.buildCoreCharacterPromptBlock(character, ['name', 'description', 'personality']);
        const filteredPrompt = mod.buildGroupCardCombineQuietPrompt('Prompt', [character], ['name', 'description']);
        const fullBlock = mod.buildCoreCharacterPromptBlock(character);

        expect(filteredBlock).toContain('<name>Alice</name>');
        expect(filteredBlock).toContain('<description>Original description</description>');
        expect(filteredBlock).toContain('<personality>Curious</personality>');
        expect(filteredBlock).not.toContain('<scenario>');
        expect(filteredBlock).not.toContain('<first_mes>');
        expect(filteredBlock).not.toContain('<mes_example>');
        expect(filteredPrompt).toContain('<description>Original description</description>');
        expect(filteredPrompt).not.toContain('<personality>');
        expect(fullBlock).toContain('<scenario>Shared scene</scenario>');
        expect(fullBlock).toContain('<first_mes>Hello there.</first_mes>');
        expect(fullBlock).toContain('<mes_example>&lt;START&gt;Example chat</mes_example>');
    });

    test('builds lorebook content and data with selected fields only', () => {
        const character = {
            name: 'Alice',
            description: 'Original description',
            data: {
                personality: 'Curious',
                scenario: 'Shared scene',
                first_mes: 'Hello there.',
                mes_example: '<START>Example chat',
            },
        };
        const filteredContent = mod.buildLorebookEntryContent(character, ['name', 'description', 'scenario']);
        const fullContent = mod.buildLorebookEntryContent(character);
        const filteredData = mod.buildLorebookData([character], ['name', 'description', 'scenario']);

        expect(filteredContent).toContain('Name: Alice');
        expect(filteredContent).toContain('Description:\nOriginal description');
        expect(filteredContent).toContain('Scenario:\nShared scene');
        expect(filteredContent).not.toContain('Personality:');
        expect(filteredContent).not.toContain('First message:');
        expect(filteredContent).not.toContain('Example messages:');
        expect(fullContent).toContain('Personality:\nCurious');
        expect(fullContent).toContain('First message:\nHello there.');
        expect(fullContent).toContain('Example messages:\n<START>Example chat');
        expect(filteredData.entries[0].content).toBe(filteredContent);
    });

    test('writes filtered lorebook entries when creating generated group card', async () => {
        global.fetch
            .mockResolvedValueOnce(createResponse())
            .mockResolvedValueOnce(createResponse({ text: 'group.png' }))
            .mockResolvedValueOnce(createResponse());

        await expect(mod.createGeneratedGroupCard('Group', '<character>Group</character>', [
            {
                name: 'Alice',
                description: 'Original description',
                data: {
                    personality: 'Curious',
                    scenario: 'Shared scene',
                    first_mes: 'Hello there.',
                    mes_example: '<START>Example chat',
                },
            },
            { name: 'Bob', description: 'Second description' },
        ], true, ['name', 'description', 'scenario'])).resolves.toEqual({ avatar: 'group.png', world: 'Group' });

        const worldBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        const entryContent = worldBody.data.entries[0].content;
        expect(entryContent).toContain('Name: Alice');
        expect(entryContent).toContain('Description:\nOriginal description');
        expect(entryContent).toContain('Scenario:\nShared scene');
        expect(entryContent).not.toContain('Personality:');
        expect(entryContent).not.toContain('First message:');
        expect(entryContent).not.toContain('Example messages:');
    });

});

describe('XML parser edge cases', () => {
    test('unclosed XML tag does not hang extractTopLevelXmlBlocks', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            '<character>\n  <name>Alice</name>\n</character>\n<character>\n  <name>Bob</name>\n',
            1,
        );
        expect(result).toContain('<name>Alice</name>');
        expect(result).not.toContain('Bob');
    });

    test('truly unclosed tag is dropped without hanging', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            '<character>\n  <name>Alice</name>\n',
            1,
        );
        expect(result).toContain('Alice');
    });

    test('extracts XML blocks surrounded by prose text', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            'Here are the characters:\n<character>Alice</character>\n<character>Bob</character>\nHope this helps!',
            2,
        );
        expect(result).toBe('<character>Alice</character>\n\n<character>Bob</character>');
    });

    test('falls back to raw text wrapped in character block when no XML found', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            'Just some plain text output from the LLM.',
            1,
        );
        expect(result).toContain('<character>');
        expect(result).toContain('Just some plain text output from the LLM.');
        expect(result).toContain('</character>');
    });

    test('throws when fewer character blocks than expected', () => {
        expect(() => mod.validateGeneratedGroupCardDescription(
            '<character>one</character>\n<character>two</character>',
            5,
        )).toThrow('Generation returned 2 character block(s), expected at least 5.');
    });

    test('single-char mode accepts non-character XML tags', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            '<persona>A mysterious figure</persona>',
            1,
        );
        expect(result).toContain('<persona>');
    });

    test('strips markdown code fences from output', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            '```xml\n<character>test</character>\n```',
            1,
        );
        expect(result).toBe('<character>test</character>');
    });

    test('handles attributes on XML tags', () => {
        const result = mod.validateGeneratedGroupCardDescription(
            '<character role="main">Alice</character>',
            1,
        );
        expect(result).toContain('Alice');
    });
});
