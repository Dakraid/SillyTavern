import { describe, expect, jest, test } from '@jest/globals';

import {
    CORE_FIELDS,
    ALWAYS_INCLUDED_FIELDS,
    OPTIONAL_FIELDS,
    normalizeSelectedFields,
    getSourceField,
    buildCharacterXmlBlock,
    buildIndividualPrompt,
    buildCombinedPrompt,
    buildMergedPassPrompt,
    preflightTokens,
    buildPostProcessPrompt,
} from '../../src/util/bulk-combine/prompt-builders.js';

function source(key, name, fields = {}) {
    return {
        key,
        name,
        avatar: null,
        fields: {
            name,
            description: `${name} description`,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            ...fields,
        },
        snapshotHash: `${key}-hash`,
    };
}

describe('bulk combine prompt builders', () => {
    describe('field selection', () => {
        test('exports frozen, stable, disjoint field constants', () => {
            expect(CORE_FIELDS).toEqual([
                'name',
                'description',
                'personality',
                'scenario',
                'first_mes',
                'mes_example',
            ]);
            expect(ALWAYS_INCLUDED_FIELDS).toEqual(['name', 'description']);
            expect(OPTIONAL_FIELDS).toEqual([
                'personality',
                'scenario',
                'first_mes',
                'mes_example',
            ]);
            expect(Object.isFrozen(CORE_FIELDS)).toBe(true);
            expect(Object.isFrozen(ALWAYS_INCLUDED_FIELDS)).toBe(true);
            expect(Object.isFrozen(OPTIONAL_FIELDS)).toBe(true);
            expect(ALWAYS_INCLUDED_FIELDS.filter((field) => OPTIONAL_FIELDS.includes(field))).toEqual([]);
        });

        test('defaults non-arrays to all core fields', () => {
            for (const fields of [null, undefined, {}, 'name']) {
                expect(normalizeSelectedFields(fields)).toEqual(CORE_FIELDS);
            }
        });

        test('drops unknowns, deduplicates, and returns core order', () => {
            expect(normalizeSelectedFields([
                'mes_example',
                'unknown',
                'personality',
                'mes_example',
                'name',
            ])).toEqual(['name', 'description', 'personality', 'mes_example']);
        });
    });

    describe('source fields and XML', () => {
        test('resolves field name before display-name fallback and safely handles missing values', () => {
            expect(getSourceField(source('a', 'Display', { name: 'Field Name' }), 'name')).toBe('Field Name');
            expect(getSourceField({ name: 'Display', fields: {} }, 'name')).toBe('Display');
            expect(getSourceField({}, 'description')).toBe('');
            expect(getSourceField(null, 'description')).toBe('');
            expect(getSourceField({ fields: { scenario: 42 } }, 'scenario')).toBe('42');
        });

        test('always includes name and description, includes selected empty optionals, and escapes values', () => {
            const item = source('a', 'A <B>', {
                description: 'Use > & "double" and \'single\'',
                personality: '',
                scenario: 'ignored',
            });

            expect(buildCharacterXmlBlock(item, ['personality'])).toBe([
                '<character>',
                '  <name>A &lt;B&gt;</name>',
                '  <description>Use &gt; &amp; &quot;double&quot; and &#039;single&#039;</description>',
                '  <personality></personality>',
                '</character>',
            ].join('\n'));
        });
    });

    describe('prompt composition', () => {
        test('keeps the legacy individual prompt byte-identical without extras', () => {
            const item = source('a', 'Alpha');
            const block = buildCharacterXmlBlock(item, []);
            const fixture = `Transform\n\n${block}\n\nAdditional guidance: Focus on voice`;

            expect(buildIndividualPrompt(item, 'Transform', [], 'Focus on voice')).toBe(fixture);
            expect(buildIndividualPrompt(item, 'Transform', [], 'Focus on voice', {})).toBe(fixture);
            expect(buildIndividualPrompt(item, 'Transform', [], '   ')).toBe(`Transform\n\n${block}`);
        });

        test('places structure instructions and notes before regeneration guidance', () => {
            const item = source('a', 'Alpha');
            const block = buildCharacterXmlBlock(item, []);

            expect(buildIndividualPrompt(item, 'Transform', [], 'Focus', {
                note: 'Keep the scar',
                structureInstructions: 'Return structured XML',
            })).toBe([
                'Transform',
                'Return structured XML',
                block,
                'Character notes: Keep the scar',
                'Additional guidance: Focus',
            ].join('\n\n'));
        });

        test('builds one combined prompt in source order and tolerates an empty prompt', () => {
            const alpha = source('a', 'Alpha');
            const beta = source('b', 'Beta');
            const alphaBlock = buildCharacterXmlBlock(alpha, []);
            const betaBlock = buildCharacterXmlBlock(beta, []);

            expect(buildCombinedPrompt([alpha, beta], 'Transform', [])).toBe(
                `Transform\n\n${alphaBlock}\n\n${betaBlock}`,
            );
            expect(buildIndividualPrompt(alpha, null, [])).toBe(`\n\n${alphaBlock}`);
            expect(buildCombinedPrompt([alpha], '', [])).toBe(`\n\n${alphaBlock}`);
        });

        test('builds a merged follow-up prompt with optional structure instructions', () => {
            expect(buildMergedPassPrompt('Improve', '<character><name>Merged</name></character>', 'Tighter prose')).toBe(
                'Improve\n\n<character><name>Merged</name></character>\n\nAdditional guidance: Tighter prose',
            );
            expect(buildMergedPassPrompt('Summarize', '  <character />  ', '', {
                structureInstructions: 'Return one summary element',
            })).toBe('Summarize\n\nReturn one summary element\n\n<character />');
        });
    });

    describe('token preflight', () => {
        test('returns per-item counts under the limit', async () => {
            const countFn = jest.fn(async (text) => text.length);

            await expect(preflightTokens({
                prompts: [{ key: 'a', text: '12345' }],
                outputTokens: 4,
                contextTokens: 10,
                model: 'model-a',
            }, countFn)).resolves.toEqual({
                ok: true,
                blocked: [],
                items: [{ key: 'a', inputTokens: 5, total: 9 }],
            });
        });

        test('blocks overflow with exact overage and does not alter prompt text', async () => {
            const prompt = { key: 'a', text: 'unchanged prompt' };
            const countFn = jest.fn(async () => 8);
            const result = await preflightTokens({
                prompts: [prompt],
                outputTokens: 5,
                contextTokens: 10,
                model: 'model-a',
            }, countFn);

            expect(result).toEqual({
                ok: false,
                blocked: [{ key: 'a', inputTokens: 8, overage: 3 }],
                items: [{ key: 'a', inputTokens: 8, total: 13 }],
            });
            expect(prompt.text).toBe('unchanged prompt');
        });

        test('blocks an over-context prompt when output tokens are unset', async () => {
            await expect(preflightTokens({
                prompts: [{ key: 'a', text: 'prompt' }],
                outputTokens: null,
                contextTokens: 10,
                model: 'model-a',
            }, async () => 11)).resolves.toEqual({
                ok: false,
                blocked: [{ key: 'a', inputTokens: 11, overage: 1 }],
                items: [{ key: 'a', inputTokens: 11, total: 11 }],
            });
        });

        test('treats null, zero, and invalid context limits as non-blocking', async () => {
            for (const contextTokens of [null, 0, Number.NaN]) {
                const result = await preflightTokens({
                    prompts: [{ key: 'a', text: 'prompt' }],
                    outputTokens: 100,
                    contextTokens,
                    model: 'model-a',
                }, async () => 1000);

                expect(result.ok).toBe(true);
                expect(result.blocked).toEqual([]);
            }
        });

        test('calls the counter once per item with model passthrough', async () => {
            const countFn = jest.fn(async () => 1);
            await preflightTokens({
                prompts: [
                    { key: 'a', text: 'Alpha prompt' },
                    { key: 'b', text: 'Beta prompt' },
                ],
                outputTokens: 0,
                contextTokens: 0,
                model: 'chosen-model',
            }, countFn);

            expect(countFn.mock.calls).toEqual([
                ['Alpha prompt', 'chosen-model'],
                ['Beta prompt', 'chosen-model'],
            ]);
        });
    });

    test('builds the legacy post-process prompt format', () => {
        expect(buildPostProcessPrompt(' Polish ', ' <character /> ')).toBe(
            'Polish\n\nMerged character definitions:\n<character />',
        );
    });
});
