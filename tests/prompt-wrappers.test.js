import {
    applyPromptBulkOperation,
    calculatePromptOrderRenumber,
    cleanupPersistedPromptWrapperSlot,
    createPromptBulkUpdates,
    getChatPromptWrapperSettings,
    getPromptWrapperDisplayParts,
    getPromptWrapperRole,
    normalizePromptWrapperTag,
    resolvePromptWrapperState,
    stripPromptWrapperTags,
    wrapPromptWrapperContent,
    wrapPromptWrapperText,
} from '../public/scripts/prompt-wrappers.js';

describe('prompt wrappers', () => {
    test('escapes unsafe angle brackets but preserves spaces and symbols', () => {
        expect(normalizePromptWrapperTag('Dr. Bob!')).toBe('Dr. Bob!');
        expect(normalizePromptWrapperTag('A<B>C')).toBe('A&lt;B&gt;C');
        expect(normalizePromptWrapperTag('   ')).toBe('Unknown');
    });

    test('ephemerally wraps content once for prompt payloads', () => {
        const state = resolvePromptWrapperState({ enabled: true, tag: 'Alice' });
        expect(wrapPromptWrapperContent('<Alice>Hello</Alice></Alice>', state)).toBe('<Alice>Hello</Alice>');
        expect(wrapPromptWrapperContent('Hello', { enabled: false, tag: 'Alice' })).toBe('Hello');
    });

    test('builds display-only tag parts without wrapping content', () => {
        expect(getPromptWrapperDisplayParts({ enabled: false, tag: 'Alice' })).toBeNull();
        expect(getPromptWrapperDisplayParts({ enabled: true, tag: 'A<B>' })).toEqual({
            enabled: true,
            tag: 'A&lt;B&gt;',
            opening: '<A&lt;B&gt;>',
            closing: '</A&lt;B&gt;>',
        });
    });

    test('resolves only user and assistant message roles', () => {
        expect(getPromptWrapperRole({ is_user: true, extra: {} })).toBe('user');
        expect(getPromptWrapperRole({ is_user: false, is_system: false, extra: {} })).toBe('assistant');
        expect(getPromptWrapperRole({ is_user: false, is_system: true, extra: {} })).toBeNull();
        expect(getPromptWrapperRole({ is_user: false, extra: { isSmallSys: true } })).toBeNull();
        expect(getPromptWrapperRole({ is_user: false, extra: { type: 'narrator' } })).toBeNull();
    });

    test('cleanup only removes legacy metadata-managed wrappers', () => {
        const cleaned = cleanupPersistedPromptWrapperSlot('<Alice>changed</Alice>', {
            prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: 'exact <content>', version: 1 },
            keep: true,
        });
        expect(cleaned).toEqual({ text: 'exact <content>', extra: { keep: true }, changed: true });

        const untouched = cleanupPersistedPromptWrapperSlot('<Alice>literal</Alice>', { keep: true });
        expect(untouched).toEqual({ text: '<Alice>literal</Alice>', extra: { keep: true }, changed: false });
    });

    test('legacy same outer tags can still be normalized by pure helpers', () => {
        const wrapped = wrapPromptWrapperText('<Alice><Alice>Hello</Alice></Alice></Alice>', 'Alice');
        expect(wrapped.mes).toBe('<Alice>Hello</Alice>');
        expect(wrapped.base_mes).toBe('Hello');
        expect(stripPromptWrapperTags('<Kris><Kris>Hi</Kris></Kris></Kris>', 'Kris')).toBe('Hi');
    });
});

describe('chat prompt wrapper settings', () => {
    test('seeds missing chat metadata from legacy globals without chara overrides', () => {
        const chatMetadata = {};
        const settings = getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: false, chara: { avatar: 'Alice' } } });

        expect(settings).toEqual({ assistant: true, user: false });
        expect(chatMetadata.prompt_wrappers).toBe(settings);
        expect(settings.chara).toBeUndefined();
    });

    test('preserves existing booleans and fills missing values from legacy globals', () => {
        const chatMetadata = { prompt_wrappers: { assistant: false, chara: { leaked: true } } };
        const settings = getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: true } });

        expect(settings).toEqual({ assistant: false, user: true });
    });

    test('normalizes malformed chat metadata', () => {
        const chatMetadata = { prompt_wrappers: 'bad' };
        expect(getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: false, user: true } })).toEqual({ assistant: false, user: true });
        expect(chatMetadata.prompt_wrappers).toEqual({ assistant: false, user: true });
        expect(getChatPromptWrapperSettings(null, { wrappers: { assistant: true, user: true } })).toEqual({ assistant: true, user: true });
    });
});

describe('prompt manager bulk operations', () => {
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

    test('builds identifier-keyed updates so PromptManager can update stored prompts from stale visible targets', () => {
        const visibleCopies = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];
        const storedPrompts = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];

        const updates = createPromptBulkUpdates(visibleCopies, { operation: 'position-inchat', value: 0, mode: 'first-inc' });
        updates.forEach(update => Object.assign(storedPrompts.find(prompt => prompt.identifier === update.identifier), update));

        expect(visibleCopies.map(prompt => prompt.injection_position)).toEqual([0, 0]);
        expect(storedPrompts.map(prompt => prompt.injection_position)).toEqual([1, 1]);
    });

    test('mutates visible prompt targets for position, depth, and order operations', () => {
        const prompts = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];

        applyPromptBulkOperation(prompts, { operation: 'position-inchat', value: 0, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_position)).toEqual([1, 1]);

        applyPromptBulkOperation(prompts, { operation: 'depth', value: 0, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_depth)).toEqual([0, 0]);

        applyPromptBulkOperation(prompts, { operation: 'order', value: 7, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_order)).toEqual([7, 7]);

        applyPromptBulkOperation(prompts, { operation: 'renumber', value: 3, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_order)).toEqual([3, 4]);
    });
});
