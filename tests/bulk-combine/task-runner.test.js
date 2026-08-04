import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { BulkCombineTaskRepository } from '../../src/util/bulk-combine/task-repository.js';
import {
    createTaskRunner,
    TaskAlreadyRunningError,
    TaskNotResumableError,
} from '../../src/util/bulk-combine/task-runner.js';

const tempRoots = [];
let repo;

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

async function createTask({ count = 3, mode = 'individual', concurrency = 1 } = {}) {
    const created = await repo.createTask({ name: 'Runner task' });
    return repo.updateTask(created.id, task => {
        task.sources = Array.from({ length: count }, (_, index) => source(
            String.fromCharCode(97 + index),
            `Character ${index + 1}`,
        ));
        task.settings.mode = mode;
        task.settings.concurrency = concurrency;
        task.settings.outputTokens = 2;
        task.settings.totalContextTokens = 1000;
        task.prompts.main.text = 'Transform the character';
        task.prompts.secondPass.text = 'Improve the transformed description';
        task.prompts.summary.text = 'Summarize the character';
        task.prompts.post.text = 'Polish the merged characters';
    }, { expectedRevision: created.revision });
}

async function preparePostTask(options = {}) {
    const task = await createTask(options);
    return repo.checkpoint(task.id, draft => {
        draft.settings.postProcessingEnabled = true;
        draft.settings.postProcessingMode = 'append';
        for (const source of draft.sources) {
            draft.passes.transform1.items[source.key] = {
                status: 'succeeded',
                output: `<character><name>${source.name}</name></character>`,
            };
        }
    });
}

function keyFromPrompt(prompt) {
    const match = prompt.match(/<name>Character (\d+)<\/name>/);
    return match ? String.fromCharCode(96 + Number(match[1])) : null;
}

function completion(content) {
    return { status: 200, data: {}, content };
}

function completionErrorResponse() {
    return { status: 400, data: { error: { message: 'provider rejected request' } } };
}

beforeEach(async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-runner-'));
    tempRoots.push(root);
    repo = new BulkCombineTaskRepository(root);
});

afterAll(async () => {
    await Promise.all(tempRoots.map(root => fs.promises.rm(root, { recursive: true, force: true })));
});

describe('bulk combine task runner', () => {
    test('runs transform1 individually and checkpoints outputs and ordered events', async () => {
        const task = await createTask();
        const events = [];
        const executeCompletion = jest.fn(async ({ body }) => {
            const key = keyFromPrompt(body.messages[0].content);
            return completion(`<character><name>Character ${key.charCodeAt(0) - 96}</name><description>${key}</description></character>`);
        });
        const runner = createTaskRunner({
            executeCompletion,
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(result).toEqual({
            passKey: 'transform1',
            status: 'succeeded',
            items: { a: 'succeeded', b: 'succeeded', c: 'succeeded' },
        });
        expect(Object.values(stored.passes.transform1.items).map(item => item.output)).toEqual([
            '<character><name>Character 1</name><description>a</description></character>',
            '<character><name>Character 2</name><description>b</description></character>',
            '<character><name>Character 3</name><description>c</description></character>',
        ]);
        expect(stored.passes.transform1.inputRevision).toMatch(/^[0-9a-f]{64}$/);
        expect(stored.revision).toBeGreaterThan(task.revision);
        expect(events.map(event => event.type)).toEqual([
            'pass_started',
            'item_started',
            'item_succeeded',
            'item_started',
            'item_succeeded',
            'item_started',
            'item_succeeded',
            'pass_completed',
        ]);
        expect(events.every(event => event.taskId === task.id && event.passKey === 'transform1')).toBe(true);
    });

    test('uses the sanitized completion snapshot for execution and token preflight', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.completion = {
                chat_completion_source: 'openai',
                model: 'snapshot-model',
                temperature: 0.25,
            };
        });
        const executeCompletion = jest.fn(async () => completion('<character><name>Result</name></character>'));
        const countTokens = jest.fn(async () => 1);
        const runner = createTaskRunner({ executeCompletion, countTokens });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        expect(countTokens).toHaveBeenCalledWith(expect.any(String), 'snapshot-model');
        expect(executeCompletion).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.objectContaining({
                chat_completion_source: 'openai',
                model: 'snapshot-model',
                temperature: 0.25,
                messages: [expect.objectContaining({ role: 'user' })],
                stream: false,
            }),
        }));
    });

    test('respects the configured individual concurrency', async () => {
        const task = await createTask({ count: 5, concurrency: 2 });
        let inFlight = 0;
        let maxInFlight = 0;
        const executeCompletion = jest.fn(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise(resolve => setTimeout(resolve, 10));
            inFlight--;
            return completion('<character><name>Result</name></character>');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        expect(maxInFlight).toBeLessThanOrEqual(2);
        expect(maxInFlight).toBe(2);
    });

    test('isolates an exhausted item failure from its siblings', async () => {
        const task = await createTask();
        const executeCompletion = jest.fn(async ({ body }) => {
            const key = keyFromPrompt(body.messages[0].content);
            if (key === 'b') throw new Error('provider failure');
            return completion(`<character><name>${key}</name></character>`);
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(result.status).toBe('partial');
        expect(result.items).toEqual({ a: 'succeeded', b: 'failed', c: 'succeeded' });
        expect(stored.passes.transform1.items.b).toMatchObject({
            status: 'failed',
            error: 'Error: provider failure',
            attempts: 3,
        });
        expect(executeCompletion).toHaveBeenCalledTimes(5);
    });

    test('fails an individual item whose completion output is blank', async () => {
        const task = await createTask({ count: 1 });
        const executeCompletion = jest.fn(async () => completion('   \n'));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(result).toMatchObject({ status: 'failed', items: { a: 'failed' } });
        expect(stored.passes.transform1.items.a).toMatchObject({
            status: 'failed',
            output: '',
            error: 'Error: Completion returned empty content',
            attempts: 3,
        });
    });

    test('blocks only overflowing individual prompts before execution', async () => {
        const task = await createTask();
        await repo.checkpoint(task.id, draft => {
            draft.settings.totalContextTokens = 10;
        });
        const executeCompletion = jest.fn(async () => completion('<character><name>ok</name></character>'));
        const countTokens = jest.fn(async text => text.includes('Character 1') ? 20 : 1);
        const runner = createTaskRunner({ executeCompletion, countTokens });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(result.items).toEqual({ a: 'failed', b: 'succeeded', c: 'succeeded' });
        expect(stored.passes.transform1.items.a.error).toBe('Token limit exceeded (needs 22, context 10)');
        expect(executeCompletion).toHaveBeenCalledTimes(2);
    });

    test('runs combined mode as one merged item holding the whole response', async () => {
        const task = await createTask({ mode: 'combined' });
        const output = [
            '<character><name>Character 1</name><description>First</description></character>',
            '<character><name>Character 2</name><description>Second</description></character>',
            '<character><name>Character 3</name><description>Third</description></character>',
        ].join('\n');
        const executeCompletion = jest.fn(async () => completion(output));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(executeCompletion).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ status: 'succeeded', items: { __combined__: 'succeeded' } });
        expect(stored.passes.transform1.items.__combined__.output).toBe(output);
        expect(stored.passes.transform1.items.__combined__.error).toBe(null);
        expect(stored.passes.transform1.status).toBe('succeeded');
    });

    test('feeds the merged transform1 output into combined transform2 and summary', async () => {
        const task = await createTask({ mode: 'combined' });
        await repo.checkpoint(task.id, draft => {
            draft.settings.secondPassEnabled = true;
        });
        const prompts = [];
        const executeCompletion = jest.fn(async ({ body }) => {
            prompts.push(body.messages[0].content);
            return completion(`<character><name>Merged pass ${prompts.length}</name></character>`);
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const transform2 = await runner.runPass({ taskId: task.id, passKey: 'transform2', repo, userDirectories: {} });
        const summary = await runner.runPass({ taskId: task.id, passKey: 'summary', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        // Transform 1 embeds every source block; follow-ups consume the
        // upstream merged document, not per-source blocks.
        expect(prompts[0]).toContain('Character 1 description');
        expect(prompts[0]).toContain('Character 3 description');
        expect(prompts[1]).toContain('Merged pass 1');
        expect(prompts[1]).toContain('Improve the transformed description');
        expect(prompts[2]).toContain('Merged pass 2');
        expect(transform2.items).toEqual({ __combined__: 'succeeded' });
        expect(summary.items).toEqual({ __combined__: 'succeeded' });
        expect(stored.passes.summary.items.__combined__.output).toContain('Merged pass 3');
    });

    test('resumes an interrupted combined pass through its merged item', async () => {
        const task = await createTask({ mode: 'combined' });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.status = 'interrupted';
            draft.passes.transform1.items.__combined__ = { status: 'interrupted' };
        });
        const executeCompletion = jest.fn(async () => completion('<character><name>Merged</name></character>'));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.resume({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        expect(result.status).toBe('succeeded');
        expect(executeCompletion).toHaveBeenCalledTimes(1);
        expect((await repo.getTask(task.id)).passes.transform1.items.__combined__.status).toBe('succeeded');
    });

    test('cancels running work, retaining queued items for resume', async () => {
        const task = await createTask();
        let signalStarted;
        const started = new Promise(resolve => {
            signalStarted = resolve;
        });
        const executeCompletion = jest.fn(({ signal }) => new Promise((resolve, reject) => {
            signalStarted();
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const events = [];
        const runner = createTaskRunner({
            executeCompletion,
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        const running = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        await started;
        await runner.cancel(task.id);
        const result = await running;
        const stored = await repo.getTask(task.id);

        expect(result).toEqual({
            passKey: 'transform1',
            status: 'interrupted',
            items: { a: 'interrupted', b: 'queued', c: 'queued' },
        });
        expect(stored.passes.transform1.status).toBe('interrupted');
        expect(stored.execution.status).toBe('interrupted');
        expect(events.at(-1).type).toBe('pass_cancelled');
        await expect(runner.cancel(task.id)).resolves.toBe(false);
    });

    test('resume runs interrupted resumable items but leaves live-running items untouched', async () => {
        const task = await createTask();
        await repo.checkpoint(task.id, draft => {
            draft.activePass = 'transform1';
            draft.passes.transform1.status = 'interrupted';
            draft.passes.transform1.items = {
                a: { status: 'succeeded', output: 'kept' },
                b: { status: 'interrupted', output: '' },
                c: { status: 'running', output: '' },
            };
        });
        const executeCompletion = jest.fn(async ({ body }) => completion(`<character>${keyFromPrompt(body.messages[0].content)}</character>`));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.resume({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(result).toMatchObject({ status: 'partial', items: { b: 'succeeded' } });
        expect(executeCompletion).toHaveBeenCalledTimes(1);
        expect(stored.passes.transform1.status).toBe('partial');
        expect(stored.passes.transform1.items.a.output).toBe('kept');
        expect(stored.passes.transform1.items.c.status).toBe('running');
    });

    test('rejects resume when the named pass is not resumable', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.status = 'interrupted';
            draft.passes.transform1.items.a = { status: 'interrupted' };
        });
        const runner = createTaskRunner({
            executeCompletion: jest.fn(),
            countTokens: async () => 1,
        });

        await expect(runner.resume({
            taskId: task.id,
            passKey: 'summary',
            repo,
            userDirectories: {},
        })).rejects.toBeInstanceOf(TaskNotResumableError);
    });

    test('rejects a second concurrent pass for the same task', async () => {
        const task = await createTask({ count: 1 });
        let release;
        const waiting = new Promise(resolve => {
            release = resolve;
        });
        const executeCompletion = jest.fn(async () => {
            await waiting;
            return completion('<character><name>done</name></character>');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });
        const first = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        await expect(runner.runPass({ taskId: task.id, passKey: 'summary', repo, userDirectories: {} }))
            .rejects.toBeInstanceOf(TaskAlreadyRunningError);
        release();
        await first;
    });

    test('preserves and applies a per-item regeneration hint', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.items.a = {
                status: 'failed',
                regenHint: 'Keep the dry humor',
            };
        });
        const executeCompletion = jest.fn(async ({ body }) => {
            expect(body.messages[0].content).toContain('Additional guidance: Keep the dry humor');
            return completion('<character><name>Character 1</name></character>');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });

        await expect(repo.getTask(task.id)).resolves.toMatchObject({
            passes: {
                transform1: {
                    items: {
                        a: { regenHint: 'Keep the dry humor', hintApplied: true },
                    },
                },
            },
        });
    });

    test('completes disabled transform2 without executing a completion', async () => {
        const task = await createTask({ count: 1 });
        const executeCompletion = jest.fn();
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const result = await runner.runPass({ taskId: task.id, passKey: 'transform2', repo, userDirectories: {} });

        expect(result).toEqual({ passKey: 'transform2', status: 'succeeded', items: { a: 'skipped' } });
        expect(executeCompletion).not.toHaveBeenCalled();
    });

    test('derives transform2 and summary inputs from the latest successful enabled transform', async () => {
        const task = await createTask({ count: 2 });
        await repo.checkpoint(task.id, draft => {
            draft.settings.secondPassEnabled = true;
            draft.passes.transform1.items = {
                a: { status: 'succeeded', output: 'Transform one output' },
                b: { status: 'failed', output: '' },
            };
        });
        const prompts = [];
        const executeCompletion = jest.fn(async ({ body }) => {
            prompts.push(body.messages[0].content);
            return completion(prompts.length === 1 ? 'Transform two output' : 'Summary text');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const transform2 = await runner.runPass({
            taskId: task.id,
            passKey: 'transform2',
            repo,
            userDirectories: {},
            scope: 'all',
        });
        const summary = await runner.runPass({ taskId: task.id, passKey: 'summary', repo, userDirectories: {} });
        const stored = await repo.getTask(task.id);

        expect(transform2.items).toEqual({ a: 'succeeded', b: 'skipped' });
        expect(prompts[0]).toContain('Transform one output');
        expect(prompts[0]).toContain('Improve the transformed description');
        expect(prompts[1]).toContain('Transform two output');
        expect(stored.passes.summary.items.a.output).toBe('Summary text');
        expect(summary.items).toEqual({ a: 'succeeded', b: 'skipped' });
    });

    test('blocks prompt assistance when its prompt exceeds the token window', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.main.assistant.request = 'Rewrite it';
            draft.settings.totalContextTokens = 10;
            draft.settings.outputTokens = null;
        });
        const executeCompletion = jest.fn();
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 11 });

        await expect(runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'main',
            repo,
            userDirectories: {},
        })).rejects.toThrow('Token limit exceeded (needs 11, context 10)');

        expect(executeCompletion).not.toHaveBeenCalled();
        await expect(repo.getTask(task.id)).resolves.toMatchObject({
            prompts: { main: { assistant: { error: 'Error: Token limit exceeded (needs 11, context 10)' } } },
        });
    });

    test('stores a prompt-assist proposal and patch without changing the prompt', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.main.assistant.request = 'Make it concise';
        });
        const executeCompletion = jest.fn(async () => completion('Transform each character concisely.'));
        const events = [];
        const runner = createTaskRunner({
            executeCompletion,
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        const result = await runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'main',
            repo,
            userDirectories: { root: 'user' },
        });
        const stored = await repo.getTask(task.id);

        expect(result).toEqual({ status: 'succeeded', proposal: 'Transform each character concisely.' });
        expect(stored.prompts.main.text).toBe('Transform the character');
        expect(stored.prompts.main.assistant).toMatchObject({
            request: 'Make it concise',
            proposal: 'Transform each character concisely.',
            diff: expect.any(String),
            applied: false,
            error: '',
        });
        expect(stored.prompts.main.assistant.diff).not.toBe('');
        expect(executeCompletion).toHaveBeenCalledWith(expect.objectContaining({
            body: {
                messages: [{
                    role: 'user',
                    content: 'You are helping refine a prompt.\n\nCURRENT PROMPT:\nTransform the character\n\nREFINEMENT REQUEST:\nMake it concise\n\nReturn ONLY the revised prompt text, with no commentary or code fences.',
                }],
                stream: false,
            },
            userDirectories: { root: 'user' },
            signal: expect.any(AbortSignal),
        }));
        expect(events.at(-1).type).toBe('prompt_assist_completed');
    });

    test('skips prompt assistance with an empty request without calling the LLM', async () => {
        const task = await createTask({ count: 1 });
        const executeCompletion = jest.fn();
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        await expect(runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'main',
            repo,
            userDirectories: {},
        })).resolves.toEqual({ status: 'skipped' });

        expect(executeCompletion).not.toHaveBeenCalled();
    });

    test('shares the active guard with prompt assistance and rejects invalid prompt keys', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.main.assistant.request = 'Rewrite it';
        });
        let release;
        const waiting = new Promise(resolve => {
            release = resolve;
        });
        const executeCompletion = jest.fn(async () => {
            await waiting;
            return completion('Rewritten prompt');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });
        const running = runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'main',
            repo,
            userDirectories: {},
        });

        await expect(runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'summary',
            repo,
            userDirectories: {},
        })).rejects.toBeInstanceOf(TaskAlreadyRunningError);
        release();
        await running;
        await expect(runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'unknown',
            repo,
            userDirectories: {},
        })).rejects.toThrow('Invalid prompt key: unknown');
    });

    test('checkpoints and emits a prompt-assist failure without changing the prompt', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.summary.assistant.request = 'Shorten it';
        });
        const events = [];
        const runner = createTaskRunner({
            executeCompletion: jest.fn(async () => completionErrorResponse()),
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        await expect(runner.runPromptAssist({
            taskId: task.id,
            promptKey: 'summary',
            repo,
            userDirectories: {},
        })).rejects.toThrow('provider rejected request');
        const stored = await repo.getTask(task.id);

        expect(stored.prompts.summary.text).toBe('Summarize the character');
        expect(stored.prompts.summary.assistant).toEqual({
            request: 'Shorten it',
            proposal: '',
            diff: '',
            applied: false,
            error: 'Error: provider rejected request',
        });
        expect(events.at(-1)).toMatchObject({
            type: 'prompt_assist_failed',
            error: 'Error: provider rejected request',
        });
    });

    test('strips accidental code fences from a prompt-assist proposal', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.post.assistant.request = 'Improve it';
        });
        const runner = createTaskRunner({
            executeCompletion: jest.fn(async () => completion('```text\nImproved prompt\n```')),
            countTokens: async () => 1,
        });

        await runner.runPromptAssist({ taskId: task.id, promptKey: 'post', repo, userDirectories: {} });

        expect((await repo.getTask(task.id)).prompts.post.assistant.proposal).toBe('Improved prompt');
    });

    test('blocks post processing when the merged payload exceeds the token window', async () => {
        const task = await preparePostTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.settings.totalContextTokens = 5;
            draft.settings.outputTokens = null;
        });
        const executeCompletion = jest.fn();
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 6 });

        await expect(runner.runPostProcess({ taskId: task.id, repo, userDirectories: {} }))
            .rejects.toThrow('Token limit exceeded (needs 6, context 5)');

        expect(executeCompletion).not.toHaveBeenCalled();
        await expect(repo.getTask(task.id)).resolves.toMatchObject({
            post: { status: 'failed', error: 'Error: Token limit exceeded (needs 6, context 5)' },
        });
    });

    test('runs one post-process completion and checkpoints the applied mode output', async () => {
        const task = await preparePostTask({ count: 1 });
        const postOutput = '<character><name>Post</name></character>';
        const events = [];
        const executeCompletion = jest.fn(async () => completion(postOutput));
        const runner = createTaskRunner({
            executeCompletion,
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        const result = await runner.runPostProcess({ taskId: task.id, repo, userDirectories: { root: 'user' } });
        const stored = await repo.getTask(task.id);
        const base = '<character><name>Character 1</name></character>';

        expect(result).toEqual({ status: 'succeeded', output: `${base}\n\n${postOutput}` });
        expect(executeCompletion).toHaveBeenCalledTimes(1);
        expect(executeCompletion).toHaveBeenCalledWith(expect.objectContaining({
            body: expect.objectContaining({
                messages: [{
                    role: 'user',
                    content: `Polish the merged characters\n\nMerged character definitions:\n${base}`,
                }],
                stream: false,
            }),
            userDirectories: { root: 'user' },
            signal: expect.any(AbortSignal),
        }));
        expect(stored.post).toMatchObject({
            status: 'succeeded',
            mode: 'append',
            input: base,
            output: `${base}\n\n${postOutput}`,
            error: null,
            ranAt: expect.any(String),
        });
        expect(events.at(-1).type).toBe('post_process_completed');
    });

    test('checkpoints a failed replace when XML corpus counts differ', async () => {
        const task = await preparePostTask({ count: 2 });
        await repo.checkpoint(task.id, draft => {
            draft.settings.postProcessingMode = 'replace';
        });
        const executeCompletion = jest.fn(async () => completion('<character><name>Only one</name></character>'));
        const events = [];
        const runner = createTaskRunner({
            executeCompletion,
            countTokens: async () => 1,
            emit: (_taskId, event) => events.push(event),
        });

        await expect(runner.runPostProcess({ taskId: task.id, repo, userDirectories: {} })).rejects.toThrow(
            'Post-processing returned 1 root XML corpus block(s), expected 2.',
        );
        const stored = await repo.getTask(task.id);

        expect(stored.post).toMatchObject({
            status: 'failed',
            error: 'Error: Post-processing returned 1 root XML corpus block(s), expected 2.',
            output: '',
        });
        expect(events.at(-1).type).toBe('post_process_failed');
    });

    test('skips post processing when disabled or when the merged description is empty', async () => {
        const disabled = await createTask({ count: 1 });
        const empty = await createTask({ count: 0 });
        await repo.checkpoint(empty.id, draft => {
            draft.settings.postProcessingEnabled = true;
        });
        const executeCompletion = jest.fn();
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        await expect(runner.runPostProcess({ taskId: disabled.id, repo, userDirectories: {} }))
            .resolves.toEqual({ status: 'skipped' });
        await expect(runner.runPostProcess({ taskId: empty.id, repo, userDirectories: {} }))
            .resolves.toEqual({ status: 'skipped' });

        expect(executeCompletion).not.toHaveBeenCalled();
        expect((await repo.getTask(empty.id)).post.status).toBe('skipped');
    });

    test('shares the active guard between passes and post processing', async () => {
        const task = await preparePostTask({ count: 1 });
        let release;
        const waiting = new Promise(resolve => {
            release = resolve;
        });
        const executeCompletion = jest.fn(async () => {
            await waiting;
            return completion('<character><name>done</name></character>');
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });
        const running = runner.runPostProcess({ taskId: task.id, repo, userDirectories: {} });

        await expect(runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} }))
            .rejects.toBeInstanceOf(TaskAlreadyRunningError);
        release();
        await running;
    });

    test('aborts post processing through the shared cancellation controller and clears the guard', async () => {
        const task = await preparePostTask({ count: 1 });
        let started;
        const completionStarted = new Promise(resolve => {
            started = resolve;
        });
        const executeCompletion = jest.fn(({ signal }) => new Promise((resolve, reject) => {
            started();
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });
        const running = runner.runPostProcess({ taskId: task.id, repo, userDirectories: {} });

        await completionStarted;
        await expect(runner.cancel(task.id)).resolves.toBe(true);
        await expect(running).rejects.toThrow('Job cancelled.');
        expect((await repo.getTask(task.id)).post).toMatchObject({ status: 'failed', output: '' });
        await expect(runner.cancel(task.id)).resolves.toBe(false);
    });

    // ------------------------------------------------------------------
    // Parallel item regenerations (item-scoped runs overlap queue runs and
    // each other, capped by the shared per-task concurrency slot pool).
    // ------------------------------------------------------------------

    function deferred() {
        let resolve;
        const promise = new Promise(res => {
            resolve = res;
        });
        return { promise, resolve };
    }

    async function flushTicks(times = 5) {
        for (let index = 0; index < times; index++) {
            await new Promise(resolve => setImmediate(resolve));
        }
    }

    async function waitFor(condition, timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await condition()) return;
            await new Promise(resolve => setImmediate(resolve));
        }
        if (!(await condition())) throw new Error('waitFor timed out');
    }

    function gatedExecutor(started, gates) {
        return jest.fn(({ body, signal }) => {
            const key = keyFromPrompt(body.messages[0].content);
            started.push(key);
            const gate = deferred();
            gates.set(key, gate);
            return new Promise((resolve, reject) => {
                gate.promise.then(() => resolve(completion(`<character><name>${key}</name><description>new ${key}</description></character>`)));
                signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
            });
        });
    }

    test('runs item regenerations in parallel and folds the pass status', async () => {
        const task = await createTask({ count: 2, concurrency: 2 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.status = 'succeeded';
            draft.passes.transform1.items = {
                a: { status: 'succeeded', output: 'old a' },
                b: { status: 'succeeded', output: 'old b' },
            };
        });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const regenA = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        const regenB = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['b'] });
        await waitFor(() => started.length === 2);

        // Both completions are in flight together.
        expect([...started].sort()).toEqual(['a', 'b']);
        gates.get('a').resolve();
        gates.get('b').resolve();
        const [resultA, resultB] = await Promise.all([regenA, regenB]);
        const stored = await repo.getTask(task.id);

        expect(resultA.items).toEqual({ a: 'succeeded' });
        expect(resultB.items).toEqual({ b: 'succeeded' });
        expect(stored.passes.transform1.status).toBe('succeeded');
        expect(stored.passes.transform1.items.a.output).toContain('new a');
        expect(stored.passes.transform1.items.b.output).toContain('new b');
    });

    test('caps parallel regenerations at the task concurrency limit', async () => {
        const task = await createTask({ count: 2, concurrency: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.items = {
                a: { status: 'succeeded', output: 'old a' },
                b: { status: 'succeeded', output: 'old b' },
            };
        });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const regenA = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        await waitFor(() => started.length === 1);
        const regenB = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['b'] });
        await flushTicks();

        // The second regeneration waits for the shared slot.
        expect(started).toEqual(['a']);
        gates.get('a').resolve();
        await waitFor(() => started.length === 2);
        expect(started).toEqual(['a', 'b']);
        gates.get('b').resolve();
        await Promise.all([regenA, regenB]);
    });

    test('runs a regeneration alongside an in-flight queue run without stomping bookkeeping', async () => {
        const task = await createTask({ count: 3, concurrency: 3 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.items = {
                a: { status: 'failed' },
                b: { status: 'failed' },
                c: { status: 'succeeded', output: 'old c' },
            };
        });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const run = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        await waitFor(() => started.length === 2);
        const regen = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['c'] });
        await waitFor(() => started.length === 3);

        // The regeneration runs in parallel with the queue run.
        expect(started).toContain('c');
        gates.get('c').resolve();
        const regenResult = await regen;
        let stored = await repo.getTask(task.id);

        // While the run is live it owns pass/execution bookkeeping.
        expect(regenResult.status).toBe('running');
        expect(stored.passes.transform1.status).toBe('running');
        expect(stored.execution.status).toBe('running');
        expect(stored.passes.transform1.items.c.output).toContain('new c');

        gates.get('a').resolve();
        gates.get('b').resolve();
        const runResult = await run;
        stored = await repo.getTask(task.id);
        expect(runResult.status).toBe('succeeded');
        expect(stored.passes.transform1.status).toBe('succeeded');
        expect(stored.execution.status).toBe('idle');
    });

    test('skips items claimed by another in-flight op in both directions', async () => {
        const task = await createTask({ count: 2, concurrency: 2 });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const regen = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        await waitFor(() => started.length === 1);
        // The queue run claims only b; a is regeneration-claimed.
        const run = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {} });
        await waitFor(() => started.length === 2);
        expect(started).toEqual(['a', 'b']);

        // A duplicate regeneration of the claimed item settles without executing.
        const dupe = await runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        expect(started).toEqual(['a', 'b']);
        expect(dupe.items).toEqual({ a: 'running' });

        gates.get('b').resolve();
        const runResult = await run;
        // a was still regenerating when the run finalized.
        expect(runResult.status).toBe('partial');

        gates.get('a').resolve();
        const regenResult = await regen;
        const stored = await repo.getTask(task.id);
        // The run is gone — the regeneration folds the final pass status.
        expect(regenResult.status).toBe('succeeded');
        expect(stored.passes.transform1.status).toBe('succeeded');
        expect(executeCompletion).toHaveBeenCalledTimes(2);
    });

    test('aborts a regeneration through the shared cancellation controller', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.passes.transform1.items.a = { status: 'succeeded', output: 'old a' };
        });
        let started;
        const completionStarted = new Promise(resolve => {
            started = resolve;
        });
        const executeCompletion = jest.fn(({ signal }) => new Promise((resolve, reject) => {
            started();
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }));
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });
        const regen = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });

        await completionStarted;
        await expect(runner.cancel(task.id)).resolves.toBe(true);
        const result = await regen;
        expect(result.status).toBe('interrupted');
        expect((await repo.getTask(task.id)).passes.transform1.items.a.status).toBe('interrupted');
        await expect(runner.cancel(task.id)).resolves.toBe(false);
    });

    test('keeps prompt assistance exclusive against regenerations in both directions', async () => {
        const task = await createTask({ count: 1 });
        await repo.checkpoint(task.id, draft => {
            draft.prompts.main.assistant.request = 'Rewrite it';
            draft.passes.transform1.items.a = { status: 'succeeded', output: 'old a' };
        });
        const started = [];
        const gates = new Map();
        const executeCompletion = jest.fn(({ body }) => {
            const key = keyFromPrompt(body.messages[0].content) ?? 'assist';
            started.push(key);
            const gate = deferred();
            gates.set(key, gate);
            return gate.promise.then(() => completion(key === 'assist' ? 'Rewritten prompt' : `<character><name>${key}</name></character>`));
        });
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        // Assist blocks a regeneration.
        const assist = runner.runPromptAssist({ taskId: task.id, promptKey: 'main', repo, userDirectories: {} });
        await waitFor(() => started.length === 1);
        await expect(runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] }))
            .rejects.toBeInstanceOf(TaskAlreadyRunningError);
        gates.get('assist').resolve();
        await assist;

        // A regeneration blocks an assist.
        const regen = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        await waitFor(() => started.length === 2);
        await expect(runner.runPromptAssist({ taskId: task.id, promptKey: 'main', repo, userDirectories: {} }))
            .rejects.toBeInstanceOf(TaskAlreadyRunningError);
        gates.get('a').resolve();
        await regen;
    });

    test('cancels one in-flight item without disturbing its siblings', async () => {
        const task = await createTask({ count: 2, concurrency: 2 });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const regenA = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        const regenB = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['b'] });
        await waitFor(() => started.length === 2);

        await expect(runner.cancel(task.id, { passKey: 'transform1', itemKey: 'a' })).resolves.toBe(true);
        const [resultA] = await Promise.all([regenA]);
        expect(resultA.items).toEqual({ a: 'interrupted' });
        // Cancelling the same item again finds nothing in flight.
        await expect(runner.cancel(task.id, { passKey: 'transform1', itemKey: 'a' })).resolves.toBe(false);

        gates.get('b').resolve();
        const resultB = await regenB;
        expect(resultB.items).toEqual({ b: 'succeeded' });
        const stored = await repo.getTask(task.id);
        expect(stored.passes.transform1.items.a.status).toBe('interrupted');
        expect(stored.passes.transform1.items.b.output).toContain('new b');
    });

    test('cancels a queued item before it starts executing', async () => {
        const task = await createTask({ count: 2, concurrency: 1 });
        const started = [];
        const gates = new Map();
        const executeCompletion = gatedExecutor(started, gates);
        const runner = createTaskRunner({ executeCompletion, countTokens: async () => 1 });

        const regenA = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['a'] });
        await waitFor(() => started.length === 1);
        // b is claimed but waits for the shared slot.
        const regenB = runner.runPass({ taskId: task.id, passKey: 'transform1', repo, userDirectories: {}, itemKeys: ['b'] });
        await waitFor(async () => (await repo.getTask(task.id)).passes.transform1.items.b?.status === 'queued');

        await expect(runner.cancel(task.id, { passKey: 'transform1', itemKey: 'b' })).resolves.toBe(true);
        const resultB = await regenB;
        expect(resultB.items).toEqual({ b: 'interrupted' });
        expect(started).toEqual(['a']); // b never executed

        gates.get('a').resolve();
        await regenA;
        // Resolve every gate so no completion is left pending.
        gates.get('b')?.resolve();
        const stored = await repo.getTask(task.id);
        expect(stored.passes.transform1.items.b.status).toBe('interrupted');
        expect(stored.passes.transform1.items.a.status).toBe('succeeded');
    });
});
