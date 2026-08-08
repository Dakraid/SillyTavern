'use strict';

/**
 * Unit tests for `public/scripts/bulk-combine/services/TaskClient.js`.
 *
 * `globalThis.fetch` and `globalThis.EventSource` are mocked; `script.js` is
 * mocked for `getRequestHeaders` so the module stays importable in Node.
 */

import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

const mockHeaders = {
    'Content-Type': 'application/json',
    'X-CSRF-Token': 'test-token',
};

jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({ ...mockHeaders }),
}));

/** @type {typeof import('../../public/scripts/bulk-combine/services/TaskClient.js')} */
let TaskClientModule;
let RevisionConflictError;
let createTaskClient;

/**
 * Fake EventSource capturing every constructed instance.
 */
class FakeEventSource {
    /** @type {FakeEventSource[]} */
    static instances = [];

    constructor(url) {
        this.url = url;
        this.onmessage = null;
        this.onerror = null;
        this.closed = false;
        FakeEventSource.instances.push(this);
    }

    close() {
        this.closed = true;
    }

    /**
     * Simulates an inbound SSE message.
     *
     * @param {object|string} data Event payload (objects are JSON-stringified).
     */
    emit(data) {
        this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
}

/**
 * Builds a fetch Response stub.
 *
 * @param {object|string} body Response body.
 * @param {object} [options] Response options.
 * @param {number} [options.status] HTTP status code.
 * @returns {object} Response stub.
 */
function jsonResponse(body, { status = 200 } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: jest.fn(async () => body),
        text: jest.fn(async () => (typeof body === 'string' ? body : JSON.stringify(body))),
    };
}

/**
 * Builds a minimal task fixture.
 *
 * @param {string} id Task id.
 * @param {number} [revision] Task revision.
 * @param {object} [extra] Extra fields.
 * @returns {object} Task fixture.
 */
function makeTask(id, revision = 1, extra = {}) {
    return { id, revision, name: `Task ${id}`, ...extra };
}

const originalFetch = global.fetch;
const originalEventSource = global.EventSource;

/** @type {import('jest-mock').Mock} */
let fetchMock;
let client;

beforeAll(async () => {
    TaskClientModule = await import('../../public/scripts/bulk-combine/services/TaskClient.js');
    RevisionConflictError = TaskClientModule.RevisionConflictError;
    createTaskClient = TaskClientModule.createTaskClient;
});

beforeEach(() => {
    FakeEventSource.instances = [];
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    global.EventSource = FakeEventSource;
    client = createTaskClient();
});

afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    jest.restoreAllMocks();
});

describe('CRUD', () => {
    test('listTasks GETs the tasks collection with JSON headers', async () => {
        const summaries = [{ id: 'a' }, { id: 'b' }];
        fetchMock.mockResolvedValueOnce(jsonResponse(summaries));

        const result = await client.listTasks();

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks', expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }));
        expect(result).toEqual(summaries);
    });

    test('getTask fetches the full task and caches snapshot and revision', async () => {
        const task = makeTask('t1', 3, { derivedStaleness: { transform1: false } });
        fetchMock.mockResolvedValueOnce(jsonResponse(task));

        const result = await client.getTask('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1', expect.objectContaining({ method: 'GET' }));
        expect(result).toEqual(task);
        expect(client.getCachedTask('t1')).toEqual(task);
        expect(client.getCurrentTask('t1')).toEqual(task);
    });

    test('getCachedTask returns null for unknown tasks', () => {
        expect(client.getCachedTask('nope')).toBeNull();
        expect(client.getCurrentTask('nope')).toBeNull();
    });

    test('createTask posts the name and seeds the revision cache', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 1), { status: 201 }));
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 2)));

        const created = await client.createTask({ name: 'My task' });
        await client.patchTask('t1', { name: 'Renamed' });

        expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/bulk-combine/tasks', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ name: 'My task' }),
        }));
        expect(created.revision).toBe(1);
        // The patch used the seeded revision without a refetch.
        expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/bulk-combine/tasks/t1', expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ expectedRevision: 1, patch: { name: 'Renamed' } }),
        }));
    });

    test('task ids are URL-encoded', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('a/b', 1)));

        await client.getTask('a/b');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/a%2Fb', expect.anything());
    });
});

describe('patchTask optimistic concurrency', () => {
    test('sends expectedRevision from the cache and updates it from the response', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 5)));
        await client.getTask('t1');

        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 6)));
        const updated = await client.patchTask('t1', { name: 'X' });

        expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/bulk-combine/tasks/t1', expect.objectContaining({
            body: JSON.stringify({ expectedRevision: 5, patch: { name: 'X' } }),
        }));
        expect(updated.revision).toBe(6);
        expect(client.getCachedTask('t1').revision).toBe(6);

        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 7)));
        await client.patchTask('t1', { name: 'Y' });
        expect(fetchMock).toHaveBeenNthCalledWith(3, expect.anything(), expect.objectContaining({
            body: JSON.stringify({ expectedRevision: 6, patch: { name: 'Y' } }),
        }));
    });

    test('seeds the revision with a getTask fetch when unknown', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 4)));
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 5)));

        await client.patchTask('t1', { name: 'X' });

        expect(fetchMock).toHaveBeenNthCalledWith(1, '/api/bulk-combine/tasks/t1', expect.objectContaining({ method: 'GET' }));
        expect(fetchMock).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({
            method: 'PATCH',
            body: JSON.stringify({ expectedRevision: 4, patch: { name: 'X' } }),
        }));
    });

    test('on 409 refreshes the cache from currentTask and throws RevisionConflictError', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 2)));
        await client.getTask('t1');

        const currentTask = makeTask('t1', 9, { name: 'Server version' });
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'revision_conflict', currentTask }, { status: 409 }));

        const failure = await client.patchTask('t1', { name: 'Mine' }).then(
            () => { throw new Error('expected a revision conflict'); },
            (error) => error,
        );

        expect(failure).toBeInstanceOf(RevisionConflictError);
        expect(failure).toBeInstanceOf(Error);
        expect(failure.name).toBe('RevisionConflictError');
        expect(failure.taskId).toBe('t1');
        expect(failure.currentTask).toEqual(currentTask);
        expect(client.getCachedTask('t1')).toEqual(currentTask);

        // The next patch uses the refreshed revision.
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 10)));
        await client.patchTask('t1', { name: 'Merged' });
        expect(fetchMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
            body: JSON.stringify({ expectedRevision: 9, patch: { name: 'Merged' } }),
        }));
    });

    test('throws the response text for non-409 failures', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 1)));
        await client.getTask('t1');
        fetchMock.mockResolvedValueOnce(jsonResponse('boom', { status: 500 }));

        await expect(client.patchTask('t1', {})).rejects.toThrow('boom');
    });
});

describe('task operations', () => {
    test('deleteTask issues DELETE and evicts the cached snapshot', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 1)));
        await client.getTask('t1');

        fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: jest.fn(), text: jest.fn(async () => '') });
        const result = await client.deleteTask('t1');

        expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/bulk-combine/tasks/t1', expect.objectContaining({ method: 'DELETE' }));
        expect(result).toBeNull();
        expect(client.getCachedTask('t1')).toBeNull();
    });

    test('deleteTask closes an active subscription', async () => {
        client.subscribeTask('t1', () => {});
        const source = FakeEventSource.instances[0];

        fetchMock.mockResolvedValueOnce({ ok: true, status: 204, json: jest.fn(), text: jest.fn(async () => '') });
        await client.deleteTask('t1');

        expect(source.closed).toBe(true);
        expect(client.getEventSource('t1')).toBeNull();
    });

    test('duplicateTask posts an optional name and caches the new task', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('copy', 1), { status: 201 }));
        const copy = await client.duplicateTask('t1', { name: 'Copy' });

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/duplicate', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ name: 'Copy' }),
        }));
        expect(client.getCachedTask('copy')).toEqual(copy);

        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('copy2', 1), { status: 201 }));
        await client.duplicateTask('t1');
        expect(fetchMock).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ body: '{}' }));
    });

    test('archiveTask and unarchiveTask post to their routes and update the cache', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 2, { archived: true })));
        const archived = await client.archiveTask('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/archive', expect.objectContaining({ method: 'POST' }));
        expect(client.getCachedTask('t1')).toEqual(archived);

        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 3, { archived: false })));
        await client.unarchiveTask('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/unarchive', expect.objectContaining({ method: 'POST' }));
        expect(client.getCachedTask('t1').revision).toBe(3);
    });

    test('getReview fetches the assembled review payload', async () => {
        const payload = { card: { name: 'Group' }, lorebook: [] };
        fetchMock.mockResolvedValueOnce(jsonResponse(payload));

        const result = await client.getReview('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/review', expect.objectContaining({ method: 'GET' }));
        expect(result).toEqual(payload);
    });

    test('validateItem posts passKey/itemKey to the validate route and returns the parsed result', async () => {
        const result = {
            ok: true,
            issues: [{ path: '/character/style', kind: 'missing', message: 'Missing required element' }],
            status: 'succeeded',
        };
        fetchMock.mockResolvedValueOnce(jsonResponse(result));

        const value = await client.validateItem('t1', 'transform1', 'a.png');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/validate', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ passKey: 'transform1', itemKey: 'a.png' }),
        }));
        expect(value).toEqual(result);
    });

    test('validateItem URL-encodes the task id and throws the response text for 404 failures', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'item_not_found' }, { status: 404 }));

        await expect(client.validateItem('a/b', 'transform1', 'missing.png')).rejects.toThrow('item_not_found');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/a%2Fb/validate', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ passKey: 'transform1', itemKey: 'missing.png' }),
        }));
    });
});

describe('execution operations', () => {
    test('runPass posts scope/itemKeys/completionSettings and returns the 202 task', async () => {
        const task = makeTask('t1', 4);
        fetchMock.mockResolvedValueOnce(jsonResponse(task, { status: 202 }));

        const result = await client.runPass('t1', 'transform1', {
            scope: 'explicit',
            itemKeys: ['char-a'],
            completionSettings: { max_tokens: 500 },
        });

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/passes/transform1/run', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ scope: 'explicit', itemKeys: ['char-a'], completionSettings: { max_tokens: 500 } }),
        }));
        expect(result).toEqual(task);
        expect(client.getCachedTask('t1').revision).toBe(4);
    });

    test('runPass omits undefined options from the body', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 1), { status: 202 }));

        await client.runPass('t1', 'summary');

        expect(fetchMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: '{}' }));
    });

    test('resumePass posts to the resume route and returns the 202 task', async () => {
        const task = makeTask('t1', 2);
        fetchMock.mockResolvedValueOnce(jsonResponse(task, { status: 202 }));

        const result = await client.resumePass('t1', 'transform2');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/passes/transform2/resume', expect.objectContaining({ method: 'POST' }));
        expect(result).toEqual(task);
    });

    test('cancelTask posts to the cancel route and returns the acknowledgement', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse({ cancelled: true }));

        const result = await client.cancelTask('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/cancel', expect.objectContaining({ method: 'POST' }));
        expect(result).toEqual({ cancelled: true });
    });

    test('runPostProcess posts to the post-process route and returns the 202 task', async () => {
        const task = makeTask('t1', 6);
        fetchMock.mockResolvedValueOnce(jsonResponse(task, { status: 202 }));

        const result = await client.runPostProcess('t1');

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/post-process/run', expect.objectContaining({ method: 'POST' }));
        expect(result).toEqual(task);
    });

    test('runPromptAssist posts the request and optional completion settings', async () => {
        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 2), { status: 202 }));
        await client.runPromptAssist('t1', 'main', { request: 'improve' });

        expect(fetchMock).toHaveBeenCalledWith('/api/bulk-combine/tasks/t1/prompts/main/assist', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ request: 'improve' }),
        }));

        fetchMock.mockResolvedValueOnce(jsonResponse(makeTask('t1', 3), { status: 202 }));
        await client.runPromptAssist('t1', 'post', { request: 'shorten', completionSettings: { max_tokens: 100 } });

        expect(fetchMock).toHaveBeenLastCalledWith('/api/bulk-combine/tasks/t1/prompts/post/assist', expect.objectContaining({
            body: JSON.stringify({ request: 'shorten', completionSettings: { max_tokens: 100 } }),
        }));
    });
});

describe('subscribeTask', () => {
    test('opens one EventSource to the task events URL and unsubscribe closes it', () => {
        const unsubscribe = client.subscribeTask('t1', () => {});

        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0].url).toBe('/api/bulk-combine/tasks/t1/events');
        expect(client.getEventSource('t1')).toBe(FakeEventSource.instances[0]);

        unsubscribe();

        expect(FakeEventSource.instances[0].closed).toBe(true);
        expect(client.getEventSource('t1')).toBeNull();
    });

    test('parses data JSON and forwards the parsed event and the raw event', () => {
        const events = [];
        client.subscribeTask('t1', (eventObject, rawEvent) => events.push([eventObject, rawEvent]));
        const source = FakeEventSource.instances[0];
        const payload = { type: 'item_succeeded', taskId: 't1', passKey: 'transform1' };

        source.emit(payload);

        expect(events).toHaveLength(1);
        expect(events[0][0]).toEqual(payload);
        expect(events[0][1].data).toBe(JSON.stringify(payload));
    });

    test('drops malformed events without calling onEvent', () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const onEvent = jest.fn();
        client.subscribeTask('t1', onEvent);

        FakeEventSource.instances[0].emit('not-json{');

        expect(onEvent).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalled();
    });

    test('a second subscription replaces the first source', () => {
        client.subscribeTask('t1', () => {});
        const first = FakeEventSource.instances[0];

        client.subscribeTask('t1', () => {});
        const second = FakeEventSource.instances[1];

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(first.closed).toBe(true);
        expect(second.closed).toBe(false);
        expect(client.getEventSource('t1')).toBe(second);
    });

    test('unsubscribe is idempotent', () => {
        const unsubscribe = client.subscribeTask('t1', () => {});

        unsubscribe();

        expect(() => unsubscribe()).not.toThrow();
    });

    test('returns a no-op unsubscribe and logs when EventSource is unavailable', () => {
        delete global.EventSource;
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const unsubscribe = client.subscribeTask('t1', () => {});

        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
        expect(warnSpy).toHaveBeenCalled();
        expect(FakeEventSource.instances).toHaveLength(0);
    });
});
