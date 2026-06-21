import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

const mockCharacters = [];
const mockWorldNames = [];
const mockPowerUser = {};
const mockCallGenericPopup = jest.fn();
const mockSaveSettingsDebounced = jest.fn();
const DEFAULT_GROUP_CARD_COMBINE_PROMPT = 'Default group card combine prompt.';

jest.unstable_mockModule('../public/script.js', () => ({
    characterGroupOverlay: {},
    characters: mockCharacters,
    event_types: { CHARACTER_EDITOR_OPENED: 'character_editor_opened' },
    eventSource: { emit: jest.fn(), on: jest.fn() },
    Generate: jest.fn(),
    generateQuietPrompt: jest.fn(),
    getCharacters: jest.fn(),
    getRequestHeaders: () => ({}),
    buildAvatarList: jest.fn(),
    characterToEntity: jest.fn((item, id) => ({ item, id })),
    printCharactersDebounced: jest.fn(),
    deleteCharacter: jest.fn(),
    saveSettingsDebounced: mockSaveSettingsDebounced,
    substituteParams: (value) => value,
    unshallowCharacter: jest.fn((character) => character),
    getThumbnailUrl: jest.fn(() => ''),
    main_api: 'kobold',
    amount_gen: 200,
    max_context: 4096,
    getVirtualCharacterList: jest.fn(() => []),
    getEntitiesList: jest.fn(() => []),
}));

jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    favsToHotswap: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({
    loader: { show: jest.fn(), hide: jest.fn() },
}));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    convertCharacterToPersona: jest.fn(),
}));
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
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (value) => (Array.isArray(value) ? value.join('') : String(value)),
}));
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
    saveWorldInfo: jest.fn(),
    worldInfoCache: new Map(),
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    oai_settings: {},
}));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgenerationwebui_settings: {},
}));
jest.unstable_mockModule('../public/scripts/nai-settings.js', () => ({
    nai_settings: {},
}));
jest.unstable_mockModule('../public/scripts/kai-settings.js', () => ({
    kai_settings: {},
}));
jest.unstable_mockModule('../public/scripts/horde.js', () => ({
    horde_settings: {},
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    escapeHtml: (value) =>
        String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll('\'', '&#39;'),
}));

/** @type {import('../public/scripts/BulkEditOverlay.js')} */
let mod;
/** @type {import('../public/scripts/group-card-xml-parser.js')} */
let parserMod;

beforeAll(async () => {
    mod = await import('../public/scripts/BulkEditOverlay.js');
    parserMod = await import('../public/scripts/group-card-xml-parser.js');
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

describe('extractSummaryFromCharacterBlock', () => {
    test('returns summary content when present', () => {
        expect(
            parserMod.extractSummaryFromCharacterBlock(
                '<character><summary>A brief about Alice</summary><name>Alice</name></character>',
            ),
        ).toBe('A brief about Alice');
    });

    test('returns empty string when no summary', () => {
        expect(
            parserMod.extractSummaryFromCharacterBlock(
                '<character><name>Alice</name></character>',
            ),
        ).toBe('');
    });

    test('returns empty string for empty summary', () => {
        expect(
            parserMod.extractSummaryFromCharacterBlock(
                '<character><summary></summary><name>Alice</name></character>',
            ),
        ).toBe('');
    });

    test('handles nested tags in summary', () => {
        expect(
            parserMod.extractSummaryFromCharacterBlock(
                '<character><summary>A <b>bold</b> brief</summary><name>Alice</name></character>',
            ),
        ).toBe('A <b>bold</b> brief');
    });
});

describe('extractXmlBlocksByTag', () => {
    test('returns openTag with attributes', () => {
        expect(
            parserMod.extractXmlBlocksByTag(
                '<character name="Alice" species="elf"><name>Alice</name></character>',
                'character',
            )[0]?.openTag,
        ).toBe('<character name="Alice" species="elf">');
    });
});

describe('extractOpenTagAttributes', () => {
    test('parses double and single quoted attributes', () => {
        expect(
            parserMod.extractOpenTagAttributes(
                '<character name="Alice & Bob" species=\'half-elf\'>',
            ),
        ).toEqual({ name: 'Alice & Bob', species: 'half-elf' });
    });

    test('returns empty object for no attributes', () => {
        expect(parserMod.extractOpenTagAttributes('<character>')).toEqual({});
    });
});

describe('stripSummaryFromCharacterBlock', () => {
    test('removes summary cleanly', () => {
        const input =
			'<character>\n  <summary>Brief</summary>\n  <name>Alice</name>\n</character>';
        expect(parserMod.stripSummaryFromCharacterBlock(input)).toBe(
            '<character>\n  <name>Alice</name>\n</character>',
        );
    });

    test('returns unchanged when no summary', () => {
        const input = '<character><name>Alice</name></character>';
        expect(parserMod.stripSummaryFromCharacterBlock(input)).toBe(input);
    });

    test('handles multiline summary', () => {
        const input =
			'<character>\n  <summary>Brief line one\nBrief line two</summary>\n  <name>Alice</name>\n  <description>Full</description>\n</character>';
        expect(parserMod.stripSummaryFromCharacterBlock(input)).toBe(
            '<character>\n  <name>Alice</name>\n  <description>Full</description>\n</character>',
        );
    });

    test('removes summary with attributes', () => {
        const input =
			'<character>\n  <summary role="backstory">Brief</summary>\n  <name>Alice</name>\n</character>';
        expect(parserMod.stripSummaryFromCharacterBlock(input)).toBe(
            '<character>\n  <name>Alice</name>\n</character>',
        );
    });
});

describe('buildSummaryCharacterBlock', () => {
    test('produces correct summary block', () => {
        const input =
			'<character><summary>Brief</summary><name>Alice</name><description>Full desc</description></character>';
        expect(parserMod.buildSummaryCharacterBlock(input)).toBe(
            '<character>\n  <name>Alice</name>\n  <summary>Brief</summary>\n</character>',
        );
    });

    test('handles no name', () => {
        expect(
            parserMod.buildSummaryCharacterBlock(
                '<character><summary>Brief</summary></character>',
            ),
        ).toBe('<character>\n  <summary>Brief</summary>\n</character>');
    });

    test('handles no summary', () => {
        expect(
            parserMod.buildSummaryCharacterBlock(
                '<character><name>Alice</name></character>',
            ),
        ).toBe(
            '<character>\n  <name>Alice</name>\n  <summary></summary>\n</character>',
        );
    });

    test('preserves character and summary attributes', () => {
        const input =
			'<character name="Alice" species="elf"><name>Alice</name><summary role="backstory">An elf from...</summary></character>';
        expect(parserMod.buildSummaryCharacterBlock(input)).toBe(
            '<character name="Alice" species="elf">\n  <name>Alice</name>\n  <summary role="backstory">An elf from...</summary>\n</character>',
        );
    });

    test('preserves attributes with special characters', () => {
        const input =
			'<character title="Alice &amp; Bob"><summary note="uses &quot;quotes&quot;">Brief</summary></character>';
        expect(parserMod.buildSummaryCharacterBlock(input)).toBe(
            '<character title="Alice &amp; Bob">\n  <summary note="uses &quot;quotes&quot;">Brief</summary>\n</character>',
        );
    });
});

describe('minifyXml', () => {
    test('compact mode puts each element on its own line without indentation', () => {
        const input =
			'<character>\n  <name>Alice</name>\n  <desc>Text</desc>\n</character>';
        expect(parserMod.minifyXml(input, { compact: true })).toBe(
            '<character>\n<name>Alice</name>\n<desc>Text</desc>\n</character>',
        );
    });

    test('single-line mode puts entire XML on one line', () => {
        const input =
			'<character>\n  <name>Alice</name>\n  <desc>Text</desc>\n</character>';
        expect(parserMod.minifyXml(input, { singleLine: true })).toBe(
            '<character> <name>Alice</name> <desc>Text</desc> </character>',
        );
    });

    test('empty input returns empty string', () => {
        expect(parserMod.minifyXml('', { compact: true })).toBe('');
        expect(parserMod.minifyXml(null, { singleLine: true })).toBe('');
    });

    test('removes XML comments', () => {
        expect(
            parserMod.minifyXml(
                '<character><!-- comment --><name>Alice</name></character>',
                { compact: true },
            ),
        ).toBe('<character>\n<name>Alice</name>\n</character>');
    });

    test('default options remove comments, empty lines, and redundant text whitespace', () => {
        const input =
			'<character>\n\n  <!-- comment -->\n  <name>Alice   Bob</name>\n\n</character>';
        expect(parserMod.minifyXml(input, {})).toBe(
            '<character><name>Alice Bob</name></character>',
        );
    });

    test('undefined options use default minification behavior', () => {
        const input =
			'<character>\n\n  <!-- comment -->\n  <name>Alice   Bob</name>\n\n</character>';
        expect(parserMod.minifyXml(input)).toBe(
            '<character><name>Alice Bob</name></character>',
        );
    });

    test('removes empty lines', () => {
        expect(
            parserMod.minifyXml(
                '<character>\n\n  <name>Alice</name>\n\n</character>',
                { compact: true },
            ),
        ).toBe('<character>\n<name>Alice</name>\n</character>');
    });

    test('collapses multiple spaces in text nodes', () => {
        expect(
            parserMod.minifyXml('<name>Alice   Bob</name>', { compact: true }),
        ).toBe('<name>Alice Bob</name>');
    });

    test('is idempotent', () => {
        const once = parserMod.minifyXml(
            '<character>\n  <name>Alice   Bob</name>\n</character>',
            { compact: true },
        );
        expect(parserMod.minifyXml(once, { compact: true })).toBe(once);
    });
});

describe('BulkEditOverlay dynamic lorebook helpers', () => {
    test('buildDynamicLorebookData creates entries from character blocks', () => {
        const xml = [
            '<setting>Keep in card</setting>',
            '<character><summary>Brief Alice</summary><name>Alice</name><description>Full Alice</description></character>',
            '<character><summary>Brief Bob</summary><name>Bob</name><description>Full Bob</description></character>',
        ].join('\n\n');
        const lorebookData = mod.buildDynamicLorebookData(xml);

        expect(Object.keys(lorebookData.entries)).toEqual(['0', '1']);
        expect(lorebookData.entries[0].key).toEqual(['Alice', 'alice']);
        expect(lorebookData.entries[0].comment).toBe('Alice — Dynamic Entry');
        expect(lorebookData.entries[0].content).toBe(
            '<character><name>Alice</name><description>Full Alice</description></character>',
        );
        expect(lorebookData.entries[0].content).not.toContain('<summary>');
        expect(lorebookData.entries[1].key).toEqual(['Bob', 'bob']);
        expect(lorebookData.entries[1].content).toContain(
            '<description>Full Bob</description>',
        );
    });

    test('buildDynamicLorebookData skips non-character blocks', () => {
        const lorebookData = mod.buildDynamicLorebookData(
            '<setting>Keep in card</setting>\n\n<character><summary>Brief</summary><name>Alice</name></character>',
        );
        expect(Object.keys(lorebookData.entries)).toEqual(['0']);
        expect(lorebookData.entries[0].key).toEqual(['Alice', 'alice']);
    });

    test('buildDynamicSummaryDescription converts character blocks and preserves non-character blocks', () => {
        const xml = [
            '<setting>Keep in card</setting>',
            '<character><summary>Brief Alice</summary><name>Alice</name><description>Full Alice</description></character>',
            '<rules>Also keep</rules>',
        ].join('\n\n');

        expect(mod.buildDynamicSummaryDescription(xml)).toBe(
            [
                '<setting>Keep in card</setting>',
                '<character>\n  <name>Alice</name>\n  <summary>Brief Alice</summary>\n</character>',
                '<rules>Also keep</rules>',
            ].join('\n\n'),
        );
    });

    test('buildDynamicSummaryDescription returns empty string for empty input', () => {
        expect(mod.buildDynamicSummaryDescription('')).toBe('');
    });

    test('buildDynamicSummaryDescription preserves only non-character blocks', () => {
        expect(
            mod.buildDynamicSummaryDescription(
                '<setting>Dungeon</setting>\n\n<rules>Stay quiet</rules>',
            ),
        ).toBe('<setting>Dungeon</setting>\n\n<rules>Stay quiet</rules>');
    });

    test('buildDynamicSummaryDescription preserves adjacent character and non-character blocks', () => {
        expect(
            mod.buildDynamicSummaryDescription(
                '<character><summary>Brief</summary><name>Alice</name></character><setting>Dungeon</setting>',
            ),
        ).toBe(
            '<character>\n  <name>Alice</name>\n  <summary>Brief</summary>\n</character>\n\n<setting>Dungeon</setting>',
        );
    });

    test('buildDynamicSummaryDescription skips self-closing tags without breaking surrounding blocks', () => {
        expect(
            mod.buildDynamicSummaryDescription(
                '<setting>Dungeon</setting><marker/><character><summary>Brief</summary><name>Alice</name></character>',
            ),
        ).toBe(
            '<setting>Dungeon</setting>\n\n<character>\n  <name>Alice</name>\n  <summary>Brief</summary>\n</character>',
        );
    });

    test('buildDynamicSummaryDescription preserves deeply nested same-name blocks', () => {
        expect(
            mod.buildDynamicSummaryDescription(
                '<rules><rules>inner</rules><note>outer</note></rules><character><summary>Brief</summary><name>Alice</name></character>',
            ),
        ).toBe(
            '<rules><rules>inner</rules><note>outer</note></rules>\n\n<character>\n  <name>Alice</name>\n  <summary>Brief</summary>\n</character>',
        );
    });
});

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

        expect(
            mod.validateGroupCardRequest(' Existing Group ', [0, 1], {
                characterList,
                worldNames: [],
                toaster,
            }),
        ).toEqual({
            groupName: 'Existing Group',
            characters: expect.any(Array),
            collisions: { character: true, lorebook: false },
        });
    });

    test('rejects empty names, missing character names, and lorebook name collisions', () => {
        const toaster = createToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        expect(
            mod.validateGroupCardRequest('   ', [0, 1], {
                characterList,
                worldNames: [],
                toaster,
            }),
        ).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith(
            'Enter a group card name.',
            'Combine into Group Card',
        );

        expect(
            mod.validateGroupCardRequest(
                'Group',
                [{ description: 'missing name' }, { data: {} }],
                { characterList, worldNames: [], toaster },
            ),
        ).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );

        expect(
            mod.validateGroupCardRequest('Shared Lore', [0, 1], {
                characterList,
                worldNames: [' shared lore '],
                toaster,
            }),
        ).toEqual({
            groupName: 'Shared Lore',
            characters: expect.any(Array),
            collisions: { character: false, lorebook: true },
        });
    });

    test('allows lorebook name collision when lorebook creation is disabled', () => {
        const toaster = createToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        expect(
            mod.validateGroupCardRequest('Shared Lore', [0, 1], {
                characterList,
                worldNames: [' shared lore '],
                toaster,
                createLorebook: false,
            }),
        ).toEqual({
            groupName: 'Shared Lore',
            characters: characterList,
            collisions: { character: false, lorebook: false },
        });
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
        const result = mod.validateGeneratedGroupCardDescription(
            `\`\`\`xml
Intro text
<character>one</character>
<character>two</character>
Trailing text
\`\`\``,
            2,
        );

        expect(result).toBe(
            '<character>one</character>\n\n<character>two</character>',
        );
    });

    test('rejects empty generated output and too few character tags', () => {
        expect(() => mod.validateGeneratedGroupCardDescription('', 1)).toThrow(
            'Generation returned empty output.',
        );
        expect(() =>
            mod.validateGeneratedGroupCardDescription(
                '<character>only</character>',
                2,
            ),
        ).toThrow('Generation returned 1 character block(s), expected at least 2.');
    });

    test('builds deterministic lorebook entry shape from original core fields', () => {
        const entry = mod.buildLorebookEntry(
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
            3,
        );

        expect(entry).toMatchObject({
            uid: 3,
            enabled: true,
            key: ['Alice', 'alice'],
            comment:
				'Alice — Description, Personality, Scenario, First mes, Mes example',
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
        const lorebookData = mod.buildLorebookData([
            { name: 'Alice' },
            { data: { name: 'Bob' } },
        ]);

        expect(Object.keys(lorebookData.entries)).toEqual(['0', '1']);
        expect(lorebookData.entries[0].key).toEqual(['Alice', 'alice']);
        expect(lorebookData.entries[1].key).toEqual(['Bob', 'bob']);
    });

    test('saves, overwrites, and deletes prompt presets', async () => {
        await expect(
            mod.saveGroupCardCombinePromptPreset('  My Preset  ', 'first prompt'),
        ).resolves.toEqual({
            name: 'My Preset',
            prompt: 'first prompt',
        });
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([
            { name: 'My Preset', prompt: 'first prompt' },
        ]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);

        mockCallGenericPopup.mockResolvedValueOnce('affirmative');
        await expect(
            mod.saveGroupCardCombinePromptPreset('my preset', 'updated prompt'),
        ).resolves.toEqual({
            name: 'my preset',
            prompt: 'updated prompt',
        });
        expect(mockCallGenericPopup).toHaveBeenCalledWith(
            expect.stringContaining('Overwrite prompt preset'),
            'confirm',
            '',
            expect.objectContaining({ okButton: 'Overwrite' }),
        );
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([
            { name: 'my preset', prompt: 'updated prompt' },
        ]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(2);

        expect(mod.deleteGroupCardCombinePromptPreset(0)).toBe(true);
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(3);
    });

    test('does not overwrite prompt preset when duplicate confirmation is cancelled', async () => {
        mockPowerUser.group_card_combine_prompt_presets = [
            { name: 'Existing', prompt: 'old prompt' },
        ];
        mockCallGenericPopup.mockResolvedValueOnce(false);

        await expect(
            mod.saveGroupCardCombinePromptPreset('existing', 'new prompt'),
        ).resolves.toBeNull();
        expect(mockPowerUser.group_card_combine_prompt_presets).toEqual([
            { name: 'Existing', prompt: 'old prompt' },
        ]);
        expect(mockSaveSettingsDebounced).not.toHaveBeenCalled();
    });

    test('skips lorebook creation and link when requested', async () => {
        global.fetch.mockResolvedValueOnce(
            createResponse({ text: '{"avatar":"group.png"}' }),
        );

        await expect(
            mod.createGeneratedGroupCard(
                'Group',
                '<character>Group</character>',
                [{ name: 'Alice' }, { name: 'Bob' }],
                false,
            ),
        ).resolves.toEqual({ avatar: 'group.png', world: '' });

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledWith(
            '/api/characters/create',
            expect.objectContaining({
                method: 'POST',
                body: expect.any(String),
            }),
        );
        const createBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(createBody.extensions).toEqual({ world: '' });
    });

    test('creates lorebook, character, and link by default', async () => {
        global.fetch
            .mockResolvedValueOnce(createResponse())
            .mockResolvedValueOnce(createResponse({ text: 'group.png' }))
            .mockResolvedValueOnce(createResponse());

        await expect(
            mod.createGeneratedGroupCard('Group', '<character>Group</character>', [
                { name: 'Alice' },
                { name: 'Bob' },
            ]),
        ).resolves.toEqual({ avatar: 'group.png', world: 'Group' });

        expect(global.fetch.mock.calls.map((call) => call[0])).toEqual([
            '/api/worldinfo/edit',
            '/api/characters/create',
            '/api/characters/merge-attributes',
        ]);
    });

    test('normalizes selected optional fields with always-included fields', () => {
        expect(mod.ALWAYS_INCLUDED_CHARACTER_FIELDS).toEqual([
            'name',
            'description',
        ]);
        expect(mod.OPTIONAL_CHARACTER_FIELDS).toEqual([
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
        ]);
        expect(mod.normalizeSelectedFields()).toEqual([
            'name',
            'description',
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
        ]);
        expect(mod.normalizeSelectedFields(null)).toEqual([
            'name',
            'description',
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
        ]);
        expect(mod.normalizeSelectedFields(['personality'])).toEqual([
            'name',
            'description',
            'personality',
        ]);
        expect(
            mod.normalizeSelectedFields(['scenario', 'first_mes', 'mes_example']),
        ).toEqual(['name', 'description', 'scenario', 'first_mes', 'mes_example']);
        expect(mod.normalizeSelectedFields(['invalid_field'])).toEqual([
            'name',
            'description',
        ]);
        expect(mod.normalizeSelectedFields(['personality', 'personality'])).toEqual(
            ['name', 'description', 'personality'],
        );
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
        const filteredBlock = mod.buildCoreCharacterPromptBlock(character, [
            'name',
            'description',
            'personality',
        ]);
        const filteredPrompt = mod.buildGroupCardCombineQuietPrompt(
            'Prompt',
            [character],
            ['name', 'description'],
        );
        const fullBlock = mod.buildCoreCharacterPromptBlock(character);

        expect(filteredBlock).toContain('<name>Alice</name>');
        expect(filteredBlock).toContain(
            '<description>Original description</description>',
        );
        expect(filteredBlock).toContain('<personality>Curious</personality>');
        expect(filteredBlock).not.toContain('<scenario>');
        expect(filteredBlock).not.toContain('<first_mes>');
        expect(filteredBlock).not.toContain('<mes_example>');
        expect(filteredPrompt).toContain(
            '<description>Original description</description>',
        );
        expect(filteredPrompt).not.toContain('<personality>');
        expect(fullBlock).toContain('<scenario>Shared scene</scenario>');
        expect(fullBlock).toContain('<first_mes>Hello there.</first_mes>');
        expect(fullBlock).toContain(
            '<mes_example>&lt;START&gt;Example chat</mes_example>',
        );
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
        const filteredContent = mod.buildLorebookEntryContent(character, [
            'name',
            'description',
            'scenario',
        ]);
        const fullContent = mod.buildLorebookEntryContent(character);
        const filteredData = mod.buildLorebookData(
            [character],
            ['name', 'description', 'scenario'],
        );

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

        await expect(
            mod.createGeneratedGroupCard(
                'Group',
                '<character>Group</character>',
                [
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
                ],
                true,
                ['name', 'description', 'scenario'],
            ),
        ).resolves.toEqual({ avatar: 'group.png', world: 'Group' });

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
        const result = parserMod.validateGeneratedGroupCardDescription(
            '<character>\n  <name>Alice</name>\n</character>\n<character>\n  <name>Bob</name>\n',
            1,
        );
        expect(result).toContain('<name>Alice</name>');
        expect(result).not.toContain('Bob');
    });

    test('truly unclosed tag is dropped without hanging', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            '<character>\n  <name>Alice</name>\n',
            1,
        );
        expect(result).toContain('Alice');
    });

    test('extracts XML blocks surrounded by prose text', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            'Here are the characters:\n<character>Alice</character>\n<character>Bob</character>\nHope this helps!',
            2,
        );
        expect(result).toBe(
            '<character>Alice</character>\n\n<character>Bob</character>',
        );
    });

    test('falls back to raw text wrapped in character block when no XML found', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            'Just some plain text output from the LLM.',
            1,
        );
        expect(result).toContain('<character>');
        expect(result).toContain('Just some plain text output from the LLM.');
        expect(result).toContain('</character>');
    });

    test('throws when fewer character blocks than expected', () => {
        expect(() =>
            parserMod.validateGeneratedGroupCardDescription(
                '<character>one</character>\n<character>two</character>',
                5,
            ),
        ).toThrow('Generation returned 2 character block(s), expected at least 5.');
    });

    test('single-char mode accepts non-character XML tags', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            '<persona>A mysterious figure</persona>',
            1,
        );
        expect(result).toContain('<persona>');
    });

    test('strips markdown code fences from output', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            '```xml\n<character>test</character>\n```',
            1,
        );
        expect(result).toBe('<character>test</character>');
    });

    test('handles attributes on XML tags', () => {
        const result = parserMod.validateGeneratedGroupCardDescription(
            '<character role="main">Alice</character>',
            1,
        );
        expect(result).toContain('Alice');
    });
});
