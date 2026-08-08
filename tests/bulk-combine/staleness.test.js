import { afterAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BulkCombineTaskRepository } from '../../src/util/bulk-combine/task-repository.js';
import { createTaskRunner } from '../../src/util/bulk-combine/task-runner.js';
import {
    COMBINED_KEY,
    computePassInputHash,
    createEmptyTask,
    deriveStaleness,
    relevantSettings,
} from '../../src/util/bulk-combine/task-state.js';

jest.unstable_mockModule('../../src/users.js', () => ({
    getAllUserHandles: jest.fn(async () => []),
    getUserDirectories: jest.fn(() => ({ root: '' })),
}));

jest.unstable_mockModule('../../src/endpoints/backends/chat-completions.js', () => ({
    executeChatCompletion: jest.fn(),
}));

jest.unstable_mockModule('../../src/endpoints/tokenizers.js', () => ({
    countOpenAIMessageTokens: jest.fn(),
}));

const tempRoots = [];

function source(key, name) {
    return {
        key,
        name,
        avatar: null,
        fields: {
            name,
            description: `${name} description`,
            personality: `${name} personality`,
            scenario: '',
            first_mes: '',
            mes_example: '',
        },
        snapshotHash: `${key}-hash`,
    };
}

function setCurrentRevision(task, passKey) {
    task.passes[passKey].inputRevision = computePassInputHash(task, passKey);
}

function successfulTask({ secondPassEnabled = true } = {}) {
    const task = createEmptyTask({
        id: '00000000-0000-4000-8000-000000000008',
        name: 'Staleness task',
    });
    task.sources = [source('a', 'Alpha'), source('b', 'Beta')];
    task.settings.secondPassEnabled = secondPassEnabled;
    task.settings.totalContextTokens = 4096;
    task.settings.outputTokens = 512;
    task.settings.connectionProfile = 'profile-a';
    task.settings.preset = 'preset-a';
    task.completion = { model: 'model-a', temperature: 0.5 };
    task.prompts.main.text = 'Transform';
    task.prompts.secondPass.text = 'Improve';
    task.prompts.summary.text = 'Summarize';
    task.passes.transform1.items = {
        a: { status: 'succeeded', output: 'T1 Alpha' },
        b: { status: 'succeeded', output: 'T1 Beta' },
    };
    task.passes.transform2.items = {
        a: { status: 'succeeded', output: 'T2 Alpha' },
        b: { status: 'succeeded', output: 'T2 Beta' },
    };
    task.passes.summary.items = {
        a: { status: 'succeeded', output: 'Summary Alpha' },
        b: { status: 'succeeded', output: 'Summary Beta' },
    };
    setCurrentRevision(task, 'transform1');
    setCurrentRevision(task, 'transform2');
    setCurrentRevision(task, 'summary');
    return task;
}

afterAll(async () => {
    await Promise.all(tempRoots.map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('Bulk Combine pass staleness', () => {
    test('reports a fresh successful transform1 as current', () => {
        const task = successfulTask({ secondPassEnabled: false });

        expect(deriveStaleness(task).transform1).toEqual({ stale: false, reason: 'current' });
    });

    test('propagates a main prompt edit through transform2 and summary', () => {
        const task = successfulTask();
        task.prompts.main.text = 'Changed transform';

        expect(deriveStaleness(task)).toEqual({
            transform1: { stale: true, reason: 'input_changed' },
            transform2: { stale: true, reason: 'upstream_stale' },
            summary: { stale: true, reason: 'upstream_stale' },
        });
    });

    test('propagates a source field edit through downstream passes', () => {
        const task = successfulTask();
        task.sources[0].fields.personality = 'Changed personality';

        expect(deriveStaleness(task)).toEqual({
            transform1: { stale: true, reason: 'input_changed' },
            transform2: { stale: true, reason: 'upstream_stale' },
            summary: { stale: true, reason: 'upstream_stale' },
        });
    });

    test('includes source notes only in the transform1 input hash', () => {
        const task = successfulTask();
        const before = Object.fromEntries(['transform1', 'transform2', 'summary']
            .map(passKey => [passKey, computePassInputHash(task, passKey)]));

        task.sourceNotes.a = 'Emphasize Alpha';

        expect(computePassInputHash(task, 'transform1')).not.toBe(before.transform1);
        expect(computePassInputHash(task, 'transform2')).toBe(before.transform2);
        expect(computePassInputHash(task, 'summary')).toBe(before.summary);
    });

    test('includes structure format and template in every pass input hash', () => {
        const mutations = [
            task => { task.structure.format = 'json'; },
            task => { task.structure.template[0].hint = 'Changed contract'; },
        ];

        for (const mutate of mutations) {
            const task = successfulTask();
            const before = Object.fromEntries(['transform1', 'transform2', 'summary']
                .map(passKey => [passKey, computePassInputHash(task, passKey)]));
            mutate(task);

            for (const passKey of ['transform1', 'transform2', 'summary']) {
                expect(computePassInputHash(task, passKey)).not.toBe(before[passKey]);
            }
        }
    });

    test('computes identical pass hashes regardless of record key order', () => {
        const first = successfulTask();
        first.sourceNotes = { a: 'Alpha note', b: 'Beta note' };
        const second = structuredClone(first);
        second.sourceNotes = { b: 'Beta note', a: 'Alpha note' };
        second.structure = { template: second.structure.template, format: second.structure.format };

        for (const passKey of ['transform1', 'transform2', 'summary']) {
            expect(computePassInputHash(second, passKey)).toBe(computePassInputHash(first, passKey));
        }
    });

    test('stales on token-window changes but not concurrency-only changes', () => {
        const tokenTask = successfulTask();
        tokenTask.settings.totalContextTokens++;
        expect(deriveStaleness(tokenTask).transform1).toEqual({ stale: true, reason: 'input_changed' });

        const concurrencyTask = successfulTask();
        concurrencyTask.settings.concurrency++;
        expect(deriveStaleness(concurrencyTask).transform1).toEqual({ stale: false, reason: 'current' });
    });

    test('stales a real normalized transform when model or temperature changes', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-staleness-completion-'));
        tempRoots.push(root);
        const repo = new BulkCombineTaskRepository(root);
        const created = await repo.createTask({ name: 'Completion staleness' });
        const task = await repo.updateTask(created.id, draft => {
            draft.sources = [source('a', 'Alpha')];
            draft.prompts.main.text = 'Transform';
            draft.completion = { model: 'model-a', temperature: 0.5, top_p: 0.9 };
        }, { expectedRevision: created.revision });
        const runner = createTaskRunner({
            executeCompletion: async () => ({ status: 200, data: {}, content: 'Transformed' }),
            countTokens: async () => 1,
        });
        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        const current = await repo.getTask(task.id);
        expect(deriveStaleness(current).transform1).toEqual({ stale: false, reason: 'current' });

        await repo.checkpoint(task.id, draft => {
            draft.completion.model = 'model-b';
            draft.completion.temperature = 0.8;
        });
        const changed = await repo.getTask(task.id);
        expect(changed.completion).toMatchObject({ model: 'model-b', temperature: 0.8, top_p: 0.9 });
        expect(deriveStaleness(changed).transform1).toEqual({ stale: true, reason: 'input_changed' });
    });

    test('reports transform2 as disabled regardless of retained outputs', () => {
        const task = successfulTask({ secondPassEnabled: false });

        expect(deriveStaleness(task).transform2).toEqual({ stale: false, reason: 'disabled' });
    });

    test('uses successful transform2 outputs for summary and isolates a summary prompt edit', () => {
        const task = successfulTask();
        task.prompts.summary.text = 'Changed summary prompt';

        expect(deriveStaleness(task)).toEqual({
            transform1: { stale: false, reason: 'current' },
            transform2: { stale: false, reason: 'current' },
            summary: { stale: true, reason: 'input_changed' },
        });
    });

    test('reports a pass without succeeded output as not run', () => {
        const task = successfulTask();
        task.passes.transform1.items = { a: { status: 'failed', output: 'retained failure output' } };

        expect(deriveStaleness(task).transform1).toEqual({ stale: false, reason: 'not_run' });
    });

    test('does not mutate task state', () => {
        const task = successfulTask();
        const before = structuredClone(task);

        deriveStaleness(task);

        expect(task).toEqual(before);
    });

    test('matches a real runner transform1 success checkpoint', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-staleness-'));
        tempRoots.push(root);
        const repo = new BulkCombineTaskRepository(root);
        const created = await repo.createTask({ name: 'Parity task' });
        const task = await repo.updateTask(created.id, draft => {
            draft.sources = [source('a', 'Alpha')];
            draft.settings.concurrency = 7;
            draft.settings.totalContextTokens = 4096;
            draft.settings.outputTokens = 512;
            draft.prompts.main.text = 'Transform';
        }, { expectedRevision: created.revision });
        const runner = createTaskRunner({
            executeCompletion: async () => ({ status: 200, data: {}, content: 'Transformed' }),
            countTokens: async () => 1,
        });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(stored.passes.transform1.inputRevision).toMatch(/^[0-9a-f]{64}$/);
        expect(deriveStaleness(stored).transform1).toEqual({ stale: false, reason: 'current' });
        expect(relevantSettings(stored.settings, stored.completion)).not.toHaveProperty('concurrency');
    });

    test('matches a real runner transform2 and summary success checkpoint', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-staleness-chain-'));
        tempRoots.push(root);
        const repo = new BulkCombineTaskRepository(root);
        const created = await repo.createTask({ name: 'Chain parity task' });
        const task = await repo.updateTask(created.id, draft => {
            draft.sources = [source('a', 'Alpha')];
            draft.settings.secondPassEnabled = true;
            draft.prompts.main.text = 'Transform';
            draft.prompts.secondPass.text = 'Improve';
            draft.prompts.summary.text = 'Summarize';
        }, { expectedRevision: created.revision });
        const outputs = {
            transform1: '<character><name>Alpha</name><description>T1</description></character>',
            transform2: '<character><name>Alpha</name><description>T2</description></character>',
            summary: 'Alpha summary',
        };
        let call = 0;
        const runner = createTaskRunner({
            executeCompletion: async () => {
                call++;
                const content = call === 1 ? outputs.transform1 : call === 2 ? outputs.transform2 : outputs.summary;
                return { status: 200, data: {}, content };
            },
            countTokens: async () => 1,
        });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        await runner.runPass({ taskId: task.id, passKey: 'transform2', repo, userDirectories: {} });
        await runner.runPass({ taskId: task.id, passKey: 'summary', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        // Runner and derivation must agree: every succeeded pass is 'current', not stale.
        expect(deriveStaleness(stored)).toEqual({
            transform1: { stale: false, reason: 'current' },
            transform2: { stale: false, reason: 'current' },
            summary: { stale: false, reason: 'current' },
        });

        // Re-running transform1 (regeneration) changes its outputs: transform1 stays
        // 'current' (its own inputs unchanged); transform2 becomes 'input_changed'
        // (its inputs = transform1 outputs changed); summary is 'upstream_stale'.
        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, scope: 'all' });
        const reran = await repo.getTask(task.id);
        expect(deriveStaleness(reran)).toEqual({
            transform1: { stale: false, reason: 'current' },
            transform2: { stale: true, reason: 'input_changed' },
            summary: { stale: true, reason: 'upstream_stale' },
        });
    });

    test('GET /tasks/:id includes derived staleness', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-staleness-route-'));
        tempRoots.push(root);
        const { createBulkCombineRouter } = await import('../../src/endpoints/bulk-combine.js');
        const router = createBulkCombineRouter({
            runner: { runPass: jest.fn(), resume: jest.fn(), cancel: jest.fn() },
            eventBus: { subscribe: jest.fn(), unsubscribe: jest.fn() },
        });
        const createHandler = router.stack.find(layer => layer.route?.path === '/tasks' && layer.route.methods.post).route.stack[0].handle;
        const getHandler = router.stack.find(layer => layer.route?.path === '/tasks/:id' && layer.route.methods.get).route.stack[0].handle;
        const response = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            send(body) {
                this.body = body;
                return this;
            },
        };
        const user = { directories: { root } };
        await createHandler({ body: { name: 'Route task' }, user }, response);
        const id = response.body.id;
        await getHandler({ params: { id }, user }, response);

        expect(response.body.derivedStaleness).toEqual({
            transform1: { stale: false, reason: 'not_run' },
            transform2: { stale: false, reason: 'disabled' },
            summary: { stale: false, reason: 'not_run' },
        });
    });

    test('matches the runner input hash for a combined transform2 document', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-staleness-combined-'));
        tempRoots.push(root);
        const repo = new BulkCombineTaskRepository(root);
        const created = await repo.createTask({ name: 'Combined parity' });
        const task = await repo.updateTask(created.id, draft => {
            draft.sources = [source('a', 'Alpha'), source('b', 'Beta')];
            draft.settings.secondPassEnabled = true;
            draft.settings.secondPassMode = 'combined';
            draft.prompts.main.text = 'Transform';
            draft.prompts.secondPass.text = 'Improve';
        }, { expectedRevision: created.revision });
        let call = 0;
        const runner = createTaskRunner({
            executeCompletion: async () => {
                call++;
                return { status: 200, data: {}, content: call === 1 ? 'T1 Alpha' : call === 2 ? 'T1 Beta' : 'T2 merged' };
            },
            countTokens: async () => 1,
        });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        await runner.runPass({ taskId: task.id, passKey: 'transform2', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(stored.passes.transform2.items[COMBINED_KEY].output).toBe('T2 merged');
        expect(stored.passes.transform2.inputRevision).toBe(computePassInputHash(stored, 'transform2'));
        expect(deriveStaleness(stored).transform2).toEqual({ stale: false, reason: 'current' });

        stored.passes.transform1.items.a.output = 'T1 Alpha changed';
        expect(deriveStaleness(stored).transform2).toEqual({ stale: true, reason: 'input_changed' });
    });
});
