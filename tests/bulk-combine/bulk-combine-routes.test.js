import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { BulkCombineTaskRepository } from '../../src/util/bulk-combine/task-repository.js';
import { createTaskEventBus } from '../../src/util/bulk-combine/task-events.js';
import { computePassInputHash } from '../../src/util/bulk-combine/task-state.js';

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

let createBulkCombineRouter;
let sanitizeCompletionSettings;
let router;
let eventBus;
let fakeRunner;
const tempRoots = [];
let userRoot;

function getHandler(method, routePath) {
    const layer = router.stack.find(candidate => candidate.route?.path === routePath && candidate.route.methods[method]);
    return layer.route.stack[0].handle;
}

function makeResponse() {
    return {
        statusCode: 200,
        body: undefined,
        headers: {},
        status(code) {
            this.statusCode = code;
            return this;
        },
        send(body) {
            this.body = body;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        sendStatus(code) {
            this.statusCode = code;
            return this;
        },
        setHeader(name, value) {
            this.headers[name] = value;
        },
        write: jest.fn(),
    };
}

async function invoke(method, routePath, {
    body = {},
    params = {},
    request = {},
    response = makeResponse(),
} = {}) {
    Object.assign(request, {
        body,
        params,
        user: { directories: { root: userRoot } },
    });
    await getHandler(method, routePath)(request, response);
    return response;
}

beforeAll(async () => {
    ({ createBulkCombineRouter, sanitizeCompletionSettings } = await import('../../src/endpoints/bulk-combine.js'));
});

beforeEach(async () => {
    userRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-combine-routes-'));
    tempRoots.push(userRoot);
    eventBus = createTaskEventBus();
    fakeRunner = {
        runPromptAssist: jest.fn(async () => null),
        runPass: jest.fn(async () => null),
        runPostProcess: jest.fn(async () => null),
        resume: jest.fn(async () => null),
        cancel: jest.fn(async () => false),
    };
    router = createBulkCombineRouter({ runner: fakeRunner, eventBus });
});

afterAll(async () => {
    await Promise.all(tempRoots.map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('/api/bulk-combine task routes', () => {
    test('supports create, list, get, patch, and delete', async () => {
        const createResponse = await invoke('post', '/tasks', { body: { name: 'Route task' } });
        expect(createResponse.statusCode).toBe(201);
        expect(createResponse.body).toMatchObject({ name: 'Route task', revision: 1 });
        const id = createResponse.body.id;

        const listResponse = await invoke('get', '/tasks');
        expect(listResponse.body).toEqual([expect.objectContaining({ id, name: 'Route task' })]);

        const getResponse = await invoke('get', '/tasks/:id', { params: { id } });
        expect(getResponse.body).toEqual({
            ...createResponse.body,
            derivedStaleness: {
                transform1: { stale: false, reason: 'not_run' },
                transform2: { stale: false, reason: 'disabled' },
                summary: { stale: false, reason: 'not_run' },
            },
        });

        const patchResponse = await invoke('patch', '/tasks/:id', {
            params: { id },
            body: {
                expectedRevision: 1,
                patch: { name: 'Patched', settings: { concurrency: 3 } },
            },
        });
        expect(patchResponse.statusCode).toBe(200);
        expect(patchResponse.body).toMatchObject({ name: 'Patched', revision: 2, settings: { concurrency: 3 } });

        const deleteResponse = await invoke('delete', '/tasks/:id', { params: { id } });
        expect(deleteResponse.statusCode).toBe(204);

        const missingResponse = await invoke('get', '/tasks/:id', { params: { id } });
        expect(missingResponse.statusCode).toBe(404);
        expect(missingResponse.body).toEqual({ error: 'task_not_found' });
    });

    test('ignores prototype-polluting patch keys at every depth', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Safe patch' } })).body;
        const patches = [
            JSON.parse('{"__proto__":{"polluted":true}}'),
            { review: { constructor: { x: 1 } } },
        ];

        for (const [index, patch] of patches.entries()) {
            const response = await invoke('patch', '/tasks/:id', {
                params: { id: created.id },
                body: { expectedRevision: index + 1, patch },
            });
            expect(response.statusCode).toBe(200);
            expect(Object.hasOwn(response.body.review, 'constructor')).toBe(false);
            expect(Object.hasOwn(response.body, 'polluted')).toBe(false);
            expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
        }

        const saved = await invoke('get', '/tasks/:id', { params: { id: created.id } });
        expect(Object.hasOwn(saved.body.review, 'constructor')).toBe(false);
        expect(Object.hasOwn(saved.body, 'polluted')).toBe(false);
        expect(Object.hasOwn(Object.prototype, 'polluted')).toBe(false);
    });

    test('returns revision conflicts with the current task', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Conflict' } })).body;
        await invoke('patch', '/tasks/:id', {
            params: { id: created.id },
            body: { expectedRevision: 1, patch: { name: 'Current' } },
        });

        const conflict = await invoke('patch', '/tasks/:id', {
            params: { id: created.id },
            body: { expectedRevision: 1, patch: { name: 'Stale' } },
        });

        expect(conflict.statusCode).toBe(409);
        expect(conflict.body).toEqual({
            error: 'revision_conflict',
            currentTask: expect.objectContaining({ name: 'Current', revision: 2 }),
        });
    });

    test('duplicates, archives, and unarchives tasks', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Original' } })).body;

        const archived = await invoke('post', '/tasks/:id/archive', { params: { id: created.id } });
        expect(archived.statusCode).toBe(200);
        expect(archived.body.archivedAt).not.toBeNull();

        const unarchived = await invoke('post', '/tasks/:id/unarchive', { params: { id: created.id } });
        expect(unarchived.statusCode).toBe(200);
        expect(unarchived.body.archivedAt).toBeNull();

        const duplicate = await invoke('post', '/tasks/:id/duplicate', {
            params: { id: created.id },
            body: { name: 'Copied' },
        });
        expect(duplicate.statusCode).toBe(201);
        expect(duplicate.body).toMatchObject({ name: 'Copied', revision: 1, status: 'draft' });
        expect(duplicate.body.id).not.toBe(created.id);
    });

    test('returns bad request for malformed payloads and ids', async () => {
        const badName = await invoke('post', '/tasks', { body: { name: '' } });
        expect(badName.statusCode).toBe(400);

        const badPatch = await invoke('patch', '/tasks/:id', {
            params: { id: '../escape' },
            body: { expectedRevision: 'one', patch: null },
        });
        expect(badPatch.statusCode).toBe(400);
        expect(badPatch.body).toEqual({ error: 'invalid_request' });
    });

    test('sanitizes completion settings without removing execution fields', () => {
        expect(sanitizeCompletionSettings({
            api_key: 'remove',
            proxy_password: 'remove',
            apiKey: 'remove',
            token: 'remove',
            secret_id: 'secret-reference',
            chat_completion_source: 'openai',
            model: 'test-model',
            custom_url: 'https://example.com/v1',
            reverse_proxy: 'https://proxy.example.com',
            temperature: 0.4,
            max_tokens: 512,
            max_completion_tokens: 500,
            top_p: 0.9,
            stop: ['END'],
        })).toEqual({
            secret_id: 'secret-reference',
            chat_completion_source: 'openai',
            model: 'test-model',
            custom_url: 'https://example.com/v1',
            reverse_proxy: 'https://proxy.example.com',
            temperature: 0.4,
            max_tokens: 512,
            max_completion_tokens: 500,
            top_p: 0.9,
            stop: ['END'],
        });
        expect(sanitizeCompletionSettings(null)).toEqual({});
    });

    test('starts prompt assistance, stores its request, and applies the proposal through PATCH', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Prompt assist' } })).body;
        const repo = new BulkCombineTaskRepository(path.join(userRoot, 'bulk-combine-tasks'));
        const prepared = await repo.checkpoint(created.id, draft => {
            draft.sources = [{ key: 'a', name: 'Alice', fields: { name: 'Alice', description: 'Original' } }];
            draft.prompts.main.text = 'Original prompt';
            draft.passes.transform1.items.a = { status: 'succeeded', output: 'Existing output' };
            draft.passes.transform1.inputRevision = computePassInputHash(draft, 'transform1');
        });

        const assist = await invoke('post', '/tasks/:id/prompts/:promptKey/assist', {
            params: { id: created.id, promptKey: 'main' },
            body: {
                request: 'Make it shorter',
                completionSettings: {
                    model: 'test-model',
                    api_key: 'plaintext-secret',
                },
            },
        });

        expect(assist.statusCode).toBe(202);
        expect(assist.body).toMatchObject({
            id: created.id,
            completion: { model: 'test-model' },
            prompts: {
                main: {
                    text: 'Original prompt',
                    assistant: { request: 'Make it shorter', applied: false },
                },
            },
        });
        expect(assist.body.completion).not.toHaveProperty('api_key');
        expect(fakeRunner.runPromptAssist).toHaveBeenCalledWith({
            taskId: created.id,
            promptKey: 'main',
            repo: expect.any(BulkCombineTaskRepository),
            userDirectories: { root: userRoot },
        });

        const applied = await invoke('patch', '/tasks/:id', {
            params: { id: created.id },
            body: {
                expectedRevision: assist.body.revision,
                patch: {
                    prompts: {
                        main: {
                            text: 'Revised prompt',
                            assistant: {
                                request: 'Make it shorter',
                                proposal: 'Revised prompt',
                                diff: '@@ -1,15 +1,14 @@\n-Original\n+Revised\n  prompt\n',
                                applied: true,
                            },
                        },
                    },
                },
            },
        });
        const fetched = await invoke('get', '/tasks/:id', { params: { id: created.id } });

        expect(prepared.passes.transform1.inputRevision).toBeTruthy();
        expect(applied.body.prompts.main).toMatchObject({
            text: 'Revised prompt',
            assistant: { proposal: 'Revised prompt', applied: true },
        });
        expect(fetched.body.derivedStaleness.transform1).toEqual({ stale: true, reason: 'input_changed' });

        const invalid = await invoke('post', '/tasks/:id/prompts/:promptKey/assist', {
            params: { id: created.id, promptKey: 'unknown' },
            body: { request: 'Rewrite' },
        });
        expect(invalid.statusCode).toBe(400);
        expect(fakeRunner.runPromptAssist).toHaveBeenCalledTimes(1);
    });

    test('starts a pass in the background and stores sanitized completion settings', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Runnable' } })).body;
        fakeRunner.runPass.mockReturnValueOnce(new Promise(() => {}));
        const response = await invoke('post', '/tasks/:id/passes/:pass/run', {
            params: { id: created.id, pass: 'transform1' },
            body: {
                scope: 'all',
                itemKeys: ['character-a'],
                completionSettings: {
                    chat_completion_source: 'openai',
                    secret_id: 'secret-reference',
                    api_key: 'plaintext-secret',
                    proxy_password: 'plaintext-proxy-secret',
                    model: 'test-model',
                    temperature: 0.5,
                },
            },
        });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({
            id: created.id,
            completion: {
                chat_completion_source: 'openai',
                secret_id: 'secret-reference',
                model: 'test-model',
                temperature: 0.5,
            },
        });
        expect(response.body.completion).not.toHaveProperty('api_key');
        expect(response.body.completion).not.toHaveProperty('proxy_password');
        expect(fakeRunner.runPass).toHaveBeenCalledWith({
            taskId: created.id,
            passKey: 'transform1',
            repo: expect.any(BulkCombineTaskRepository),
            userDirectories: { root: userRoot },
            scope: 'all',
            itemKeys: ['character-a'],
        });

        const repo = new BulkCombineTaskRepository(path.join(userRoot, 'bulk-combine-tasks'));
        const stored = await repo.getTask(created.id);
        expect(stored.completion).toEqual(response.body.completion);
    });

    test('rejects invalid passes and missing tasks before scheduling work', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Validation' } })).body;
        const invalidPass = await invoke('post', '/tasks/:id/passes/:pass/run', {
            params: { id: created.id, pass: 'unknown' },
        });
        const missingTask = await invoke('post', '/tasks/:id/passes/:pass/run', {
            params: { id: '00000000-0000-4000-8000-000000000099', pass: 'transform1' },
        });

        expect(invalidPass.statusCode).toBe(400);
        expect(missingTask.statusCode).toBe(404);
        expect(fakeRunner.runPass).not.toHaveBeenCalled();
    });

    test('starts post processing in the background after validating the task', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Post process' } })).body;

        const response = await invoke('post', '/tasks/:id/post-process/run', {
            params: { id: created.id },
        });
        const missing = await invoke('post', '/tasks/:id/post-process/run', {
            params: { id: '00000000-0000-4000-8000-000000000099' },
        });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ id: created.id });
        expect(fakeRunner.runPostProcess).toHaveBeenCalledWith({
            taskId: created.id,
            repo: expect.any(BulkCombineTaskRepository),
            userDirectories: { root: userRoot },
        });
        expect(missing.statusCode).toBe(404);
        expect(fakeRunner.runPostProcess).toHaveBeenCalledTimes(1);
    });

    test('returns the derived review assembly without storing duplicate artifacts', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Review' } })).body;
        const repo = new BulkCombineTaskRepository(path.join(userRoot, 'bulk-combine-tasks'));
        await repo.checkpoint(created.id, draft => {
            draft.sources = [{ key: 'a', name: 'Alice', fields: { name: 'Alice' } }];
            draft.passes.transform1.items.a = {
                status: 'succeeded',
                output: '<character><name>Alice</name></character>',
            };
        });

        const response = await invoke('get', '/tasks/:id/review', { params: { id: created.id } });

        expect(response.body).toEqual({
            fullSourcePass: 'transform1',
            cardBlocks: [{
                key: 'a',
                name: 'Alice',
                xml: '<character><name>Alice</name></character>',
            }],
            lorebookData: { entries: {} },
            mergedDescription: '<character><name>Alice</name></character>',
            post: {
                enabled: false,
                mode: 'replace',
                input: '<character><name>Alice</name></character>',
                output: '',
            },
            destination: 'card',
        });
    });

    test('resumes in the background and returns the current task', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Resume' } })).body;

        const response = await invoke('post', '/tasks/:id/passes/:pass/resume', {
            params: { id: created.id, pass: 'transform1' },
        });

        expect(response.statusCode).toBe(202);
        expect(response.body).toMatchObject({ id: created.id });
        expect(fakeRunner.resume).toHaveBeenCalledWith({
            taskId: created.id,
            repo: expect.any(BulkCombineTaskRepository),
            userDirectories: { root: userRoot },
        });
    });

    test('reports whether cancellation found an active pass', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Cancel' } })).body;
        fakeRunner.cancel.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        const cancelled = await invoke('post', '/tasks/:id/cancel', { params: { id: created.id } });
        const inactive = await invoke('post', '/tasks/:id/cancel', { params: { id: created.id } });

        expect(cancelled.body).toEqual({ cancelled: true });
        expect(inactive.body).toEqual({ cancelled: false });
    });

    test('subscribes to task events and unsubscribes when the request closes', async () => {
        const created = (await invoke('post', '/tasks', { body: { name: 'Events' } })).body;
        const request = new EventEmitter();
        const response = makeResponse();

        await invoke('get', '/tasks/:id/events', {
            params: { id: created.id },
            request,
            response,
        });
        eventBus.emit(created.id, { type: 'progress', completed: 1 });

        expect(response.headers).toEqual({
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        expect(response.write).toHaveBeenCalledWith('data: {"type":"progress","completed":1}\n\n');

        request.emit('close');
        eventBus.emit(created.id, { type: 'progress', completed: 2 });
        expect(response.write).toHaveBeenCalledTimes(1);
    });
});
