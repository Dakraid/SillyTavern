import { describe, expect, test } from '@jest/globals';

import {
    SCHEMA_VERSION,
    createEmptyTask,
    generateTaskId,
    hashInputs,
    isValidTask,
    normalizeTask,
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
            mode: 'individual',
            concurrency: 1,
            connectionProfile: null,
            preset: null,
            totalContextTokens: null,
            outputTokens: null,
            destination: 'card',
            xmlMinify: false,
            postProcessingEnabled: false,
            postProcessingMode: 'replace',
            secondPassEnabled: false,
        });
        expect(task.prompts.main).toEqual({
            text: '',
            assistant: { request: '', proposal: '', diff: '', applied: false },
        });
        expect(task.passes.transform1).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(task.passes.transform2).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(task.passes.summary).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(isValidTask(task)).toBe(true);
    });

    test('repairs malformed partial records and normalization is idempotent', () => {
        const normalized = normalizeTask({
            id: 'not-a-uuid',
            name: 42,
            revision: -4,
            currentPage: 0,
            sources: 'wrong',
            settings: { mode: 'unknown', concurrency: 'many', connectionProfile: { apiKey: 'secret' } },
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
        expect(normalized.settings).toMatchObject({ mode: 'individual', concurrency: 1, connectionProfile: null });
        expect(normalized.prompts.main.text).toBe('');
        expect(normalized.passes.transform1).toEqual({ status: 'pending', inputRevision: null, items: {} });
        expect(normalized.completion).toEqual({});
        expect(normalized.archivedAt).toBeNull();
        expect(normalized).not.toHaveProperty('garbage');
        expect(normalizeTask(normalized)).toEqual(normalized);
    });

    test('rejects partial and malformed records with the shape guard', () => {
        expect(isValidTask(null)).toBe(false);
        expect(isValidTask({})).toBe(false);
        expect(isValidTask({ ...createEmptyTask({ name: 'Valid' }), revision: 0 })).toBe(false);
        expect(isValidTask({ ...createEmptyTask({ name: 'Valid' }), completion: null })).toBe(false);
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
