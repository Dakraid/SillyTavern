import { describe, expect, test } from 'vitest';

import {
    extractCommentFromCharacterBlock,
    extractKeysFromCharacterBlock,
    extractXmlBlocksByTag,
    stripSummaryFromCharacterBlock,
} from '../public/scripts/group-card-xml-parser.js';

function getCharacterBlock(xml) {
    return extractXmlBlocksByTag(xml, 'character')[0];
}

describe('dynamic lorebook XML metadata', () => {
    test('extracts trimmed comment from the first comment tag', () => {
        const block = getCharacterBlock(`
<character>
  <name>Alice</name>
  <comment>  My Title  </comment>
  <comment>Ignored</comment>
  <summary>Short bio.</summary>
</character>
`);

        expect(extractCommentFromCharacterBlock(block)).toBe('My Title');
    });

    test('returns empty comment when comment tag is absent or empty', () => {
        expect(extractCommentFromCharacterBlock(getCharacterBlock('<character><name>Alice</name></character>'))).toBe('');
        expect(extractCommentFromCharacterBlock(getCharacterBlock('<character><comment>   </comment></character>'))).toBe('');
    });

    test('extracts comma-separated keys with whitespace trimmed and newlines stripped', () => {
        const block = getCharacterBlock(`
<character>
  <name>Alice</name>
  <keys>alice ,\n bob ,carol</keys>
</character>
`);

        expect(extractKeysFromCharacterBlock(block)).toEqual(['alice', 'bob', 'carol']);
    });

    test('filters empty keys and returns an empty array when keys are absent or empty', () => {
        expect(extractKeysFromCharacterBlock(getCharacterBlock('<character><name>Alice</name></character>'))).toEqual([]);
        expect(extractKeysFromCharacterBlock(getCharacterBlock('<character><keys>, ,\n ,</keys></character>'))).toEqual([]);
    });

    test('accepts raw character XML strings for comment and key extraction', () => {
        const raw = '<character><comment>My Title</comment><keys>alice, bob</keys></character>';

        expect(extractCommentFromCharacterBlock(raw)).toBe('My Title');
        expect(extractKeysFromCharacterBlock(raw)).toEqual(['alice', 'bob']);
    });

    test('strips summary, comment, and keys from entry content', () => {
        const stripped = stripSummaryFromCharacterBlock(`
<character>
  <name>Alice</name>
  <comment>My Title</comment>
  <keys>alice, bob</keys>
  <summary>Short bio.</summary>
  <description>Long-form content.</description>
</character>
`);

        expect(stripped).toContain('<name>Alice</name>');
        expect(stripped).toContain('<description>Long-form content.</description>');
        expect(stripped).not.toContain('<summary>');
        expect(stripped).not.toContain('<comment>');
        expect(stripped).not.toContain('<keys>');
    });
});
