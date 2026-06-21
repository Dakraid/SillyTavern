'use strict';

/**
 * Unit tests for the pure helper functions extracted into
 * `public/scripts/bulk-combine/helpers.js`.
 *
 * These tests import the helper module directly (not through the
 * `BulkEditOverlay.js` re-export) so the functions are exercised in
 * isolation. The XML parser (`group-card-xml-parser.js`) is loaded for real
 * because it is a dependency-free pure module; only the side-effecting host
 * modules (`script.js`, `utils.js`, `world-info.js`) are mocked.
 */

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

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    substituteParams: (value) => value,
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (value) =>
        String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll('\'', '&#39;'),
}));

jest.unstable_mockModule('../../public/scripts/world-info.js', () => ({
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

/** @type {typeof import('../../public/scripts/bulk-combine/helpers.js')} */
let h;

beforeAll(async () => {
    h = await import('../../public/scripts/bulk-combine/helpers.js');
});

beforeEach(() => {
    mockCharacters.length = 0;
    mockWorldNames.length = 0;
});

describe('field-list constants', () => {
    test('core, always-included, and optional field lists are stable and disjoint', () => {
        expect(h.CORE_CHARACTER_FIELDS).toEqual([
            'name',
            'description',
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
        ]);
        expect(h.ALWAYS_INCLUDED_CHARACTER_FIELDS).toEqual([
            'name',
            'description',
        ]);
        expect(h.OPTIONAL_CHARACTER_FIELDS).toEqual([
            'personality',
            'scenario',
            'first_mes',
            'mes_example',
        ]);

        // Always-included are a subset of core; optional fill the rest.
        for (const field of h.ALWAYS_INCLUDED_CHARACTER_FIELDS) {
            expect(h.CORE_CHARACTER_FIELDS).toContain(field);
        }
        expect(
            [...h.ALWAYS_INCLUDED_CHARACTER_FIELDS, ...h.OPTIONAL_CHARACTER_FIELDS],
        ).toEqual(h.CORE_CHARACTER_FIELDS);
    });
});

describe('normalizeSelectedFields', () => {
    test('defaults to every core field when no selection given', () => {
        expect(h.normalizeSelectedFields()).toEqual(h.CORE_CHARACTER_FIELDS);
    });

    test('treats null and undefined identically', () => {
        expect(h.normalizeSelectedFields(null)).toEqual(h.CORE_CHARACTER_FIELDS);
        expect(h.normalizeSelectedFields(undefined)).toEqual(
            h.CORE_CHARACTER_FIELDS,
        );
    });

    test('falls back to always-included fields for empty array', () => {
        expect(h.normalizeSelectedFields([])).toEqual(
            h.ALWAYS_INCLUDED_CHARACTER_FIELDS,
        );
    });

    test('includes selected optional fields in core order', () => {
        expect(h.normalizeSelectedFields(['personality'])).toEqual([
            'name',
            'description',
            'personality',
        ]);
        expect(
            h.normalizeSelectedFields(['scenario', 'first_mes', 'mes_example']),
        ).toEqual([
            'name',
            'description',
            'scenario',
            'first_mes',
            'mes_example',
        ]);
    });

    test('drops invalid and unknown fields', () => {
        expect(h.normalizeSelectedFields(['invalid_field'])).toEqual(
            h.ALWAYS_INCLUDED_CHARACTER_FIELDS,
        );
        expect(
            h.normalizeSelectedFields(['name', 'description', 'bogus']),
        ).toEqual(['name', 'description']);
    });

    test('deduplicates repeated selections', () => {
        expect(
            h.normalizeSelectedFields(['personality', 'personality']),
        ).toEqual(['name', 'description', 'personality']);
    });

    test('handles non-array input adversarially (string, number, object)', () => {
        // Non-array selections are coerced to an empty list.
        expect(h.normalizeSelectedFields('personality')).toEqual(
            h.ALWAYS_INCLUDED_CHARACTER_FIELDS,
        );
        expect(h.normalizeSelectedFields(42)).toEqual(
            h.ALWAYS_INCLUDED_CHARACTER_FIELDS,
        );
        expect(h.normalizeSelectedFields({})).toEqual(
            h.ALWAYS_INCLUDED_CHARACTER_FIELDS,
        );
    });
});

describe('normalizeName', () => {
    test('trims and lowercases', () => {
        expect(h.normalizeName('  Mixed CASE Name  ')).toBe('mixed case name');
    });

    test('returns empty string for null/undefined', () => {
        expect(h.normalizeName(null)).toBe('');
        expect(h.normalizeName(undefined)).toBe('');
    });

    test('coerces non-strings to string then normalizes', () => {
        expect(h.normalizeName(123)).toBe('123');
    });

    test('preserves special characters other than case/whitespace', () => {
        expect(h.normalizeName('  Élise & Co.  ')).toBe('élise & co.');
    });
});

describe('getCharacterName', () => {
    test('reads top-level name', () => {
        expect(h.getCharacterName({ name: 'Alice' })).toBe('Alice');
    });

    test('falls back to data.name', () => {
        expect(h.getCharacterName({ data: { name: 'Bob' } })).toBe('Bob');
    });

    test('falls back to ch_name and data.ch_name', () => {
        expect(h.getCharacterName({ ch_name: 'Carol' })).toBe('Carol');
        expect(h.getCharacterName({ data: { ch_name: 'Dave' } })).toBe('Dave');
    });

    test('returns empty string for null/undefined/empty objects', () => {
        expect(h.getCharacterName(null)).toBe('');
        expect(h.getCharacterName(undefined)).toBe('');
        expect(h.getCharacterName({})).toBe('');
        expect(h.getCharacterName({ data: {} })).toBe('');
    });

    test('top-level name wins over data.name', () => {
        expect(h.getCharacterName({ name: 'Top', data: { name: 'Inner' } })).toBe(
            'Top',
        );
    });
});

describe('getValidSelectedCharacters', () => {
    test('resolves numeric ids against the character list', () => {
        const list = [{ name: 'Alice' }, { name: 'Bob' }];
        expect(h.getValidSelectedCharacters([0, 1], list)).toEqual([
            { name: 'Alice' },
            { name: 'Bob' },
        ]);
    });

    test('passes through character objects unchanged', () => {
        const a = { name: 'Alice' };
        expect(h.getValidSelectedCharacters([a], [])).toEqual([a]);
    });

    test('drops entries whose resolved character has no name', () => {
        const list = [{ name: 'Alice' }, { data: {} }];
        expect(h.getValidSelectedCharacters([0, 1], list)).toEqual([
            { name: 'Alice' },
        ]);
    });

    test('handles null/empty input adversarially', () => {
        expect(h.getValidSelectedCharacters(null, [])).toEqual([]);
        expect(h.getValidSelectedCharacters(undefined, null)).toEqual([]);
        expect(h.getValidSelectedCharacters([], [])).toEqual([]);
    });

    test('ignores out-of-range numeric ids', () => {
        const list = [{ name: 'Alice' }];
        // index 5 resolves to undefined, which has no name, so it is dropped.
        expect(h.getValidSelectedCharacters([0, 5], list)).toEqual([
            { name: 'Alice' },
        ]);
    });
});

describe('getCoreCharacterField', () => {
    test('name field resolves through the name fallback chain', () => {
        expect(h.getCoreCharacterField({ name: 'Alice' }, 'name')).toBe('Alice');
        expect(h.getCoreCharacterField({ data: { name: 'Bob' } }, 'name')).toBe(
            'Bob',
        );
    });

    test('non-name fields read top-level then .data fallback', () => {
        expect(
            h.getCoreCharacterField({ description: 'Top' }, 'description'),
        ).toBe('Top');
        expect(
            h.getCoreCharacterField(
                { data: { description: 'Inner' } },
                'description',
            ),
        ).toBe('Inner');
        expect(
            h.getCoreCharacterField(
                { description: 'Top', data: { description: 'Inner' } },
                'description',
            ),
        ).toBe('Top');
    });

    test('missing fields coerce to empty string', () => {
        expect(h.getCoreCharacterField({}, 'personality')).toBe('');
        expect(h.getCoreCharacterField(null, 'description')).toBe('');
        expect(h.getCoreCharacterField(undefined, 'name')).toBe('');
    });
});

describe('getCoreCharacterPayload', () => {
    test('extracts all six core fields with .data fallback', () => {
        const payload = h.getCoreCharacterPayload({
            name: 'Top Name',
            description: 'Top description',
            data: {
                name: 'Data Name',
                description: 'Data description',
                personality: 'Data personality',
                scenario: 'Data scenario',
                first_mes: 'Data first message',
                mes_example: 'Data example',
            },
        });

        expect(payload).toEqual({
            name: 'Top Name',
            description: 'Top description',
            personality: 'Data personality',
            scenario: 'Data scenario',
            first_mes: 'Data first message',
            mes_example: 'Data example',
        });
    });

    test('missing fields default to empty strings', () => {
        expect(h.getCoreCharacterPayload({})).toEqual({
            name: '',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
        });
    });

    test('survives null/undefined input', () => {
        expect(h.getCoreCharacterPayload(null)).toEqual({
            name: '',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
        });
        expect(h.getCoreCharacterPayload(undefined)).toEqual({
            name: '',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
        });
    });
});

describe('buildCoreCharacterPromptBlock', () => {
    const fullCharacter = {
        name: 'Alice',
        description: 'Brave knight',
        data: {
            personality: 'Curious',
            scenario: 'Forest',
            first_mes: 'Hello.',
            mes_example: '<START>Chat',
        },
    };

    test('wraps selected fields in a <character> block', () => {
        const block = h.buildCoreCharacterPromptBlock(fullCharacter, [
            'name',
            'description',
        ]);
        expect(block).toBe(
            '<character>\n  <name>Alice</name>\n  <description>Brave knight</description>\n</character>',
        );
    });

    test('defaults to all core fields when no selection given', () => {
        const block = h.buildCoreCharacterPromptBlock(fullCharacter);
        expect(block).toContain('<name>Alice</name>');
        expect(block).toContain('<description>Brave knight</description>');
        expect(block).toContain('<personality>Curious</personality>');
        expect(block).toContain('<scenario>Forest</scenario>');
        expect(block).toContain('<first_mes>Hello.</first_mes>');
        // mes_example is HTML-escaped.
        expect(block).toContain(
            '<mes_example>&lt;START&gt;Chat</mes_example>',
        );
    });

    test('escapes HTML special characters in values', () => {
        const block = h.buildCoreCharacterPromptBlock({
            name: 'A & B <c>',
            description: '"quotes" \'apos\'',
        });
        expect(block).toContain('<name>A &amp; B &lt;c&gt;</name>');
        expect(block).toContain(
            '<description>&quot;quotes&quot; &#39;apos&#39;</description>',
        );
    });

    test('always includes name and description even when omitted from selection', () => {
        const block = h.buildCoreCharacterPromptBlock(fullCharacter, []);
        expect(block).toContain('<name>Alice</name>');
        expect(block).toContain('<description>Brave knight</description>');
        expect(block).not.toContain('<personality>');
    });

    test('handles empty/undefined character adversarially', () => {
        const block = h.buildCoreCharacterPromptBlock(null);
        expect(block).toContain('<character>');
        expect(block).toContain('<name></name>');
        expect(block).toContain('</character>');
    });
});

describe('buildGroupCardCombineQuietPrompt', () => {
    test('joins prompt with one character block per selected character', () => {
        const prompt = h.buildGroupCardCombineQuietPrompt(
            'Combine these.',
            [{ name: 'Alice' }, { name: 'Bob' }],
            ['name', 'description'],
        );
        expect(prompt).toBe(
            'Combine these.\n\nInput characters:\n<character>\n  <name>Alice</name>\n  <description></description>\n</character>\n\n<character>\n  <name>Bob</name>\n  <description></description>\n</character>',
        );
    });

    test('defaults to every core field when no field selection is given', () => {
        const prompt = h.buildGroupCardCombineQuietPrompt('P', [
            { name: 'Alice' },
        ]);
        // All six core fields are emitted (empties included).
        expect(prompt).toContain('<name>Alice</name>');
        expect(prompt).toContain('<description></description>');
        expect(prompt).toContain('<personality></personality>');
        expect(prompt).toContain('<scenario></scenario>');
        expect(prompt).toContain('<first_mes></first_mes>');
        expect(prompt).toContain('<mes_example></mes_example>');
    });

    test('tolerates null/empty prompt without throwing', () => {
        let prompt;
        expect(() => {
            prompt = h.buildGroupCardCombineQuietPrompt(null, [
                { name: 'Alice' },
            ]);
        }).not.toThrow();
        // A null prompt trims to an empty string, so the result begins with
        // the '\n\n' separator that precedes the Input characters section.
        expect(prompt.startsWith('\n\n')).toBe(true);
        expect(prompt).toContain('Input characters:');
    });
});

describe('formatLorebookSummaryField', () => {
    test('returns labeled section for non-empty value', () => {
        expect(h.formatLorebookSummaryField('Description', 'Tall elf')).toBe(
            'Description:\nTall elf',
        );
    });

    test('returns empty string for empty/whitespace value', () => {
        expect(h.formatLorebookSummaryField('Description', '')).toBe('');
        expect(h.formatLorebookSummaryField('Description', '   ')).toBe('');
        expect(h.formatLorebookSummaryField('Description', null)).toBe('');
        expect(h.formatLorebookSummaryField('Description', undefined)).toBe('');
    });
});

describe('buildLorebookEntryContent', () => {
    const fullCharacter = {
        name: 'Alice',
        description: 'Original description',
        data: {
            personality: 'Curious',
            scenario: 'Shared scene',
            first_mes: 'Hello there.',
            mes_example: '<START>Example chat',
        },
    };

    test('includes only selected fields plus always-included name/description', () => {
        const content = h.buildLorebookEntryContent(fullCharacter, [
            'name',
            'description',
            'scenario',
        ]);
        expect(content).toContain('Name: Alice');
        expect(content).toContain('Description:\nOriginal description');
        expect(content).toContain('Scenario:\nShared scene');
        expect(content).not.toContain('Personality:');
        expect(content).not.toContain('First message:');
        expect(content).not.toContain('Example messages:');
    });

    test('includes every field by default', () => {
        const content = h.buildLorebookEntryContent(fullCharacter);
        expect(content).toContain('Name: Alice');
        expect(content).toContain('Personality:\nCurious');
        expect(content).toContain('First message:\nHello there.');
        expect(content).toContain('Example messages:\n<START>Example chat');
    });

    test('omits blank sections', () => {
        const content = h.buildLorebookEntryContent({ name: 'Alice' });
        expect(content).toBe('Name: Alice');
    });
});

describe('buildLorebookEntry', () => {
    const fullCharacter = {
        name: 'Alice',
        description: 'Original description',
        data: {
            personality: 'Curious',
            scenario: 'Shared scene',
            first_mes: 'Hello there.',
            mes_example: '<START>Example chat',
        },
    };

    test('produces a deterministic entry keyed by name and index', () => {
        const entry = h.buildLorebookEntry(fullCharacter, 3);

        expect(entry).toMatchObject({
            uid: 3,
            enabled: true,
            key: ['Alice', 'alice'],
            keysecondary: [],
            comment:
                'Alice — Description, Personality, Scenario, First mes, Mes example',
            addMemo: true,
            order: 97, // 100 - uid
            aiFunctionName: 'alice',
            aiDescription: 'Content for Alice',
            selective: false,
        });
        expect(entry.content).toContain('Name: Alice');
        expect(entry.content).toContain('Description:\nOriginal description');
    });

    test('comment includes always-included Description plus selected labels', () => {
        // 'description' is always-included, so it always appears even when the
        // caller only selects 'scenario'.
        const entry = h.buildLorebookEntry(fullCharacter, 0, ['scenario']);
        expect(entry.comment).toBe('Alice — Description, Scenario');
    });

    test('comment still lists Description when no optional fields selected', () => {
        const entry = h.buildLorebookEntry(fullCharacter, 0, []);
        expect(entry.comment).toBe('Alice — Description');
    });

    test('disambiguates name collisions using the avatar slug', () => {
        const a = { name: 'Alice', avatar: 'a.png' };
        const b = { name: 'Alice', avatar: 'b.png' };
        const entry = h.buildLorebookEntry(a, 0, ['description'], [a, b]);
        expect(entry.key).toEqual(['Alice (a)', 'Alice', 'alice']);
        expect(entry.comment).toBe('Alice (a) — Description');
    });

    test('clamps non-integer/negative index to uid 0', () => {
        expect(h.buildLorebookEntry(fullCharacter, -1).uid).toBe(0);
        expect(h.buildLorebookEntry(fullCharacter, 1.5).uid).toBe(0);
        expect(h.buildLorebookEntry(fullCharacter, 'x').uid).toBe(0);
    });
});

describe('buildLorebookData', () => {
    test('creates one keyed entry per selected character', () => {
        const data = h.buildLorebookData([
            { name: 'Alice' },
            { data: { name: 'Bob' } },
        ]);

        expect(Object.keys(data.entries)).toEqual(['0', '1']);
        expect(data.entries[0].key).toEqual(['Alice', 'alice']);
        expect(data.entries[1].key).toEqual(['Bob', 'bob']);
    });

    test('returns empty entries for null/empty input', () => {
        expect(h.buildLorebookData(null)).toEqual({ entries: {} });
        expect(h.buildLorebookData([])).toEqual({ entries: {} });
        expect(h.buildLorebookData(undefined)).toEqual({ entries: {} });
    });

    test('entries are independent deep clones (no shared references)', () => {
        const data = h.buildLorebookData([{ name: 'Alice' }]);
        data.entries[0].key.push('mutated');
        const fresh = h.buildLorebookData([{ name: 'Alice' }]);
        expect(fresh.entries[0].key).toEqual(['Alice', 'alice']);
    });

    test('threads the field selection through to entry content', () => {
        const data = h.buildLorebookData(
            [
                {
                    name: 'Alice',
                    description: 'Desc',
                    data: { personality: 'P' },
                },
            ],
            ['personality'],
        );
        expect(data.entries[0].content).toContain('Personality:\nP');
    });
});

describe('extractAllTopLevelXmlBlocks', () => {
    test('extracts top-level character and non-character blocks', () => {
        const blocks = h.extractAllTopLevelXmlBlocks(
            '<setting>Keep</setting>\n\n<character><name>Alice</name></character>',
        );
        expect(blocks).toHaveLength(2);
        expect(blocks[0].tag).toBe('setting');
        expect(blocks[0].content).toBe('Keep');
        expect(blocks[1].tag).toBe('character');
        expect(blocks[1].content).toBe('<name>Alice</name>');
    });

    test('preserves openTag including attributes', () => {
        const [block] = h.extractAllTopLevelXmlBlocks(
            '<character name="Alice" role="lead"><name>Alice</name></character>',
        );
        expect(block.openTag).toBe('<character name="Alice" role="lead">');
    });

    test('returns empty array for null/empty/whitespace input', () => {
        expect(h.extractAllTopLevelXmlBlocks(null)).toEqual([]);
        expect(h.extractAllTopLevelXmlBlocks(undefined)).toEqual([]);
        expect(h.extractAllTopLevelXmlBlocks('')).toEqual([]);
        expect(h.extractAllTopLevelXmlBlocks('   ')).toEqual([]);
    });

    test('does not descend into nested same-name blocks', () => {
        const blocks = h.extractAllTopLevelXmlBlocks(
            '<rules><rules>inner</rules><note>outer</note></rules>',
        );
        expect(blocks).toHaveLength(1);
        expect(blocks[0].tag).toBe('rules');
        expect(blocks[0].content).toContain('<rules>inner</rules>');
    });

    test('skips self-closing tags without consuming following content', () => {
        const blocks = h.extractAllTopLevelXmlBlocks(
            '<setting>Dungeon</setting><marker/><character><name>Alice</name></character>',
        );
        const tags = blocks.map((b) => b.tag);
        expect(tags).toContain('setting');
        expect(tags).toContain('character');
        expect(tags).not.toContain('marker');
    });
});

describe('buildDynamicLorebookData', () => {
    test('builds entries from generated character blocks, stripping summaries', () => {
        const xml = [
            '<setting>Keep in card</setting>',
            '<character><summary>Brief Alice</summary><name>Alice</name><description>Full Alice</description></character>',
            '<character><summary>Brief Bob</summary><name>Bob</name><description>Full Bob</description></character>',
        ].join('\n\n');

        const data = h.buildDynamicLorebookData(xml);

        expect(Object.keys(data.entries)).toEqual(['0', '1']);
        expect(data.entries[0].key).toEqual(['Alice', 'alice']);
        expect(data.entries[0].comment).toBe('Alice — Dynamic Entry');
        expect(data.entries[0].content).toBe(
            '<character><name>Alice</name><description>Full Alice</description></character>',
        );
        expect(data.entries[0].content).not.toContain('<summary>');
        expect(data.entries[1].key).toEqual(['Bob', 'bob']);
    });

    test('ignores non-character top-level blocks', () => {
        const data = h.buildDynamicLorebookData(
            '<setting>Keep</setting>\n\n<character><summary>B</summary><name>Alice</name></character>',
        );
        expect(Object.keys(data.entries)).toEqual(['0']);
        expect(data.entries[0].key).toEqual(['Alice', 'alice']);
    });

    test('returns empty entries for null/empty input', () => {
        expect(h.buildDynamicLorebookData(null)).toEqual({ entries: {} });
        expect(h.buildDynamicLorebookData('')).toEqual({ entries: {} });
        expect(h.buildDynamicLorebookData(undefined)).toEqual({
            entries: {},
        });
    });

    test('uses comment/keys extracted from <comment>/<keys> tags when present', () => {
        const data = h.buildDynamicLorebookData(
            '<character><comment>Custom Comment</comment><keys>alias1,alias2</keys><name>Alice</name></character>',
        );
        expect(data.entries[0].comment).toBe('Custom Comment');
        expect(data.entries[0].key).toEqual(['alias1', 'alias2']);
    });

    test('disambiguates duplicate character names via source avatar', () => {
        const xml = [
            '<character><name>Alice</name></character>',
            '<character><name>Alice</name></character>',
        ].join('\n\n');
        const sources = [
            { name: 'Alice', avatar: 'a.png' },
            { name: 'Alice', avatar: 'b.png' },
        ];

        const data = h.buildDynamicLorebookData(xml, sources);

        expect(data.entries[0].key).toEqual(['Alice (a)', 'Alice', 'alice']);
        expect(data.entries[1].key).toEqual(['Alice (b)', 'Alice', 'alice']);
    });
});

describe('buildDynamicSummaryDescription', () => {
    test('converts character blocks to name+summary and preserves other blocks', () => {
        const xml = [
            '<setting>Keep in card</setting>',
            '<character><summary>Brief Alice</summary><name>Alice</name><description>Full Alice</description></character>',
            '<rules>Also keep</rules>',
        ].join('\n\n');

        expect(h.buildDynamicSummaryDescription(xml)).toBe(
            [
                '<setting>Keep in card</setting>',
                '<character>\n  <name>Alice</name>\n  <summary>Brief Alice</summary>\n</character>',
                '<rules>Also keep</rules>',
            ].join('\n\n'),
        );
    });

    test('returns empty string for empty/null input', () => {
        expect(h.buildDynamicSummaryDescription('')).toBe('');
        expect(h.buildDynamicSummaryDescription(null)).toBe('');
        expect(h.buildDynamicSummaryDescription(undefined)).toBe('');
    });

    test('preserves only non-character blocks when no characters present', () => {
        expect(
            h.buildDynamicSummaryDescription(
                '<setting>Dungeon</setting>\n\n<rules>Stay quiet</rules>',
            ),
        ).toBe('<setting>Dungeon</setting>\n\n<rules>Stay quiet</rules>');
    });
});

describe('validateGroupCardRequest', () => {
    function makeToaster() {
        return { warning: jest.fn(), error: jest.fn() };
    }

    test('returns a valid result for a well-formed request', () => {
        const toaster = makeToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        const result = h.validateGroupCardRequest('Group', [0, 1], {
            characterList,
            worldNames: [],
            toaster,
        });

        expect(result).toEqual({
            groupName: 'Group',
            characters: [{ name: 'Alice' }, { name: 'Bob' }],
            collisions: { character: false, lorebook: false },
        });
        expect(toaster.warning).not.toHaveBeenCalled();
    });

    test('trims the group name in the returned result', () => {
        const result = h.validateGroupCardRequest('  Group  ', [
            { name: 'Alice' },
            { name: 'Bob' },
        ], { characterList: [], worldNames: [] });
        expect(result.groupName).toBe('Group');
    });

    test('rejects empty/whitespace name and warns', () => {
        const toaster = makeToaster();
        const result = h.validateGroupCardRequest('   ', [
            { name: 'Alice' },
            { name: 'Bob' },
        ], { characterList: [], worldNames: [], toaster });

        expect(result).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith(
            'Enter a group card name.',
            'Combine into Group Card',
        );
    });

    test('rejects null/undefined name', () => {
        const toaster = makeToaster();
        expect(
            h.validateGroupCardRequest(null, [
                { name: 'Alice' },
                { name: 'Bob' },
            ], { characterList: [], worldNames: [], toaster }),
        ).toBeNull();
        expect(
            h.validateGroupCardRequest(undefined, [
                { name: 'Alice' },
                { name: 'Bob' },
            ], { characterList: [], worldNames: [], toaster }),
        ).toBeNull();
    });

    test('rejects fewer than two valid characters and warns', () => {
        const toaster = makeToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        const result = h.validateGroupCardRequest('Group', [0], {
            characterList,
            worldNames: [],
            toaster,
        });

        expect(result).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );
    });

    test('rejects characters with missing names as invalid', () => {
        const toaster = makeToaster();
        const result = h.validateGroupCardRequest('Group', [
            { description: 'no name' },
            { data: {} },
        ], { characterList: [], worldNames: [], toaster });

        expect(result).toBeNull();
        expect(toaster.warning).toHaveBeenCalledWith(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );
    });

    test('flags a character name collision', () => {
        const toaster = makeToaster();
        const characterList = [
            { name: 'Alice' },
            { name: 'Bob' },
            { name: 'Existing Group' },
        ];

        const result = h.validateGroupCardRequest(' Existing Group ', [0, 1], {
            characterList,
            worldNames: [],
            toaster,
        });

        expect(result.collisions).toEqual({
            character: true,
            lorebook: false,
        });
    });

    test('flags a lorebook name collision only when lorebook creation is enabled', () => {
        const toaster = makeToaster();
        const characterList = [{ name: 'Alice' }, { name: 'Bob' }];

        const collisionResult = h.validateGroupCardRequest('Shared Lore', [
            0,
            1,
        ], {
            characterList,
            worldNames: [' shared lore '],
            toaster,
        });
        expect(collisionResult.collisions.lorebook).toBe(true);

        const noCollisionResult = h.validateGroupCardRequest('Shared Lore', [
            0,
            1,
        ], {
            characterList,
            worldNames: [' shared lore '],
            toaster,
            createLorebook: false,
        });
        expect(noCollisionResult.collisions.lorebook).toBe(false);
    });
});

describe('toGroupCardJobState', () => {
    test('maps a raw server job into the lightweight state shape', () => {
        const state = h.toGroupCardJobState({
            id: 'job-1',
            config: { groupName: 'Group' },
            createdAt: 1234567890,
            status: 'running',
        });

        expect(state).toEqual({
            jobId: 'job-1',
            groupName: 'Group',
            loaderHandle: null,
            source: null,
            startedAt: 1234567890,
            status: 'running',
        });
    });

    test('defaults missing config/createdAt gracefully', () => {
        const state = h.toGroupCardJobState({ id: 'job-2', status: 'done' });
        expect(state.groupName).toBe('');
        expect(state.startedAt).toBeUndefined();
    });
});

describe('group card wizard metadata helpers', () => {
    test('getGroupCardWizardMetadata reads the extensions key', () => {
        expect(
            h.getGroupCardWizardMetadata({
                data: {
                    extensions: {
                        [h.GROUP_CARD_WIZARD_METADATA_KEY]: { stage: 3 },
                    },
                },
            }),
        ).toEqual({ stage: 3 });
    });

    test('getGroupCardWizardMetadata returns null when absent', () => {
        expect(h.getGroupCardWizardMetadata({ data: { extensions: {} } })).toBeNull();
        expect(h.getGroupCardWizardMetadata({})).toBeNull();
        expect(h.getGroupCardWizardMetadata(null)).toBeNull();
    });

    test('isGroupCardWizardCharacter reflects metadata presence', () => {
        expect(
            h.isGroupCardWizardCharacter({
                data: {
                    extensions: {
                        [h.GROUP_CARD_WIZARD_METADATA_KEY]: { stage: 1 },
                    },
                },
            }),
        ).toBe(true);
        expect(h.isGroupCardWizardCharacter({})).toBe(false);
    });
});
