/* eslint-disable playwright/no-standalone-expect -- Jest suite; no Playwright matchers. */
import { describe, expect, test } from '@jest/globals';

import { REFUSAL_PATTERNS, isRefusal } from '../../src/util/bulk-combine/refusal.js';

const REFUSALS = [
    'I\'m sorry, but I can\'t help.',
    'I am sorry, that request is not possible.',
    'Sorry, but I cannot assist.',
    'I can\'t do that.',
    'I cannot do that.',
    'I can’t do that.',
    'I\'m unable to help.',
    'I am unable to help.',
    'I\'m not able to provide that.',
    'I refuse this request.',
    'I must decline.',
    'I have to decline.',
    'As an AI, I cannot help.',
    'This is against my guidelines.',
    'This is against my programming.',
    'I cannot comply.',
    'I am unable to comply.',
    'I cannot fulfill this request.',
    'I can\'t fulfill this request.',
];

describe('bulk combine refusal detection', () => {
    test.each(REFUSALS)('detects %s', (text) => {
        expect(isRefusal(text)).toBe(true);
    });

    test('keeps every configured pattern exercised', () => {
        for (const pattern of REFUSAL_PATTERNS) {
            expect(REFUSALS.some(text => pattern.test(text.toLowerCase()))).toBe(true);
        }
    });

    test('only scans the first 300 trimmed characters', () => {
        expect(isRefusal(`${'x'.repeat(290)} I can't`)).toBe(true);
        expect(isRefusal(`${'x'.repeat(300)} I can't`)).toBe(false);
    });

    test('does not flag normal roleplay prose outside the opening window', () => {
        const output = `${'The scene continues with detailed narration. '.repeat(10)}He said "I can't believe it".`;
        expect(isRefusal(output)).toBe(false);
        expect(isRefusal('I can\'t do that.')).toBe(true);
    });

    test('rejects empty, whitespace, and non-string values', () => {
        for (const value of ['', '   \n', null, undefined, 42, {}]) {
            expect(isRefusal(value)).toBe(false);
        }
    });
});
