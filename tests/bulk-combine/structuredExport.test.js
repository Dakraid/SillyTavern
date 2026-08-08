'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

import { describe, expect, test } from '@jest/globals';
import {
    composeSummaries,
    lorebookEntriesFromDocs,
    minifyForFormat,
    serializeDoc,
} from '../../public/scripts/bulk-combine/structured/export.js';

const characterDoc = [{
    name: 'character',
    attributes: { name: 'A & B' },
    text: '',
    unknown: false,
    children: [{
        name: 'summary',
        attributes: { name: 'Alice', aliases: 'Al, Ally' },
        text: 'Short <summary>',
        unknown: false,
        children: [],
    }],
}];

const noSummaryDoc = [{
    name: 'character',
    attributes: { name: 'Bob' },
    text: 'Full Bob',
    unknown: false,
    children: [],
}];

describe('structured export', () => {
    test('serializes canonical XML and JSON fixtures', () => {
        expect(serializeDoc(characterDoc, 'xml')).toBe([
            '<character name="A &amp; B">',
            '  <summary name="Alice" aliases="Al, Ally">Short &lt;summary&gt;</summary>',
            '</character>',
        ].join('\n'));
        expect(serializeDoc(characterDoc, 'json')).toBe(JSON.stringify({
            character: {
                '@name': 'A & B',
                summary: {
                    '@name': 'Alice',
                    '@aliases': 'Al, Ally',
                    '#text': 'Short <summary>',
                },
            },
        }, null, 2));
    });

    test('serializes TOON through an injected encoder and falls back to JSON', () => {
        const encoded = serializeDoc(characterDoc, 'toon', {
            toonEncode: (value) => `TOON:${value.character.summary['#text']}`,
        });
        expect(encoded).toBe('TOON:Short <summary>');
        expect(serializeDoc(characterDoc, 'toon')).toBe(serializeDoc(characterDoc, 'json'));
    });

    test('composes summary elements and falls back to a full document', () => {
        expect(composeSummaries([characterDoc, noSummaryDoc], 'xml')).toBe([
            '<characters>',
            '  <summary name="Alice" aliases="Al, Ally">Short &lt;summary&gt;</summary>',
            '  <character name="Bob">Full Bob</character>',
            '</characters>',
        ].join('\n'));
        expect(JSON.parse(composeSummaries([characterDoc, noSummaryDoc], 'json'))).toEqual({
            characters: [
                {
                    '@name': 'Alice',
                    '@aliases': 'Al, Ally',
                    '#text': 'Short <summary>',
                },
                { character: { '@name': 'Bob', '#text': 'Full Bob' } },
            ],
        });
        expect(composeSummaries([characterDoc], 'toon', {
            toonEncode: (value) => `count=${value.characters.length}`,
        })).toBe('count=1');
    });

    test('derives lorebook keys and comments with source-name fallback', () => {
        const entries = lorebookEntriesFromDocs([characterDoc, noSummaryDoc], 'json', {
            sourceNames: ['Source A', 'Source B'],
        });
        expect(entries[0]).toEqual({
            key: ['Alice', 'Al', 'Ally'],
            comment: 'Alice',
            content: serializeDoc(characterDoc, 'json'),
        });
        expect(entries[1]).toEqual({
            key: ['Bob'],
            comment: 'Bob',
            content: serializeDoc(noSummaryDoc, 'json'),
        });
    });

    test('threads the TOON codec into lorebook entry content', () => {
        const entries = lorebookEntriesFromDocs([characterDoc], 'toon', {
            codecs: { toonEncode: (value) => `TOON:${value.character.summary['#text']}` },
        });
        expect(entries[0].content).toBe('TOON:Short <summary>');
        expect(lorebookEntriesFromDocs([characterDoc], 'toon')[0].content)
            .toBe(serializeDoc(characterDoc, 'json'));
    });

    test('minifies by format and preserves broken JSON and TOON', () => {
        expect(minifyForFormat('<a>\n  x\n</a>', 'xml')).toBe('<a>x</a>');
        expect(minifyForFormat('{\n  "a": 1\n}', 'json')).toBe('{"a":1}');
        expect(minifyForFormat('{broken', 'json')).toBe('{broken');
        expect(minifyForFormat('toon data', 'toon')).toBe('toon data');
    });
});
