/* eslint-disable playwright/no-standalone-expect -- Jest suite; no Playwright matchers. */
import { describe, expect, test } from '@jest/globals';
import {
    applyProgrammaticReasoningPrefill,
    applyReasoningPrefill,
    REASONING_PREFILL_INJECT_TYPES,
} from '../public/scripts/reasoning-prefill.js';

/**
 * Builds a minimal generation payload with no trailing assistant message.
 * @returns {object} Generation payload
 */
function basePayload() {
    return {
        type: 'normal',
        messages: [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: 'hello' },
        ],
    };
}

describe('REASONING_PREFILL_INJECT_TYPES', () => {
    test('is frozen and contains normal/regenerate/swipe', () => {
        expect(REASONING_PREFILL_INJECT_TYPES).toEqual(['normal', 'regenerate', 'swipe']);
        expect(Object.isFrozen(REASONING_PREFILL_INJECT_TYPES)).toBe(true);
    });
});

describe('applyReasoningPrefill injection', () => {
    test.each(REASONING_PREFILL_INJECT_TYPES)('injects a trailing partial assistant message for type "%s"', (type) => {
        const data = basePayload();
        data.type = type;

        const applied = applyReasoningPrefill(data, type, 'seed the reasoning');

        expect(applied).toBe(true);
        expect(data.messages).toHaveLength(3);
        expect(data.messages[2]).toEqual({
            role: 'assistant',
            content: '',
            reasoning_content: 'seed the reasoning',
            partial: true,
        });
        expect(data.include_reasoning).toBe(true);
    });

    test('trims the prefill before injecting', () => {
        const data = basePayload();

        const applied = applyReasoningPrefill(data, 'normal', '  padded seed  \n');

        expect(applied).toBe(true);
        expect(data.messages[2].reasoning_content).toBe('padded seed');
    });

    test('forces include_reasoning even when explicitly false', () => {
        const data = basePayload();
        data.include_reasoning = false;

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(true);
        expect(data.include_reasoning).toBe(true);
    });

    test.each(['quiet', 'impersonate', 'continue'])('does not inject for type "%s"', (type) => {
        const data = basePayload();
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, type, 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test.each(['', '   ', '\n\t '])('does not inject for empty/whitespace prefill', (prefill) => {
        const data = basePayload();
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', prefill);

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('skips when json_schema is set', () => {
        const data = basePayload();
        data.json_schema = { name: 'schema', schema: { type: 'object' } };
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('skips when the tools array is non-empty', () => {
        const data = basePayload();
        data.tools = [{ type: 'function', function: { name: 'tool' } }];
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('skips when a message has role "tool"', () => {
        const data = basePayload();
        data.messages.push({ role: 'tool', content: 'tool result' });
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('skips when a message has tool_calls', () => {
        const data = basePayload();
        data.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'call_1' }] });
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test.each([undefined, null, 'not-an-array', []])('skips when messages is not a non-empty array', (messages) => {
        const data = { type: 'normal', messages: messages };
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('does not inject when the last message is an assistant message without a think block', () => {
        const data = basePayload();
        data.messages.push({ role: 'assistant', content: 'plain assistant text' });
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
    });

    test('never throws on garbage input', () => {
        expect(applyReasoningPrefill(null, 'normal', 'seed')).toBe(false);
        expect(applyReasoningPrefill(undefined, 'normal', 'seed')).toBe(false);
        expect(applyReasoningPrefill('garbage', 'normal', 'seed')).toBe(false);
        expect(applyReasoningPrefill({}, 'normal', null)).toBe(false);
        expect(applyReasoningPrefill({}, 'normal', 42)).toBe(false);
    });
});

describe('applyReasoningPrefill transform', () => {
    /**
     * Builds a payload whose trailing message is an assistant message with a think block.
     * @param {string} content Assistant message content
     * @returns {object} Generation payload
     */
    function thinkPayload(content) {
        const data = basePayload();
        data.messages.push({ role: 'assistant', content: content });
        return data;
    }

    test('moves a leading <think> block into reasoning_content', () => {
        const data = thinkPayload('<think>reasoning</think>visible');

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(true);
        const message = data.messages[2];
        expect(message.reasoning_content).toBe('reasoning');
        expect(message.content).toBe('visible');
        expect(message.partial).toBe(true);
        expect(data.include_reasoning).toBe(true);
    });

    test('transforms an unterminated <think> block', () => {
        const data = thinkPayload('<think>partial reasoning');

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(true);
        const message = data.messages[2];
        expect(message.reasoning_content).toBe('partial reasoning');
        expect(message.content).toBe('');
        expect(message.partial).toBe(true);
    });

    test('transforms a <think> block with leading whitespace', () => {
        const data = thinkPayload('  \n<think>spaced</think>visible');

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(true);
        const message = data.messages[2];
        expect(message.reasoning_content).toBe('spaced');
        expect(message.content).toBe('visible');
        expect(message.partial).toBe(true);
    });

    test('prepends captured reasoning to existing reasoning_content with a newline', () => {
        const data = thinkPayload('<think>captured</think>visible');
        data.messages[2].reasoning_content = 'existing';

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(true);
        expect(data.messages[2].reasoning_content).toBe('captured\nexisting');
        expect(data.messages[2].content).toBe('visible');
    });

    test.each(['quiet', 'impersonate', 'continue'])('transform is allowed for type "%s"', (type) => {
        const data = thinkPayload('<think>reasoning</think>visible');

        const applied = applyReasoningPrefill(data, type, 'seed');

        expect(applied).toBe(true);
        expect(data.messages[2].reasoning_content).toBe('reasoning');
        expect(data.messages[2].partial).toBe(true);
        expect(data.include_reasoning).toBe(true);
    });

    test('does not transform a trailing assistant message with non-string content', () => {
        const data = basePayload();
        data.messages.push({ role: 'assistant', content: [{ type: 'text', text: '<think>x</think>y' }] });
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
        expect(data.include_reasoning).toBeUndefined();
    });

    test('does not transform a trailing assistant message with a mid-string <think> block', () => {
        const data = thinkPayload('text before <think>reason</think>');
        const before = structuredClone(data);

        const applied = applyReasoningPrefill(data, 'normal', 'seed');

        expect(applied).toBe(false);
        expect(data).toEqual(before);
        expect(data.include_reasoning).toBeUndefined();
    });
});

describe('applyProgrammaticReasoningPrefill', () => {
    test('injects without any type argument', () => {
        const body = basePayload();
        body.type = 'quiet';
        body.reasoning_prefill = 'server seed';

        const applied = applyProgrammaticReasoningPrefill(body);

        expect(applied).toBe(true);
        expect(body.messages[2]).toEqual({
            role: 'assistant',
            content: '',
            reasoning_content: 'server seed',
            partial: true,
        });
        expect(body.include_reasoning).toBe(true);
    });

    test('transforms a trailing assistant message', () => {
        const body = basePayload();
        body.messages.push({ role: 'assistant', content: '<think>reasoning</think>visible' });
        body.reasoning_prefill = 'server seed';

        const applied = applyProgrammaticReasoningPrefill(body);

        expect(applied).toBe(true);
        expect(body.messages[2].reasoning_content).toBe('reasoning');
        expect(body.messages[2].content).toBe('visible');
        expect(body.messages[2].partial).toBe(true);
    });

    test('always strips the reasoning_prefill key, even when skipped', () => {
        const guardedBodies = [
            { messages: [{ role: 'user', content: 'hi' }], reasoning_prefill: '   ' },
            { messages: [{ role: 'user', content: 'hi' }], json_schema: { type: 'object' }, reasoning_prefill: 'seed' },
            { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function' }], reasoning_prefill: 'seed' },
            { messages: 'not-an-array', reasoning_prefill: 'seed' },
        ];

        for (const body of guardedBodies) {
            const applied = applyProgrammaticReasoningPrefill(body);

            expect(applied).toBe(false);
            expect('reasoning_prefill' in body).toBe(false);
            expect(body.include_reasoning).toBeUndefined();
        }
    });

    test('sets include_reasoning only when applied', () => {
        const skipped = { messages: [{ role: 'tool', content: 'x' }], reasoning_prefill: 'seed' };
        const appliedBody = { messages: [{ role: 'user', content: 'hi' }], reasoning_prefill: 'seed' };

        expect(applyProgrammaticReasoningPrefill(skipped)).toBe(false);
        expect(skipped.include_reasoning).toBeUndefined();

        expect(applyProgrammaticReasoningPrefill(appliedBody)).toBe(true);
        expect(appliedBody.include_reasoning).toBe(true);
    });

    test('never throws on garbage input', () => {
        expect(applyProgrammaticReasoningPrefill(null)).toBe(false);
        expect(applyProgrammaticReasoningPrefill(undefined)).toBe(false);
        expect(applyProgrammaticReasoningPrefill('garbage')).toBe(false);
        expect(applyProgrammaticReasoningPrefill({ reasoning_prefill: null, messages: null })).toBe(false);
        expect(applyProgrammaticReasoningPrefill({ reasoning_prefill: { nested: true }, messages: null })).toBe(false);
    });

    test('coerces a non-string reasoning_prefill', () => {
        const body = { messages: [{ role: 'user', content: 'hi' }], reasoning_prefill: 42 };

        const applied = applyProgrammaticReasoningPrefill(body);

        expect(applied).toBe(true);
        expect(body.messages[1].reasoning_content).toBe('42');
        expect('reasoning_prefill' in body).toBe(false);
    });
});
