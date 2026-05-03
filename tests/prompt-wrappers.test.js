import {
    applyPromptWrapperToText,
    calculatePromptOrderRenumber,
    normalizePromptWrapperTag,
    stripPromptWrapperTags,
    wrapPromptWrapperText,
} from '../public/scripts/prompt-wrappers.js';

describe('prompt wrappers', () => {
    test('escapes unsafe angle brackets but preserves spaces and symbols', () => {
        expect(normalizePromptWrapperTag('Dr. Bob!')).toBe('Dr. Bob!');
        expect(normalizePromptWrapperTag('A<B>C')).toBe('A&lt;B&gt;C');
        expect(normalizePromptWrapperTag('   ')).toBe('Unknown');
    });

    test('wraps once and collapses duplicate same outer tags', () => {
        const wrapped = wrapPromptWrapperText('<Alice><Alice>Hello</Alice></Alice></Alice>', 'Alice');
        expect(wrapped.mes).toBe('<Alice>Hello</Alice>');
        expect(wrapped.base_mes).toBe('Hello');
    });

    test('unwrap uses exact provenance base content', () => {
        const result = applyPromptWrapperToText({
            text: '<Alice>changed</Alice>',
            extra: { prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: 'exact <content>', version: 1 } },
            role: 'assistant',
            tag: 'Alice',
            enabled: false,
        });
        expect(result.text).toBe('exact <content>');
        expect(result.extra.prompt_wrapper).toBeUndefined();
    });

    test('legacy same outer tags are removed without provenance', () => {
        expect(stripPromptWrapperTags('<Kris><Kris>Hi</Kris></Kris></Kris>', 'Kris')).toBe('Hi');
    });
});

describe('prompt manager bulk order renumber', () => {
    test('supports all approved renumber directions', () => {
        expect(calculatePromptOrderRenumber(4, 10, 'first-inc')).toEqual([10, 11, 12, 13]);
        expect(calculatePromptOrderRenumber(4, 10, 'first-dec')).toEqual([10, 9, 8, 7]);
        expect(calculatePromptOrderRenumber(4, 10, 'last-inc')).toEqual([13, 12, 11, 10]);
        expect(calculatePromptOrderRenumber(4, 10, 'last-dec')).toEqual([7, 8, 9, 10]);
    });

    test('rejects negative, decimal, or resulting negative order values', () => {
        expect(() => calculatePromptOrderRenumber(1, -1, 'first-inc')).toThrow();
        expect(() => calculatePromptOrderRenumber(1, 1.5, 'first-inc')).toThrow();
        expect(() => calculatePromptOrderRenumber(4, 0, 'first-dec')).toThrow();
    });
});
