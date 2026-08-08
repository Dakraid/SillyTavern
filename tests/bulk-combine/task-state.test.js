import { describe, expect, test } from '@jest/globals';

import { DEFAULT_TEMPLATE } from '../../public/scripts/bulk-combine/structured/templateModel.js';
import {
    SCHEMA_VERSION,
    createEmptyTask,
    generateTaskId,
    hashInputs,
    isValidTask,
    normalizeTask,
    transform2CombinedDocument,
} from '../../src/util/bulk-combine/task-state.js';

describe('Bulk Combine task state', () => {
    test('creates the complete canonical empty task shape', () => {
        const task = createEmptyTask({
            id: '00000000-0000-4000-8000-000000000001',
            name: 'New combine',
            createdAt: '2026-08-02T12:00:00.000Z',
        });

        expect(task).toMatchObject({
            id: '00000000-0000-4000-8000-000000000001',
            schemaVersion: SCHEMA_VERSION,
            name: 'New combine',
            revision: 1,
            status: 'draft',
            currentPage: 1,
            furthestPage: 1,
            createdAt: '2026-08-02T12:00:00.000Z',
            updatedAt: '2026-08-02T12:00:00.000Z',
            lastActivityAt: '2026-08-02T12:00:00.000Z',
            archivedAt: null,
            sources: [],
            activePass: null,
            completion: {},
            lorebook: {},
            post: {},
            review: {},
            avatar: {},
            artifacts: {},
        });
        expect(task.expiresAt).toBe('2026-08-09T12:00:00.000Z');
        expect(task.settings).toMatchObject({
            secondPassMode: 'individual',
            concurrency: 1,
            connectionProfile: null,
            preset: null,
            totalContextTokens: null,
            outputTokens: null,
            destination: 'card',
            xmlMinify: false,
            postProcessingEnabled: false,
            postProcessingMode: 'append',
            secondPassEnabled: false,
        });
        expect(task.settings).not.toHaveProperty('mode');
        expect(task.structure).toEqual({ format: 'xml', template: DEFAULT_TEMPLATE });
        expect(task.sourceNotes).toEqual({});
        expect(task.prompts.main).toEqual({
            text: '',
            assistant: { request: '', proposal: '', diff: '', applied: false, error: '' },
        });
        expect(task.passes.transform1).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(task.passes.transform2).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(task.passes.summary).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(isValidTask(task)).toBe(true);
    });

    test('deep-clones the default structure for every new task', () => {
        const first = createEmptyTask({ name: 'First' });
        const second = createEmptyTask({ name: 'Second' });

        expect(first.structure.template).not.toBe(second.structure.template);
        expect(first.structure.template).not.toBe(DEFAULT_TEMPLATE);
        first.structure.template[0].name = 'changed';
        first.structure.template[0].attributes[0].name = 'changed-attribute';

        expect(second.structure.template).toEqual(DEFAULT_TEMPLATE);
        expect(DEFAULT_TEMPLATE[0].name).toBe('character');
        expect(DEFAULT_TEMPLATE[0].attributes[0].name).toBe('name');
    });

    test('repairs malformed partial records and normalization is idempotent', () => {
        const normalized = normalizeTask({
            id: 'not-a-uuid',
            name: 42,
            revision: -4,
            currentPage: 0,
            sources: 'wrong',
            settings: { secondPassMode: 'unknown', concurrency: 'many', connectionProfile: { apiKey: 'secret' } },
            prompts: { main: { text: 99, assistant: { request: 5, applied: 'yes' } } },
            passes: { transform1: { status: 5, inputRevision: -1, items: [] } },
            archivedAt: 'not-a-date',
            garbage: true,
        });

        expect(isValidTask(normalized)).toBe(true);
        expect(normalized.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(normalized.name).toBe('Untitled task');
        expect(normalized.revision).toBe(1);
        expect(normalized.currentPage).toBe(1);
        expect(normalized.sources).toEqual([]);
        expect(normalized.settings).toMatchObject({ secondPassMode: 'individual', concurrency: 1, connectionProfile: null });
        expect(normalized.prompts.main.text).toBe('');
        expect(normalized.passes.transform1).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(normalized.completion).toEqual({});
        expect(normalized.archivedAt).toBeNull();
        expect(normalized).not.toHaveProperty('garbage');
        expect(normalizeTask(normalized)).toEqual(normalized);
    });

    test('normalizes legacy tasks without structure as freeform without changing other fields', () => {
        const legacy = {
            id: '00000000-0000-4000-8000-000000000002',
            name: 'Legacy',
            revision: 3,
            createdAt: '2026-08-01T00:00:00.000Z',
            updatedAt: '2026-08-02T00:00:00.000Z',
            lastActivityAt: '2026-08-03T00:00:00.000Z',
            sources: [{ key: 'alpha', name: 'Alpha' }],
            settings: { xmlMinify: true },
        };

        const normalized = normalizeTask(legacy);
        const explicitlyFreeform = normalizeTask({
            ...legacy,
            structure: { format: 'none', template: DEFAULT_TEMPLATE },
            sourceNotes: {},
        });

        expect(normalized).toEqual(explicitlyFreeform);
        expect(normalized.structure).toEqual({ format: 'none', template: DEFAULT_TEMPLATE });
    });

    test('normalizes present junk structure and source notes', () => {
        expect(normalizeTask({ structure: null, sourceNotes: [] })).toMatchObject({
            structure: { format: 'xml', template: DEFAULT_TEMPLATE },
            sourceNotes: {},
        });
        expect(normalizeTask({
            structure: { format: 'junk', template: 'junk' },
            sourceNotes: { alpha: 42, beta: null, gamma: false },
        })).toMatchObject({
            structure: { format: 'xml', template: DEFAULT_TEMPLATE },
            sourceNotes: { alpha: '42', beta: 'null', gamma: 'false' },
        });
    });

    test('rejects partial and malformed records with the shape guard', () => {
        expect(isValidTask(null)).toBe(false);
        expect(isValidTask({})).toBe(false);
        expect(isValidTask({ ...createEmptyTask({ name: 'Valid' }), revision: 0 })).toBe(false);
        expect(isValidTask({ ...createEmptyTask({ name: 'Valid' }), completion: null })).toBe(false);

        const valid = createEmptyTask({ name: 'Valid' });
        valid.sourceNotes = { alpha: 'Remember this' };
        expect(isValidTask(valid)).toBe(true);
        expect(isValidTask({ ...valid, structure: null })).toBe(false);
        expect(isValidTask({ ...valid, structure: { format: 'csv', template: DEFAULT_TEMPLATE } })).toBe(false);
        expect(isValidTask({ ...valid, structure: { format: 'xml', template: {} } })).toBe(false);
        expect(isValidTask({ ...valid, sourceNotes: [] })).toBe(false);
        expect(isValidTask({ ...valid, sourceNotes: { alpha: 7 } })).toBe(false);
    });

    test('migrates legacy combined and replace settings', () => {
        const normalized = normalizeTask({
            settings: {
                mode: 'combined',
                secondPassEnabled: false,
                postProcessingMode: 'replace',
            },
        });

        expect(normalized.settings).toMatchObject({
            secondPassMode: 'combined',
            secondPassEnabled: false,
            postProcessingMode: 'append',
        });
        expect(normalized.settings).not.toHaveProperty('mode');
    });

    test('drops the removed xmlEnabled setting from legacy tasks', () => {
        const normalized = normalizeTask({ settings: { xmlEnabled: true, xmlMinify: true } });

        expect(normalized.settings).not.toHaveProperty('xmlEnabled');
        expect(normalized.settings.xmlMinify).toBe(true);
    });

    test('joins transform1 outputs in source order and falls back to a legacy merged item', () => {
        const task = createEmptyTask({ name: 'Combined document' });
        task.sources = [{ key: 'b' }, { key: 'a' }];
        task.passes.transform1.items = {
            a: { status: 'succeeded', output: 'Alpha' },
            b: { status: 'succeeded', output: 'Beta' },
            __combined__: { status: 'succeeded', output: 'Legacy' },
        };
        expect(transform2CombinedDocument(task)).toBe('Beta\n\nAlpha');

        task.passes.transform1.items.a.status = 'failed';
        task.passes.transform1.items.b.status = 'failed';
        expect(transform2CombinedDocument(task)).toBe('Legacy');
    });

    test('preserves a completion settings snapshot during normalization', () => {
        const completion = { chat_completion_source: 'openai', model: 'test-model', temperature: 0.5 };

        expect(normalizeTask({ completion }).completion).toEqual(completion);
    });

    test('hashes canonical object keys deterministically', () => {
        expect(hashInputs({ b: 2, a: { d: 4, c: 3 } }))
            .toBe(hashInputs({ a: { c: 3, d: 4 }, b: 2 }));
        expect(hashInputs({ a: 1 })).not.toBe(hashInputs({ a: 2 }));
    });

    test('generates unique UUID task ids', () => {
        const ids = new Set(Array.from({ length: 100 }, generateTaskId));

        expect(ids.size).toBe(100);
        for (const id of ids) {
            expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        }
    });
});
