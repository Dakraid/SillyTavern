'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/components/TaskHistoryPanel.js`.
 *
 * The module is pure (no imports; the TaskClient is injected), so the only
 * harness is a minimal fake `document`/element tree — the implementation
 * uses plain DOM APIs only. Mirrors `postPage.test.js`.
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

// ---------------------------------------------------------------------------
// Minimal fake DOM (mirrors postPage.test.js)
// ---------------------------------------------------------------------------

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.className = '';
        this.value = '';
        this.disabled = false;
        this.tabIndex = 0;
        this.title = '';
        this.type = '';
        this.id = '';
        this.src = '';
        this.alt = '';
        this.placeholder = '';
        this.focused = false;
        this._text = '';
        this._listeners = new Map();
    }

    get classList() {
        const el = this;
        const read = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...classes) => {
                el.className = [...new Set([...read(), ...classes])].join(' ');
            },
            remove: (...classes) => {
                el.className = read().filter((c) => !classes.includes(c)).join(' ');
            },
            contains: (c) => read().includes(c),
        };
    }

    get textContent() {
        if (this.children.length > 0) {
            return this.children.map((child) => child.textContent).join('');
        }
        return this._text;
    }

    set textContent(value) {
        this._text = String(value ?? '');
        this.children = [];
    }

    append(...nodes) {
        for (const node of nodes) {
            node.parentElement = this;
            this.children.push(node);
        }
    }

    replaceChildren(...nodes) {
        for (const child of this.children) {
            child.parentElement = null;
        }
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(fn);
    }

    removeEventListener() { /* not exercised */ }

    fire(type, event = {}) {
        for (const fn of this._listeners.get(type) ?? []) {
            fn({ target: this, preventDefault: () => {}, ...event });
        }
    }

    click() {
        if (this.disabled) {
            return;
        }
        this.fire('click');
    }
}

const fakeDocument = { createElement: (tag) => new FakeElement(tag) };

// ---------------------------------------------------------------------------
// Traversal helpers
// ---------------------------------------------------------------------------

function walk(node, visit) {
    visit(node);
    for (const child of node.children ?? []) {
        walk(child, visit);
    }
}

function findAll(root, predicate) {
    const matches = [];
    walk(root, (element) => {
        if (predicate(element)) {
            matches.push(element);
        }
    });
    return matches;
}

function findOne(root, predicate) {
    return findAll(root, predicate)[0] ?? null;
}

function hasClass(className) {
    return (element) => String(element.className ?? '').split(/\s+/).includes(className);
}

/** Flushes the full promise microtask queue. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTask(overrides = {}) {
    return {
        id: 'task-1',
        name: 'First task',
        status: 'draft',
        currentPage: 1,
        archivedAt: null,
        updatedAt: '2026-08-01T12:00:00.000Z',
        lastActivityAt: '2026-08-01T12:00:00.000Z',
        ...overrides,
    };
}

function makeClient(listResult = []) {
    return {
        listTasks: jest.fn(async () => listResult),
        createTask: jest.fn(async () => makeTask({ id: 'task-new' })),
        deleteTask: jest.fn(async () => null),
        duplicateTask: jest.fn(async (id) => makeTask({ id: `${id}-copy`, name: 'Copy' })),
        archiveTask: jest.fn(async (id) => makeTask({ id, archivedAt: '2026-08-02T00:00:00.000Z' })),
        unarchiveTask: jest.fn(async (id) => makeTask({ id, archivedAt: null })),
    };
}

let createTaskHistoryPanel;
let container;

beforeAll(async () => {
    ({ createTaskHistoryPanel } = await import('../../public/scripts/bulk-combine/components/TaskHistoryPanel.js'));
});

beforeEach(() => {
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    jest.restoreAllMocks();
});

function renderPanel({ client = makeClient(), onOpenTask = jest.fn(), onNewTask = jest.fn(), currentTaskId = null } = {}) {
    const panel = createTaskHistoryPanel({ client, onOpenTask, onNewTask, currentTaskId });
    const returned = panel.render(container);
    return { panel, returned, client, onOpenTask, onNewTask };
}

/** Current rows (re-queries the live container; children are replaced on repaint). */
function rows() {
    return findAll(container, hasClass('bc-task-history-row'));
}

function rowById(id) {
    return findOne(container, (element) =>
        hasClass('bc-task-history-row')(element) && element.getAttribute('data-task-id') === id);
}

function buttonIn(root, className) {
    return findOne(root, hasClass(className));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskHistoryPanel', () => {
    test('shows a loading state on first render, then one row per task after listTasks resolves', async () => {
        const client = makeClient([
            makeTask({ id: 'task-1', name: 'Alpha' }),
            makeTask({ id: 'task-2', name: 'Beta' }),
        ]);
        const { returned } = renderPanel({ client });

        // Loading state is visible synchronously after render.
        expect(returned).not.toBe(null);
        const loading = findOne(container, hasClass('bc-task-history-loading'));
        expect(loading.getAttribute('role')).toBe('status');
        expect(client.listTasks).toHaveBeenCalledTimes(1);

        await flush();

        expect(findOne(container, hasClass('bc-task-history-loading'))).toBe(null);
        const renderedRows = rows();
        expect(renderedRows).toHaveLength(2);
        expect(renderedRows[0].textContent).toContain('Alpha');
        expect(renderedRows[1].textContent).toContain('Beta');
        // The initial fetch is not repeated by the repaint.
        expect(client.listTasks).toHaveBeenCalledTimes(1);
    });

    test('deduplicates the in-flight fetch across repeated renders', async () => {
        const client = makeClient([makeTask()]);
        const { panel } = renderPanel({ client });

        panel.render(container);
        panel.render(container);
        await flush();

        expect(client.listTasks).toHaveBeenCalledTimes(1);
        expect(rows()).toHaveLength(1);
    });

    test('rows show a status hint pill and a last-updated line', async () => {
        const client = makeClient([makeTask({ id: 'task-1', status: 'interrupted' })]);
        renderPanel({ client });
        await flush();

        const pill = buttonIn(rowById('task-1'), 'bc-task-history-pill');
        expect(pill.textContent).toBe('Interrupted');
        expect(pill.getAttribute('data-status')).toBe('interrupted');

        const updated = buttonIn(rowById('task-1'), 'bc-task-history-updated');
        expect(updated.textContent).toContain('Updated');
        expect(updated.getAttribute('datetime')).toBe('2026-08-01T12:00:00.000Z');
    });

    test('Open calls onOpenTask(id); the current task has no Open button and a Current badge', async () => {
        const client = makeClient([
            makeTask({ id: 'task-1', name: 'Current one' }),
            makeTask({ id: 'task-2', name: 'Other one' }),
        ]);
        const onOpenTask = jest.fn();
        renderPanel({ client, onOpenTask, currentTaskId: 'task-1' });
        await flush();

        const currentRow = rowById('task-1');
        expect(buttonIn(currentRow, 'bc-task-history-open')).toBe(null);
        expect(buttonIn(currentRow, 'bc-task-history-current').textContent).toBe('Current');

        const otherRow = rowById('task-2');
        const open = buttonIn(otherRow, 'bc-task-history-open');
        expect(open).not.toBe(null);
        open.click();

        expect(onOpenTask).toHaveBeenCalledTimes(1);
        expect(onOpenTask).toHaveBeenCalledWith('task-2');
        // Opening navigates; it does not re-fetch the list.
        expect(client.listTasks).toHaveBeenCalledTimes(1);
    });

    test('Duplicate calls client.duplicateTask(id) and re-fetches the list', async () => {
        const client = makeClient([makeTask({ id: 'task-1' })]);
        renderPanel({ client });
        await flush();

        buttonIn(rowById('task-1'), 'bc-task-history-duplicate').click();
        await flush();

        expect(client.duplicateTask).toHaveBeenCalledTimes(1);
        expect(client.duplicateTask).toHaveBeenCalledWith('task-1');
        expect(client.listTasks).toHaveBeenCalledTimes(2);
    });

    test('Archive/Unarchive toggles by the archived flag and re-fetches', async () => {
        const client = makeClient([
            makeTask({ id: 'task-1', archivedAt: null }),
            makeTask({ id: 'task-2', archivedAt: '2026-07-01T00:00:00.000Z' }),
        ]);
        renderPanel({ client });
        await flush();

        expect(buttonIn(rowById('task-1'), 'bc-task-history-archive').textContent).toBe('Archive');
        expect(buttonIn(rowById('task-2'), 'bc-task-history-archive').textContent).toBe('Unarchive');
        expect(buttonIn(rowById('task-2'), 'bc-task-history-archived').textContent).toBe('Archived');
        expect(buttonIn(rowById('task-1'), 'bc-task-history-archived')).toBe(null);

        buttonIn(rowById('task-1'), 'bc-task-history-archive').click();
        await flush();

        expect(client.archiveTask).toHaveBeenCalledTimes(1);
        expect(client.archiveTask).toHaveBeenCalledWith('task-1');
        expect(client.unarchiveTask).not.toHaveBeenCalled();

        // Children were replaced by the refresh — re-query before clicking again.
        buttonIn(rowById('task-2'), 'bc-task-history-archive').click();
        await flush();

        expect(client.unarchiveTask).toHaveBeenCalledTimes(1);
        expect(client.unarchiveTask).toHaveBeenCalledWith('task-2');
        expect(client.listTasks).toHaveBeenCalledTimes(3);
    });

    test('Delete requires the inline confirm; confirming calls deleteTask and re-fetches', async () => {
        const client = makeClient([makeTask({ id: 'task-1', name: 'Doomed' })]);
        renderPanel({ client });
        await flush();

        buttonIn(rowById('task-1'), 'bc-task-history-delete').click();

        const confirm = findOne(container, hasClass('bc-task-history-confirm'));
        expect(confirm).not.toBe(null);
        expect(confirm.textContent).toContain('cannot be undone');
        expect(client.deleteTask).not.toHaveBeenCalled();

        buttonIn(confirm, 'bc-task-history-confirm-delete').click();
        await flush();

        expect(client.deleteTask).toHaveBeenCalledTimes(1);
        expect(client.deleteTask).toHaveBeenCalledWith('task-1');
        expect(client.listTasks).toHaveBeenCalledTimes(2);
        // The confirm cluster collapsed after the action.
        expect(findOne(container, hasClass('bc-task-history-confirm'))).toBe(null);
    });

    test('the inline confirm Cancel collapses without deleting', async () => {
        const client = makeClient([makeTask({ id: 'task-1' })]);
        renderPanel({ client });
        await flush();

        buttonIn(rowById('task-1'), 'bc-task-history-delete').click();
        buttonIn(findOne(container, hasClass('bc-task-history-confirm')), 'bc-task-history-confirm-cancel').click();

        expect(findOne(container, hasClass('bc-task-history-confirm'))).toBe(null);
        expect(client.deleteTask).not.toHaveBeenCalled();
        // Row actions are back and no re-fetch happened.
        expect(buttonIn(rowById('task-1'), 'bc-task-history-delete')).not.toBe(null);
        expect(client.listTasks).toHaveBeenCalledTimes(1);
    });

    test('New task calls onNewTask', () => {
        const onNewTask = jest.fn();
        renderPanel({ onNewTask });

        buttonIn(container, 'bc-task-history-new').click();

        expect(onNewTask).toHaveBeenCalledTimes(1);
    });

    test('a failed initial load shows role=alert and Retry re-fetches', async () => {
        const client = makeClient();
        client.listTasks
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce([makeTask({ id: 'task-1' })]);
        renderPanel({ client });
        await flush();

        const errorView = findOne(container, hasClass('bc-task-history-error'));
        expect(errorView.getAttribute('role')).toBe('alert');
        expect(errorView.textContent).toContain('boom');
        expect(rows()).toHaveLength(0);

        buttonIn(errorView, 'bc-task-history-retry').click();
        await flush();

        expect(client.listTasks).toHaveBeenCalledTimes(2);
        expect(findOne(container, hasClass('bc-task-history-error'))).toBe(null);
        expect(rows()).toHaveLength(1);
    });

    test('an action failure shows an inline alert and keeps the list visible', async () => {
        const client = makeClient([makeTask({ id: 'task-1' })]);
        client.archiveTask.mockRejectedValueOnce(new Error('nope'));
        renderPanel({ client });
        await flush();

        buttonIn(rowById('task-1'), 'bc-task-history-archive').click();
        await flush();

        const alert = findOne(container, hasClass('bc-task-history-alert'));
        expect(alert.getAttribute('role')).toBe('alert');
        expect(alert.textContent).toContain('nope');
        expect(rows()).toHaveLength(1);
        // No re-fetch is triggered by a failed action.
        expect(client.listTasks).toHaveBeenCalledTimes(1);
    });

    test('renders the empty state and notes archived tasks are kept', async () => {
        const client = makeClient([]);
        renderPanel({ client });
        await flush();

        const empty = findOne(container, hasClass('bc-task-history-empty'));
        expect(empty).not.toBe(null);
        expect(empty.textContent).toContain('No saved tasks');
        expect(empty.textContent).toContain('Archived tasks are kept');
    });

    test('dispose stops repainting into the container', async () => {
        const client = makeClient([makeTask({ id: 'task-1' })]);
        const { panel } = renderPanel({ client });

        panel.dispose();
        await flush();

        // The container keeps its pre-dispose loading view; the resolved
        // fetch never repaints it.
        expect(findOne(container, hasClass('bc-task-history-loading'))).not.toBe(null);
        expect(rows()).toHaveLength(0);
    });
});
