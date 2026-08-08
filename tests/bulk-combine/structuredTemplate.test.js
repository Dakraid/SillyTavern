'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

import { describe, expect, test } from '@jest/globals';
import {
    DEFAULT_TEMPLATE,
    createNode,
    duplicateNode,
    findSummaryNode,
    insertChild,
    moveNode,
    normalizeTemplate,
    removeNode,
    updateNode,
} from '../../public/scripts/bulk-combine/structured/templateModel.js';
import {
    parseTemplate,
    serializeTemplate,
} from '../../public/scripts/bulk-combine/structured/templateText.js';
import { renderStructureInstructions } from '../../public/scripts/bulk-combine/structured/renderPrompt.js';

describe('structured template model', () => {
    test('default template has the approved character contract', () => {
        const root = DEFAULT_TEMPLATE[0];
        expect(root.name).toBe('character');
        expect(root.hint).toContain('all freeform text');
        expect(root.children.map((node) => node.name)).toEqual([
            'summary', 'appearance', 'physiology', 'style', 'personality', 'sexuality', 'history',
        ]);
        expect(findSummaryNode(DEFAULT_TEMPLATE)).toMatchObject({
            name: 'summary',
            maxLength: 800,
        });
    });

    test('canonical text round-trips the default template', () => {
        const text = serializeTemplate(DEFAULT_TEMPLATE);
        const parsed = parseTemplate(text);
        expect(parsed.errors).toEqual([]);
        expect(parsed.tree).toEqual(normalizeTemplate(DEFAULT_TEMPLATE));
        expect(serializeTemplate(parsed.tree)).toBe(text);
        expect(text).toContain('max="800"');
    });

    test('parse reports hard template errors', () => {
        expect(parseTemplate('').errors[0].message).toMatch(/root/i);
        expect(parseTemplate('<a></a><b></b>').errors.map((error) => error.message).join(' ')).toMatch(/exactly one/i);
        expect(parseTemplate('<a><x></x><x></x></a>').errors.map((error) => error.message).join(' ')).toMatch(/duplicate/i);
        expect(parseTemplate('<a max="many"></a>').errors.map((error) => error.message).join(' ')).toMatch(/numeric/i);
        expect(parseTemplate('<a><b></a>').errors.length).toBeGreaterThan(0);
    });

    test('normalization repairs shape, roots, ids, and junk keys', () => {
        const normalized = normalizeTemplate([
            { id: 'same', name: 12, attributes: null, children: 'bad', junk: true },
            { id: 'same', hint: 9, maxLength: '4', children: [] },
        ]);
        expect(normalized).toHaveLength(1);
        expect(normalized[0].name).toBe('root');
        expect(normalized[0].children).toHaveLength(2);
        expect(normalized[0].children[0]).toEqual({
            id: 'structured-0-0',
            name: '12',
            hint: '',
            attributes: [],
            maxLength: null,
            children: [],
        });
        expect(normalized[0].children[1].maxLength).toBe(4);
    });

    test('tree operations are pure and support reparenting and fresh duplicates', () => {
        const tree = normalizeTemplate([{ name: 'root', children: [
            { name: 'left', children: [{ name: 'leaf' }] },
            { name: 'right' },
        ] }]);
        const original = structuredClone(tree);
        const rootId = tree[0].id;
        const leftId = tree[0].children[0].id;
        const rightId = tree[0].children[1].id;
        const leafId = tree[0].children[0].children[0].id;

        const inserted = insertChild(tree, rightId, createNode({ name: 'new' }), 0);
        expect(inserted[0].children[1].children[0].name).toBe('new');
        const moved = moveNode(tree, leafId, rightId, 0);
        expect(moved[0].children[0].children).toEqual([]);
        expect(moved[0].children[1].children[0].id).toBe(leafId);
        const duplicated = duplicateNode(tree, leftId);
        expect(duplicated[0].children.map((node) => node.name)).toEqual(['left', 'left', 'right']);
        expect(duplicated[0].children[1].id).not.toBe(leftId);
        expect(duplicated[0].children[1].children[0].id).not.toBe(leafId);
        expect(updateNode(tree, rightId, { hint: 'changed' })[0].children[1].hint).toBe('changed');
        expect(removeNode(tree, rightId)[0].children.map((node) => node.name)).toEqual(['left']);
        expect(removeNode(tree, rootId)).toEqual(tree);
        expect(tree).toEqual(original);
    });

    test('findSummaryNode uses descendant DFS and returns null when absent', () => {
        expect(findSummaryNode([{ name: 'x', children: [{ name: 'summary', children: [] }] }])?.name).toBe('summary');
        expect(findSummaryNode([{ name: 'x', children: [] }])).toBeNull();
    });
});

describe('structure prompt rendering', () => {
    test('renders XML, JSON, summary, and TOON fallback contracts', () => {
        const xml = renderStructureInstructions({ format: 'xml', template: DEFAULT_TEMPLATE }, 'full');
        expect(xml).toContain('Respond with ONLY a <character> document');
        expect(xml).toContain('<characters>…</characters>');

        const json = renderStructureInstructions({ format: 'json', template: DEFAULT_TEMPLATE }, 'summary');
        expect(json).toContain('"@species"');
        expect(json).not.toContain('appearance');

        const toon = renderStructureInstructions({ format: 'toon', template: DEFAULT_TEMPLATE }, 'full');
        expect(toon).toContain('encoded as TOON');
        expect(renderStructureInstructions({ format: 'none', template: DEFAULT_TEMPLATE }, 'full')).toBe('');
        expect(renderStructureInstructions({ format: 'xml', template: [{ name: 'x' }] }, 'summary')).toBe('');
    });

    test('uses an injected TOON encoder', () => {
        const result = renderStructureInstructions(
            { format: 'toon', template: DEFAULT_TEMPLATE },
            'summary',
            { toonEncode: (value) => `TOON:${Object.keys(value)[0]}` },
        );
        expect(result).toContain('TOON:summary');
    });
});
