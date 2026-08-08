'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

import { describe, expect, test } from '@jest/globals';
import { DEFAULT_TEMPLATE } from '../../public/scripts/bulk-combine/structured/templateModel.js';
import { parseStructured } from '../../public/scripts/bulk-combine/structured/parse.js';
import {
    annotateUnknown,
    validateAgainstTemplate,
} from '../../public/scripts/bulk-combine/structured/validate.js';

describe('parseStructured', () => {
    test('parses well-formed XML into the generic document shape', () => {
        const result = parseStructured('<character name="A"><summary aliases="Al">Hello</summary></character>', 'xml');
        expect(parseStructured('<character name="Empty"/> trailing', 'xml')).toMatchObject({
            ok: true,
            doc: [{ name: 'character', attributes: { name: 'Empty' } }],
        });
        expect(result).toEqual({
            ok: true,
            error: null,
            doc: [{
                name: 'character',
                attributes: { name: 'A' },
                text: '',
                unknown: false,
                children: [{
                    name: 'summary',
                    attributes: { aliases: 'Al' },
                    text: 'Hello',
                    unknown: false,
                    children: [],
                }],
            }],
        });
    });

    test('strips fences and prose, closes XML tags, and removes trailing garbage', () => {
        const result = parseStructured('Here it is:\n```xml\n<character><summary>Hello\n``` trailing', 'xml');
        expect(result.ok).toBe(true);
        expect(result.doc[0].children[0].text).toBe('Hello');
    });

    test('parses fenced JSON with leading and trailing prose', () => {
        const result = parseStructured('Result:\n```json\n{"character":{"@name":"A","summary":{"#text":"Hi"}}}\n``` thanks', 'json');
        expect(result.ok).toBe(true);
        expect(result.doc[0].attributes).toEqual({ name: 'A' });
        expect(result.doc[0].children[0].text).toBe('Hi');
    });

    test('returns short failures rather than throwing', () => {
        expect(parseStructured('not xml', 'xml')).toMatchObject({ ok: false, doc: null });
        expect(parseStructured('before { broken } after', 'json')).toMatchObject({ ok: false, doc: null });
        expect(parseStructured('anything', 'toon')).toEqual({
            ok: false,
            doc: null,
            error: 'TOON decoder unavailable',
        });
    });

    test('uses an injected TOON decoder after stripping fences', () => {
        let received = '';
        const result = parseStructured('```toon\nencoded\n```', 'toon', {
            toonDecode: (text) => {
                received = text;
                return { character: { '#text': 'toon text' } };
            },
        });
        expect(received).toBe('encoded');
        expect(result.doc[0].text).toBe('toon text');
    });
});

describe('structured validation', () => {
    test('reports every issue kind, including the summary 800 cap', () => {
        const doc = [{
            name: 'character',
            attributes: { name: 'A' },
            text: '',
            unknown: false,
            children: [
                {
                    name: 'summary',
                    attributes: { species: 'robot' },
                    text: 'x'.repeat(801),
                    unknown: false,
                    children: [],
                },
                {
                    name: 'mystery',
                    attributes: {},
                    text: 'unknown',
                    unknown: false,
                    children: [],
                },
            ],
        }];
        const issues = validateAgainstTemplate(doc, DEFAULT_TEMPLATE);
        expect(new Set(issues.map((issue) => issue.kind))).toEqual(new Set([
            'missing', 'unknown', 'overlength', 'attribute',
        ]));
        expect(issues).toContainEqual(expect.objectContaining({
            path: '/character/summary',
            kind: 'overlength',
        }));
        expect(issues).toContainEqual(expect.objectContaining({
            path: '/character/mystery',
            kind: 'unknown',
        }));
    });

    test('annotates unknown nodes on the generic document', () => {
        const doc = [{
            name: 'character',
            attributes: {},
            text: '',
            children: [{ name: 'extra', attributes: {}, text: '', children: [], unknown: false }],
            unknown: false,
        }];
        const annotated = annotateUnknown(doc, DEFAULT_TEMPLATE);
        expect(annotated[0].unknown).toBe(false);
        expect(annotated[0].children[0].unknown).toBe(true);
        expect(doc[0].children[0].unknown).toBe(true);
    });
});
