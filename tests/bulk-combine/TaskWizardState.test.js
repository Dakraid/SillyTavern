'use strict';

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/TaskWizardState.js`.
 *
 * The real `TaskClient` is used with `global.fetch` / `global.EventSource`
 * mocked (same pattern as TaskClient.test.js); `script.js` is mocked for
 * `getRequestHeaders`. `computePageStates` is a pure export and needs no
 * mocks beyond import.
 */

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));

/** @type {typeof import('../../public/scripts/bulk-combine/wizard/TaskWizardState.js')} */
let TaskWizardStateModule;
let TaskWizardState;
let computePageStates;

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
     * @param {object} data Event payload.
     */
    emit(data) {
        this.onmessage?.({ data: JSON.stringify(data) });
    }
}

/**
 * @param {object|string} body Response body.
 * @param {object} [options] Options.
 * @param {number} [options.status] HTTP status.
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
 * Builds a full task fixture (normalized server shape + derivedStaleness).
 *
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Task fixture.
 */
function makeTask(overrides = {}) {
    return {
        id: 'task-1',
        revision: 1,
        name: 'Test task',
        status: 'draft',
        currentPage: 1,
        furthestPage: 1,
        execution: { status: 'idle', pass: null, startedAt: null, interruptedAt: null },
        sources: [],
        settings: {
            mode: 'individual',
            concurrency: 2,
            connectionProfile: null,
            preset: null,
            totalContextTokens: null,
            outputTokens: null,
            destination: 'card',
            xmlMinify: false,
            postProcessingEnabled: false,
            postProcessingMode: 'replace',
            secondPassEnabled: false,
        },
        prompts: {
            main: { text: '', assistant: {} },
            secondPass: { text: '', assistant: {} },
            summary: { text: '', assistant: {} },
            post: { text: '', assistant: {} },
        },
        passes: {
            transform1: { status: 'pending', inputRevision: null, items: {} },
            transform2: { status: 'pending', inputRevision: null, items: {} },
            summary: { status: 'pending', inputRevision: null, items: {} },
        },
        post: {},
        review: {},
        avatar: {},
        artifacts: {},
        derivedStaleness: {
            transform1: { stale: false, reason: 'not_run' },
            transform2: { stale: false, reason: 'disabled' },
            summary: { stale: false, reason: 'not_run' },
        },
        ...overrides,
    };
}

/**
 * Builds a task with two sources and a configured main prompt.
 *
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Task fixture.
 */
function makeReadyTask(overrides = {}) {
    const task = makeTask(overrides);
    task.sources = [
        { key: 'a.png', name: 'Alice', avatar: 'a.png', fields: { name: 'Alice', description: 'A' } },
        { key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob', description: 'B' } },
    ];
    task.prompts.main.text = 'Combine them.';
    return task;
}

/**
 * Returns the status of one page from computed page states.
 *
 * @param {Array} states Page states.
 * @param {string} key Page key.
 * @returns {string} Page status.
 */
function statusOf(states, key) {
    return states.find((page) => page.key === key)?.status;
}

const originalFetch = global.fetch;
const originalEventSource = global.EventSource;
const originalSessionStorage = global.sessionStorage;

/** @type {import('jest-mock').Mock} */
let fetchMock;

beforeAll(async () => {
    TaskWizardStateModule = await import('../../public/scripts/bulk-combine/wizard/TaskWizardState.js');
    TaskWizardState = TaskWizardStateModule.TaskWizardState;
    computePageStates = TaskWizardStateModule.computePageStates;
});

beforeEach(() => {
    FakeEventSource.instances = [];
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    global.EventSource = FakeEventSource;

    const store = new Map();
    global.sessionStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, String(value)),
        removeItem: (key) => store.delete(key),
        clear: () => store.clear(),
    };
});

afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    jest.restoreAllMocks();
});

afterAll(() => {
    if (originalSessionStorage === undefined) {
        delete global.sessionStorage;
    } else {
        global.sessionStorage = originalSessionStorage;
    }
});

// ---------------------------------------------------------------------------
// computePageStates (pure)
// ---------------------------------------------------------------------------

describe('computePageStates', () => {
    test('returns all 8 pages in fixed order with key/title/index', () => {
        const states = computePageStates(makeTask());
        expect(states.map((page) => page.key)).toEqual([
            'cards', 'prompt', 'transform1', 'transform2', 'summary', 'post', 'review', 'avatar',
        ]);
        expect(states.map((page) => page.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(states.every((page) => typeof page.title === 'string' && page.title.length > 0)).toBe(true);
    });

    test('fresh task: everything not_started; conditional pages disabled', () => {
        const states = computePageStates(makeTask());
        expect(statusOf(states, 'cards')).toBe('not_started');
        expect(statusOf(states, 'prompt')).toBe('not_started');
        expect(statusOf(states, 'transform1')).toBe('not_started');
        expect(statusOf(states, 'transform2')).toBe('disabled');
        expect(statusOf(states, 'summary')).toBe('disabled');
        expect(statusOf(states, 'post')).toBe('disabled');
        expect(statusOf(states, 'review')).toBe('not_started');
        expect(statusOf(states, 'avatar')).toBe('not_started');
    });

    test('tolerates a stripped task without derivedStaleness or nested records', () => {
        expect(() => computePageStates({ id: 'x' })).not.toThrow();
        expect(statusOf(computePageStates(null), 'cards')).toBe('not_started');
    });

    test('cards: 1 source ready, 2+ sources complete; prompt: text makes ready', () => {
        const one = computePageStates(makeTask({
            sources: [{ key: 'a.png', name: 'Alice', fields: {} }],
        }));
        expect(statusOf(one, 'cards')).toBe('ready');

        const ready = computePageStates(makeReadyTask());
        expect(statusOf(ready, 'cards')).toBe('complete');
        expect(statusOf(ready, 'prompt')).toBe('ready');
        expect(statusOf(ready, 'transform1')).toBe('ready');
    });

    test('transform1 running from pass status and from execution status', () => {
        const byPass = makeReadyTask();
        byPass.passes.transform1.status = 'running';
        expect(statusOf(computePageStates(byPass), 'transform1')).toBe('running');

        const byExecution = makeReadyTask();
        byExecution.execution = { status: 'running', pass: 'transform1', startedAt: '2026-01-01T00:00:00.000Z', interruptedAt: null };
        expect(statusOf(computePageStates(byExecution), 'transform1')).toBe('running');
    });

    test('transform1 interrupted/failed map to their rail statuses', () => {
        const interrupted = makeReadyTask();
        interrupted.passes.transform1.status = 'interrupted';
        expect(statusOf(computePageStates(interrupted), 'transform1')).toBe('interrupted');

        const failed = makeReadyTask();
        failed.passes.transform1.status = 'failed';
        expect(statusOf(computePageStates(failed), 'transform1')).toBe('failed');
    });

    test('transform1 succeeded + stale => stale; succeeded => complete; partial => complete', () => {
        const stale = makeReadyTask();
        stale.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        stale.derivedStaleness.transform1 = { stale: true, reason: 'input_changed' };
        expect(statusOf(computePageStates(stale), 'transform1')).toBe('stale');

        const complete = makeReadyTask();
        complete.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(complete), 'transform1')).toBe('complete');

        const partial = makeReadyTask();
        partial.passes.transform1 = { status: 'partial', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' }, 'b.png': { status: 'failed' } } };
        expect(statusOf(computePageStates(partial), 'transform1')).toBe('complete');
    });

    test('transform2 disabled when secondPassEnabled false; gated on transform1 results when enabled', () => {
        const enabled = makeReadyTask();
        enabled.settings.secondPassEnabled = true;
        expect(statusOf(computePageStates(enabled), 'transform2')).toBe('not_started');

        enabled.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(enabled), 'transform2')).toBe('ready');
    });

    test('summary disabled unless destination is lorebook; gated on latest transform results', () => {
        expect(statusOf(computePageStates(makeReadyTask()), 'summary')).toBe('disabled');

        const lorebook = makeReadyTask();
        lorebook.settings.destination = 'lorebook';
        expect(statusOf(computePageStates(lorebook), 'summary')).toBe('not_started');

        lorebook.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(lorebook), 'summary')).toBe('ready');
    });

    test('post: disabled when off; ready/skipped/complete/failed from task.post', () => {
        const task = makeReadyTask();
        expect(statusOf(computePageStates(task), 'post')).toBe('disabled');

        task.settings.postProcessingEnabled = true;
        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(task), 'post')).toBe('ready');

        task.post = { status: 'skipped' };
        expect(statusOf(computePageStates(task), 'post')).toBe('skipped');

        task.post = { status: 'succeeded' };
        expect(statusOf(computePageStates(task), 'post')).toBe('complete');

        task.post = { status: 'failed' };
        expect(statusOf(computePageStates(task), 'post')).toBe('failed');
    });

    test('review: not_started without outputs, ready with outputs, stale when upstream stale', () => {
        const task = makeReadyTask();
        expect(statusOf(computePageStates(task), 'review')).toBe('not_started');

        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(task), 'review')).toBe('ready');

        task.derivedStaleness.transform1 = { stale: true, reason: 'input_changed' };
        expect(statusOf(computePageStates(task), 'review')).toBe('stale');
    });

    test('an enabled Transform 2 does not fall back to Transform 1 results for downstream gating', () => {
        const task = makeReadyTask();
        task.settings.secondPassEnabled = true;
        task.settings.postProcessingEnabled = true;
        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };

        const states = computePageStates(task);
        expect(statusOf(states, 'transform1')).toBe('complete');
        expect(statusOf(states, 'transform2')).toBe('ready'); // t1 valid → t2 can run
        // …but downstream pages must NOT treat t1 results as final.
        expect(statusOf(states, 'post')).toBe('not_started');
        expect(statusOf(states, 'review')).toBe('not_started');
        expect(statusOf(states, 'avatar')).toBe('not_started');

        // Once Transform 2 has valid results, downstream unlocks.
        task.passes.transform2 = { status: 'succeeded', inputRevision: 'r2', items: { 'a.png': { status: 'succeeded' } } };
        const after = computePageStates(task);
        expect(statusOf(after, 'post')).toBe('ready');
        // Review still waits for the enabled post pass to settle.
        expect(statusOf(after, 'review')).toBe('not_started');
        task.post = { status: 'skipped' };
        expect(statusOf(computePageStates(task), 'review')).toBe('ready');
    });

    test('review readiness requires the summary pass for a lorebook destination', () => {
        const task = makeReadyTask();
        task.settings.destination = 'lorebook';
        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };

        // Transforms succeeded but the mandatory summary pass has not run.
        expect(statusOf(computePageStates(task), 'review')).toBe('not_started');
        expect(statusOf(computePageStates(task), 'avatar')).toBe('not_started');

        task.passes.summary = { status: 'succeeded', inputRevision: 'r2', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(task), 'review')).toBe('ready');
        expect(statusOf(computePageStates(task), 'avatar')).toBe('ready');
    });

    test('a skipped post pass counts as settled for review readiness; stale required passes do not unlock downstream', () => {
        const task = makeReadyTask();
        task.settings.postProcessingEnabled = true;
        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };

        // Skipped post + valid transform results → review ready (postPage
        // allows continuing after Skip, so the rail must agree).
        task.post = { status: 'skipped' };
        expect(statusOf(computePageStates(task), 'review')).toBe('ready');

        // Stale required results no longer unlock transform2/post.
        const staleTask = makeReadyTask();
        staleTask.settings.secondPassEnabled = true;
        staleTask.settings.postProcessingEnabled = true;
        staleTask.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        staleTask.derivedStaleness.transform1 = { stale: true, reason: 'input_changed' };
        const staleStates = computePageStates(staleTask);
        expect(statusOf(staleStates, 'transform1')).toBe('stale');
        expect(statusOf(staleStates, 'transform2')).toBe('not_started');
        expect(statusOf(staleStates, 'post')).toBe('not_started');
        // Stale outputs stay inspectable (review shows stale, not not_started,
        // when a settled pipeline output exists).
        staleTask.post = { status: 'succeeded' };
        expect(statusOf(computePageStates(staleTask), 'review')).toBe('stale');
    });

    test('post readiness requires the summary pass when the destination is a lorebook', () => {
        const task = makeReadyTask();
        task.settings.destination = 'lorebook';
        task.settings.postProcessingEnabled = true;
        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };

        // Summaries feed post-processing for a lorebook destination.
        expect(statusOf(computePageStates(task), 'post')).toBe('not_started');

        task.passes.summary = { status: 'succeeded', inputRevision: 'r2', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(task), 'post')).toBe('ready');
    });

    test('avatar: ready once review inputs exist, complete once artifacts recorded', () => {
        const task = makeReadyTask();
        expect(statusOf(computePageStates(task), 'avatar')).toBe('not_started');

        task.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };
        expect(statusOf(computePageStates(task), 'avatar')).toBe('ready');

        task.artifacts = { characterId: 42 };
        expect(statusOf(computePageStates(task), 'avatar')).toBe('complete');
    });
});

// ---------------------------------------------------------------------------
// TaskWizardState
// ---------------------------------------------------------------------------

describe('TaskWizardState', () => {
    test('init loads the task via getTask, seeds the snapshot, remembers the id', async () => {
        const task = makeReadyTask({ currentPage: 2, furthestPage: 3 });
        fetchMock.mockResolvedValue(jsonResponse(task));

        const state = new TaskWizardState();
        await state.init('task-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe('/api/bulk-combine/tasks/task-1');
        expect(state.task.id).toBe('task-1');
        expect(state.currentPage).toBe(2);
        expect(state.furthestPage).toBe(3);
        expect(state.pageStates).toHaveLength(8);
        expect(global.sessionStorage.getItem('bulkCombineActiveTaskId')).toBe('task-1');
    });

    test('init accepts a freshly created task object without derivedStaleness', async () => {
        const stripped = makeTask({ id: 'fresh-1' });
        delete stripped.derivedStaleness;
        const state = new TaskWizardState();
        await state.init(stripped);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(state.taskId).toBe('fresh-1');
        expect(state.pageStates).toHaveLength(8);
    });

    test('subscribe does not fire immediately; update notifies and PATCHes with expectedRevision then re-syncs', async () => {
        const task = makeReadyTask();
        let getCount = 0;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                const patched = { ...task, revision: 2, name: 'Renamed' };
                delete patched.derivedStaleness; // PATCH responses omit derivedStaleness.
                return jsonResponse(patched);
            }
            getCount++;
            return jsonResponse(getCount === 1 ? task : { ...task, revision: 2, name: 'Renamed' });
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        const unsubscribe = state.subscribe((snapshot) => received.push(snapshot));
        expect(received).toHaveLength(0);

        await state.update({ name: 'Renamed' });

        // Optimistic notify (saving) + final notify (saved).
        expect(received.length).toBeGreaterThanOrEqual(2);
        expect(received[0].syncState).toBe('saving');
        expect(received[0].task.name).toBe('Renamed');
        expect(received.at(-1).syncState).toBe('saved');
        expect(received.at(-1).conflict).toBe(false);

        const patchCall = fetchMock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'PATCH');
        expect(patchCall).toBeDefined();
        expect(JSON.parse(patchCall[1].body)).toEqual({ expectedRevision: 1, patch: { name: 'Renamed' } });

        unsubscribe();
        const countAfterUnsubscribe = received.length;
        await state.update({ name: 'Again' });
        expect(received).toHaveLength(countAfterUnsubscribe);
    });

    test('a revision conflict rebases the pending patch and retries once with the fresh revision', async () => {
        const task = makeReadyTask();
        // The server moved on: someone else renamed + navigated (revision 5).
        const serverTask = makeReadyTask({ revision: 5, name: 'Server wins', currentPage: 5, furthestPage: 5 });
        delete serverTask.derivedStaleness; // 409 currentTask omits derivedStaleness.
        const finalTask = { ...serverTask, revision: 6, name: 'Local edit', derivedStaleness: task.derivedStaleness };

        let patchCalls = 0;
        let getCount = 0;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                patchCalls++;
                if (patchCalls === 1) {
                    return jsonResponse({ error: 'revision_conflict', currentTask: serverTask }, { status: 409 });
                }
                return jsonResponse({ ...finalTask, derivedStaleness: undefined });
            }
            getCount++;
            return jsonResponse(getCount === 1 ? task : finalTask);
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        state.subscribe((snapshot) => received.push(snapshot));

        await state.update({ name: 'Local edit' });

        // Two PATCHes: the first conflicts, the retry carries the fresh revision.
        expect(patchCalls).toBe(2);
        const bodies = fetchMock.mock.calls
            .filter((call) => (call[1]?.method ?? 'GET') === 'PATCH')
            .map((call) => JSON.parse(call[1].body));
        expect(bodies[0]).toEqual({ expectedRevision: 1, patch: { name: 'Local edit' } });
        expect(bodies[1]).toEqual({ expectedRevision: 5, patch: { name: 'Local edit' } });

        // Resolved as saved: the edit WAS applied on top of the server's task.
        const last = received.at(-1);
        expect(last.conflict).toBe(false);
        expect(last.syncState).toBe('saved');
        expect(last.task.name).toBe('Local edit');
        expect(last.currentPage).toBe(5); // the server's navigation survived the rebase
        expect(last.derivedStaleness).toEqual(task.derivedStaleness); // fresh GET re-synced it
    });

    test('a persistent revision conflict rejects, surfaces the conflict flag, and keeps the server state', async () => {
        const task = makeReadyTask();
        const serverTask = makeReadyTask({ revision: 7, name: 'Server wins', currentPage: 5, furthestPage: 5 });
        delete serverTask.derivedStaleness; // 409 currentTask omits derivedStaleness.
        const authoritative = { ...serverTask, derivedStaleness: task.derivedStaleness };

        let getCount = 0;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                return jsonResponse({ error: 'revision_conflict', currentTask: serverTask }, { status: 409 });
            }
            getCount++;
            return jsonResponse(getCount === 1 ? task : authoritative);
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        state.subscribe((snapshot) => received.push(snapshot));

        // Both the initial PATCH and the single retry conflict → the update
        // rejects so callers do NOT treat the edit as saved.
        await expect(state.update({ name: 'Local edit' })).rejects.toThrow('revision conflict');

        const last = received.at(-1);
        expect(last.conflict).toBe(true);
        expect(last.syncState).toBe('conflict');
        expect(last.task.name).toBe('Server wins');
        expect(last.currentPage).toBe(5);
        // derivedStaleness comes from the authoritative re-fetch, not the 409 payload.
        expect(last.derivedStaleness).toEqual(task.derivedStaleness);

        const patchCount = fetchMock.mock.calls.filter((call) => (call[1]?.method ?? 'GET') === 'PATCH').length;
        expect(patchCount).toBe(2); // exactly one retry
    });

    test('concurrent updates are serialized: each PATCH carries the revision of the previous response', async () => {
        const task = makeReadyTask();
        let serverState = task;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                const { patch } = JSON.parse(options.body);
                serverState = { ...serverState, ...patch, revision: serverState.revision + 1 };
                const response = { ...serverState };
                delete response.derivedStaleness;
                return jsonResponse(response);
            }
            return jsonResponse(serverState);
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        // Fire both updates without awaiting the first: without a write
        // queue, both PATCHes would race with expectedRevision 1.
        const first = state.update({ name: 'First' });
        const second = state.update({ name: 'Second' });
        await Promise.all([first, second]);

        const bodies = fetchMock.mock.calls
            .filter((call) => (call[1]?.method ?? 'GET') === 'PATCH')
            .map((call) => JSON.parse(call[1].body));
        expect(bodies).toHaveLength(2);
        expect(bodies[0]).toEqual({ expectedRevision: 1, patch: { name: 'First' } });
        expect(bodies[1]).toEqual({ expectedRevision: 2, patch: { name: 'Second' } });

        expect(state.task.name).toBe('Second');
        expect(state.syncState).toBe('saved');
    });

    test('a non-conflict failure rejects and rolls the optimistic merge back to the server state', async () => {
        const task = makeReadyTask();
        let serverState = structuredClone(task);
        let failNextPatch = true;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                if (failNextPatch) {
                    failNextPatch = false;
                    return jsonResponse('boom', { status: 500 });
                }
                const { patch } = JSON.parse(options.body);
                serverState = { ...serverState, ...patch, revision: serverState.revision + 1 };
                const response = structuredClone(serverState);
                delete response.derivedStaleness;
                return jsonResponse(response);
            }
            // Fresh copy per GET: the optimistic merge mutates the live
            // snapshot, and the rollback must restore the pristine state.
            return jsonResponse(structuredClone(serverState));
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        state.subscribe((snapshot) => received.push(snapshot));

        await expect(state.update({ name: 'Lost edit' })).rejects.toThrow('boom');

        const last = received.at(-1);
        expect(last.conflict).toBe(false);
        expect(last.syncState).toBe('error');
        // The optimistic mutation was neutralized by the authoritative re-fetch.
        expect(last.task.name).toBe('Test task');
        expect(state.task.name).toBe('Test task');

        // The write chain survives a rejection: a later update still saves.
        await state.update({ name: 'After failure' });
        expect(state.task.name).toBe('After failure');
        expect(state.syncState).toBe('saved');
    });

    test('connectEvents re-syncs the authoritative snapshot on every event and notifies', async () => {
        const task = makeReadyTask();
        const updated = makeReadyTask({ revision: 2 });
        updated.passes.transform1 = { status: 'succeeded', inputRevision: 'r1', items: { 'a.png': { status: 'succeeded' } } };

        let getCount = 0;
        fetchMock.mockImplementation(async () => jsonResponse(getCount++ === 0 ? task : updated));

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        state.subscribe((snapshot) => received.push(snapshot));

        state.connectEvents();
        state.connectEvents(); // idempotent
        expect(FakeEventSource.instances).toHaveLength(1);
        expect(FakeEventSource.instances[0].url).toBe('/api/bulk-combine/tasks/task-1/events');

        FakeEventSource.instances[0].emit({ type: 'pass_completed', passKey: 'transform1' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(received).toHaveLength(1);
        expect(received[0].task.passes.transform1.status).toBe('succeeded');
        expect(getCount).toBe(2); // init GET + event re-sync GET

        state.disconnectEvents();
        expect(FakeEventSource.instances[0].closed).toBe(true);
        state.disconnectEvents(); // idempotent
    });

    test('setPage PATCHes currentPage/furthestPage optimistically and never executes', async () => {
        const task = makeReadyTask();
        let patch = null;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                patch = JSON.parse(options.body).patch;
                const patched = { ...task, revision: 2, ...patch };
                delete patched.derivedStaleness;
                return jsonResponse(patched);
            }
            return jsonResponse(patch ? { ...task, revision: 2, ...patch } : task);
        });

        const state = new TaskWizardState();
        await state.init('task-1');

        const received = [];
        state.subscribe((snapshot) => received.push(snapshot));

        await state.setPage(3);

        expect(state.currentPage).toBe(3);
        expect(state.furthestPage).toBe(3);
        expect(received.at(-1).currentPage).toBe(3);

        const patchCall = fetchMock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'PATCH');
        expect(JSON.parse(patchCall[1].body)).toEqual({
            expectedRevision: 1,
            patch: { currentPage: 3, furthestPage: 3 },
        });

        // No execution endpoint is ever touched by navigation.
        const urls = fetchMock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0]}`);
        expect(urls.every((url) => !/\/run|\/resume|\/cancel|\/assist|\/post-process/.test(url))).toBe(true);
    });

    test('setPage is a no-op for the current page and clamps out-of-range pages', async () => {
        const task = makeReadyTask({ currentPage: 4, furthestPage: 4 });
        let patch = null;
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            if (method === 'PATCH') {
                patch = JSON.parse(options.body).patch;
                return jsonResponse({ ...task, revision: 2, ...patch });
            }
            return jsonResponse(patch ? { ...task, revision: 2, ...patch } : task);
        });

        const state = new TaskWizardState();
        await state.init('task-1');
        fetchMock.mockClear();

        await state.setPage(4);
        expect(fetchMock).not.toHaveBeenCalled();

        await state.setPage(99);
        expect(state.currentPage).toBe(8);
    });
});
