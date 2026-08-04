import { describe, expect, test } from '@jest/globals';

import {
    applyPostProcess,
    assembleReviewPayload,
    buildLorebookData,
    buildMergedCardDescription,
    getCardDescriptionBlocks,
    getFullDescriptionSources,
    selectFullDescriptionPass,
} from '../../src/util/bulk-combine/artifact-assembler.js';

const firstXml = '<character><name>Alice</name><comment>A memo</comment><keys>Alice, ally</keys><description>Full Alice</description><summary>Short Alice</summary></character>';
const secondXml = '<character><name>Bob</name><description>Full Bob</description></character>';

function makeTask({ destination = 'card', secondPassEnabled = false, xmlMinify = false } = {}) {
    return {
        sources: [
            { key: 'a', name: 'Alice', fields: { name: 'Alice' } },
            { key: 'b', name: 'Bob', fields: { name: 'Bob' } },
        ],
        settings: {
            destination,
            secondPassEnabled,
            postProcessingEnabled: true,
            postProcessingMode: 'replace',
            xmlMinify,
        },
        passes: {
            transform1: {
                items: {
                    a: { status: 'succeeded', output: firstXml },
                    b: { status: 'succeeded', output: secondXml },
                },
            },
            transform2: { items: {} },
            summary: { items: {} },
        },
        post: {},
    };
}

describe('bulk combine artifact assembler', () => {
    test('selects transform1 unless enabled transform2 has a succeeded item', () => {
        const task = makeTask({ secondPassEnabled: true });
        expect(selectFullDescriptionPass(task)).toBe('transform1');

        task.passes.transform2.items.a = { status: 'failed', output: 'ignored' };
        expect(selectFullDescriptionPass(task)).toBe('transform1');

        task.passes.transform2.items.a = { status: 'succeeded', output: '<character>A2</character>' };
        expect(selectFullDescriptionPass(task)).toBe('transform2');
    });

    test('returns succeeded full-description sources in source order', () => {
        const task = makeTask();
        task.passes.transform1.items.b.status = 'failed';

        expect(getFullDescriptionSources(task)).toEqual([
            { key: 'a', name: 'Alice', output: firstXml },
        ]);
    });

    test('uses full outputs for card mode', () => {
        expect(getCardDescriptionBlocks(makeTask())).toEqual([
            { key: 'a', name: 'Alice', xml: firstXml },
            { key: 'b', name: 'Bob', xml: secondXml },
        ]);
    });

    test('uses summary descriptions in lorebook mode and falls back to full output', () => {
        const task = makeTask({ destination: 'lorebook' });
        task.passes.summary.items.a = { status: 'succeeded', output: 'Short & direct' };

        expect(getCardDescriptionBlocks(task)).toEqual([
            {
                key: 'a',
                name: 'Alice',
                xml: '<character>\n  <name>Alice</name>\n  <description>Short &amp; direct</description>\n</character>',
            },
            { key: 'b', name: 'Bob', xml: secondXml },
        ]);
    });

    test('builds lorebook entries from full character blocks with the legacy shape', () => {
        const task = makeTask({ destination: 'lorebook' });

        expect(buildLorebookData(task)).toEqual({
            entries: {
                0: {
                    uid: 0,
                    key: ['Alice', 'ally'],
                    keysecondary: [],
                    comment: 'A memo',
                    content: '<character><name>Alice</name><description>Full Alice</description></character>',
                    constant: false,
                    selective: false,
                    order: 100,
                    position: 0,
                    disable: false,
                    addMemo: true,
                    excludeRecursion: false,
                    delayUntilRecursion: false,
                    probability: 100,
                    useProbability: true,
                    depth: 4,
                    group: '',
                    groupOverride: false,
                    groupWeight: 100,
                    preventRecursion: false,
                    scanDepth: null,
                    caseSensitive: null,
                    matchWholeWords: null,
                    useGroupScoring: null,
                    automation_id: '',
                    role: null,
                    vectorized: false,
                    displayIndex: 0,
                    sticky: 0,
                    cooldown: 0,
                    delay: 0,
                },
                1: {
                    uid: 1,
                    key: ['Bob'],
                    keysecondary: [],
                    comment: 'Bob',
                    content: secondXml,
                    constant: false,
                    selective: false,
                    order: 99,
                    position: 0,
                    disable: false,
                    addMemo: true,
                    excludeRecursion: false,
                    delayUntilRecursion: false,
                    probability: 100,
                    useProbability: true,
                    depth: 4,
                    group: '',
                    groupOverride: false,
                    groupWeight: 100,
                    preventRecursion: false,
                    scanDepth: null,
                    caseSensitive: null,
                    matchWholeWords: null,
                    useGroupScoring: null,
                    automation_id: '',
                    role: null,
                    vectorized: false,
                    displayIndex: 1,
                    sticky: 0,
                    cooldown: 0,
                    delay: 0,
                },
            },
        });
        expect(buildLorebookData(makeTask())).toEqual({ entries: {} });
    });

    test('joins card blocks and applies optional XML minification after assembly', () => {
        const task = makeTask();
        expect(buildMergedCardDescription(task)).toBe(`${firstXml}\n\n${secondXml}`);

        task.settings.xmlMinify = true;
        expect(buildMergedCardDescription(task)).toBe([
            '<character>',
            '<name>Alice</name>',
            '<comment>A memo</comment>',
            '<keys>Alice, ally</keys>',
            '<description>Full Alice</description>',
            '<summary>Short Alice</summary>',
            '</character>',
            '<character>',
            '<name>Bob</name>',
            '<description>Full Bob</description>',
            '</character>',
        ].join('\n'));
    });

    test('applies replace, prepend, append, and invalid-mode-as-replace semantics', () => {
        const base = '<character><name>A</name></character>';
        const replacement = '<character><name>B</name></character>';

        expect(applyPostProcess(base, replacement, 'replace')).toEqual({ description: replacement });
        expect(applyPostProcess(base, replacement, 'prepend')).toEqual({ description: `${replacement}\n\n${base}` });
        expect(applyPostProcess(base, replacement, 'append')).toEqual({ description: `${base}\n\n${replacement}` });
        expect(applyPostProcess(base, replacement, 'unknown')).toEqual({ description: replacement });
    });

    test('rejects replace output with a different XML corpus count', () => {
        const base = '<character>A</character>\n\n<character>B</character>';
        expect(() => applyPostProcess(base, '<character>A</character>', 'replace')).toThrow(
            'Post-processing returned 1 root XML corpus block(s), expected 2.',
        );
    });

    test('assembles the review payload by derivation and exposes persisted post output', () => {
        const task = makeTask({ destination: 'lorebook' });
        task.passes.summary.items.a = { status: 'succeeded', output: 'Summary' };
        task.post = { output: '<character><description>Processed</description></character>' };

        const payload = assembleReviewPayload(task);

        expect(payload).toEqual({
            fullSourcePass: 'transform1',
            cardBlocks: getCardDescriptionBlocks(task),
            lorebookData: buildLorebookData(task),
            mergedDescription: buildMergedCardDescription(task),
            post: {
                enabled: true,
                mode: 'replace',
                input: buildMergedCardDescription(task),
                output: task.post.output,
            },
            destination: 'lorebook',
        });
    });

    test('combined mode assembles one merged block and extracts lorebook entries from it', () => {
        const task = makeTask({ destination: 'lorebook' });
        task.name = 'Merged card';
        task.settings.mode = 'combined';
        task.passes.transform1.items = {
            __combined__: { status: 'succeeded', output: `${firstXml}\n${secondXml}` },
        };

        expect(getFullDescriptionSources(task)).toEqual([
            { key: '__combined__', name: 'Merged card', output: `${firstXml}\n${secondXml}` },
        ]);
        expect(buildMergedCardDescription(task)).toBe(`${firstXml}\n${secondXml}`);
        // Lorebook entries come from the character blocks inside the merged output.
        const entries = Object.values(buildLorebookData(task).entries);
        expect(entries).toHaveLength(2);
        expect(entries[0].comment).toBe('A memo');
        expect(entries[1].key).toEqual(['Bob']);

        // Lorebook destination prefers the merged summary output when it ran.
        task.passes.summary.items.__combined__ = { status: 'succeeded', output: 'Merged summary' };
        expect(getCardDescriptionBlocks(task)).toEqual([{
            key: '__combined__',
            name: 'Merged card',
            xml: '<character>\n  <name>Merged card</name>\n  <description>Merged summary</description>\n</character>',
        }]);
    });
});
