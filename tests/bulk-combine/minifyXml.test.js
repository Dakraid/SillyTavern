/* eslint-disable playwright/no-standalone-expect -- Jest suite; no Playwright matchers. */
import { describe, expect, test } from '@jest/globals';

import { minifyXml } from '../../public/scripts/group-card-xml-parser.js';

const ATTRIBUTE_XML = `<character double="keep  both" lines="line one
line two" angle='left > right'>  Alpha   Beta  </character>`;
const ATTRIBUTE_EXPECTED = `<character double="keep  both" lines="line one
line two" angle='left > right'>Alpha Beta</character>`;

describe('bulk combine XML minification', () => {
    test.each([
        ['compact', { compact: true }],
        ['singleLine', { singleLine: true }],
    ])('preserves quoted attribute contents verbatim in %s mode', (_name, options) => {
        expect(minifyXml(ATTRIBUTE_XML, options)).toBe(ATTRIBUTE_EXPECTED);
    });

    test('singleLine concatenates tags without inserted whitespace', () => {
        const output = minifyXml('<root>\n  <a> One </a>\n  <b value="x > y"> Two </b>\n</root>', { singleLine: true });

        expect(output).toBe('<root><a>One</a><b value="x > y">Two</b></root>');
        expect(output).not.toContain('> <');
    });

    test('compact mode keeps line-based element joins while collapsing text nodes', () => {
        expect(minifyXml('<root>\n <a> Alpha   \n Beta </a>\n <b> Gamma </b>\n</root>', { compact: true }))
            .toBe('<root>\n<a>Alpha Beta</a>\n<b>Gamma</b>\n</root>');
    });

    test('strips comments before quote-aware tokenization', () => {
        const input = '<root><!-- a comment with "quotes >" and \'single >\' --><a>Text</a></root>';
        expect(minifyXml(input, { singleLine: true })).toBe('<root><a>Text</a></root>');
    });
});
