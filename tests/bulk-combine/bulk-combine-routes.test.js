import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

jest.unstable_mockModule('../../src/users.js', () => ({
    getAllUserHandles: jest.fn(async () => []),
    getUserDirectories: jest.fn(() => ({ root: '' })),
}));

let router;
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
    };
}

async function invoke(method, routePath, { body = {}, params = {} } = {}) {
    const request = {
        body,
        params,
        user: { directories: { root: userRoot } },
    };
    const response = makeResponse();
    await getHandler(method, routePath)(request, response);
    return response;
}

beforeAll(async () => {
    ({ router } = await import('../../src/endpoints/bulk-combine.js'));
});

beforeEach(async () => {
    userRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-combine-routes-'));
    tempRoots.push(userRoot);
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
        expect(getResponse.body).toEqual(createResponse.body);

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
});
