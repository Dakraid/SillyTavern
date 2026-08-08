'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; toHaveAttribute is a Playwright matcher, unavailable here. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/TaskWizardController.js`.
 *
 * `popup.js` is mocked (captured options + a controllable popup fake);
 * `script.js` is mocked for TaskClient's `getRequestHeaders`. The Node test
 * environment has no DOM, so a minimal fake `document`/element tree backs
 * the shell, rail, and placeholder pages (the implementation uses plain DOM
 * APIs only — no HTML parsing anywhere).
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

const mockCallGenericPopup = jest.fn();

jest.unstable_mockModule('../../public/script.js', () => ({
    getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: mockCallGenericPopup,
    POPUP_TYPE: { DISPLAY: 4 },
    POPUP_RESULT: { CANCELLED: 0 },
}));
// Concrete pages pull in browser-only module chains (utils.js → svg-inject
// touches window at import). Controller tests exercise placeholder pages
// only, so the page-overrides registry is mocked to empty.
jest.unstable_mockModule('../../public/scripts/bulk-combine/wizard/pages/index.js', () => ({
    createWizardPageOverrides: () => ({}),
}));
// resolveCompletionSettings.js loads for real via the controller module; its
// openai.js/extensions.js imports are browser-chain modules, so they are
// mocked to bare bones here (same minimal shape as index.test.js).
jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: {},
}));
jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: {},
    openai_settings: [],
    proxies: [],
}));

// ---------------------------------------------------------------------------
// Minimal fake DOM
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

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
        const list = this._listeners.get(type) ?? [];
        this._listeners.set(type, list.filter((f) => f !== fn));
    }

    /**
     * Fires listeners for an event type (test helper).
     *
     * @param {string} type Event type.
     * @param {object} [event] Extra event fields (may override target).
     */
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

    focus() {
        this.focused = true;
        fakeDocument.activeElement = this;
    }
}

const fakeDocument = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
};

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
}

// ---------------------------------------------------------------------------
// Task fixture + fetch/popup plumbing
// ---------------------------------------------------------------------------

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
        text: jest.fn(async () => JSON.stringify(body)),
    };
}

/**
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
        sources: [
            { key: 'a.png', name: 'Alice', avatar: 'a.png', fields: { name: 'Alice', description: 'A' } },
            { key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob', description: 'B' } },
        ],
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
            main: { text: 'Combine them.', assistant: {} },
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

/** @returns {Promise<void>} Flushes microtasks and short timers. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

let TaskWizardController;
let openTaskHistoryPopup;
let createTaskClient;
let fetchMock;
let taskFixture;
let lastPopup;
let lastPopupOptions;
let popupResolver;

/** @returns {Element} Shell root passed to the popup. */
function shellRoot() {
    return lastPopup.dlg;
}

/** @returns {Element} Header element. */
function header() {
    return shellRoot().children[0];
}

/** @returns {Element[]} Rail item buttons (re-fetched on every call). */
function railItems() {
    const railHost = shellRoot().children[1].children[0];
    return railHost.children[0]?.children ?? [];
}

/** @returns {Element} Rail tablist root. */
function railRoot() {
    return shellRoot().children[1].children[0].children[0];
}

/** @returns {Element} Canvas element. */
function canvas() {
    return shellRoot().children[1].children[1];
}

/** @returns {Element|null} Current page heading (h2). */
function pageHeading() {
    return canvas().children[0]?.children[0] ?? null;
}

/**
 * Opens a controller and waits for the initial render.
 *
 * @param {object} controller Controller instance.
 * @returns {Promise<{openPromise: Promise}>} The pending open() promise (resolves on close).
 */
async function openAndFlush(controller) {
    const openPromise = controller.open('task-1');
    await flush();
    return { openPromise };
}

const originalFetch = global.fetch;
const originalEventSource = global.EventSource;

beforeAll(async () => {
    const controllerModule = await import('../../public/scripts/bulk-combine/wizard/TaskWizardController.js');
    TaskWizardController = controllerModule.TaskWizardController;
    openTaskHistoryPopup = controllerModule.openTaskHistoryPopup;
    const clientModule = await import('../../public/scripts/bulk-combine/services/TaskClient.js');
    createTaskClient = clientModule.createTaskClient;
});

beforeEach(() => {
    FakeEventSource.instances = [];
    taskFixture = makeTask();
    fetchMock = jest.fn(async (url, options = {}) => {
        const method = options.method ?? 'GET';
        if (method === 'PATCH') {
            const patch = JSON.parse(options.body).patch;
            const patched = { ...taskFixture, revision: taskFixture.revision + 1, ...patch };
            delete patched.derivedStaleness;
            taskFixture = { ...taskFixture, ...patch };
            return jsonResponse(patched);
        }
        return jsonResponse(taskFixture);
    });
    global.fetch = fetchMock;
    global.EventSource = FakeEventSource;
    global.document = fakeDocument;
    fakeDocument.activeElement = null;

    lastPopup = null;
    lastPopupOptions = null;
    popupResolver = null;
    mockCallGenericPopup.mockReset();
    mockCallGenericPopup.mockImplementation(async (content, type, inputValue, options = {}) => {
        // Mirror real popup semantics: onClose is followed by resolving the
        // popup promise, no matter which side initiated the close.
        const wrappedOptions = {
            ...options,
            onClose: async (popup) => {
                await options.onClose?.(popup);
                popupResolver?.(0);
            },
        };
        lastPopupOptions = wrappedOptions;
        const popup = {
            dlg: content,
            content,
            completeCancelled: jest.fn(async () => {
                await wrappedOptions.onClose(popup);
            }),
        };
        lastPopup = popup;
        await options.onOpen?.(popup);
        return new Promise((resolve) => {
            popupResolver = resolve;
        });
    });
});

afterEach(() => {
    global.fetch = originalFetch;
    global.EventSource = originalEventSource;
    delete global.document;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TaskWizardController', () => {
    test('opens on the task current page, renders rail + placeholder from the snapshot', async () => {
        const controller = new TaskWizardController({ client: createTaskClient() });
        const { openPromise } = await openAndFlush(controller);

        expect(controller.activePageKey).toBe('cards');
        expect(pageHeading()?.textContent).toBe('Cards');
        expect(pageHeading()?.tabIndex).toBe(-1);
        expect(canvas().textContent).toContain('2 source card snapshot(s)');

        // Rail: 8 tab items, first selected, everything past furthestPage disabled.
        const items = railItems();
        expect(items).toHaveLength(8);
        expect(railRoot().getAttribute('role')).toBe('tablist');
        expect(items[0].getAttribute('role')).toBe('tab');
        expect(items[0].getAttribute('aria-selected')).toBe('true');
        expect(items[0].classList.contains('active')).toBe(true);
        expect(items.slice(1).every((item) => item.disabled)).toBe(true);
        // Conditional pages render visible-but-disabled with a Disabled badge.
        expect(items[3].getAttribute('aria-label')).toContain('Transform 2');
        expect(items[3].getAttribute('aria-label')).toContain('Disabled');

        // Header: name input seeded, save indicator live, history button enabled.
        expect(header().children[1].value).toBe('Test task');
        expect(header().children[2].textContent).toBe('Saved');
        expect(header().children[2].getAttribute('aria-live')).toBe('polite');
        expect(header().children[4].disabled).toBe(false);

        // Popup opened as a non-blocking DISPLAY popup with the shell content.
        expect(lastPopupOptions.wide).toBe(true);
        expect(lastPopup.content).toBe(shellRoot());

        await controller.close();
        await openPromise;
    });

    test('Task History button delegates to the provided onOpenHistory callback (inert without one)', async () => {
        // With no onOpenHistory: clicking the enabled button is a safe no-op.
        const noCallback = new TaskWizardController({ client: createTaskClient() });
        const { openPromise: noCallbackPromise } = await openAndFlush(noCallback);
        const inertButton = header().children[4];
        expect(inertButton.id).toBe('bc_task_history');
        expect(inertButton.disabled).toBe(false);
        expect(() => inertButton.click()).not.toThrow();
        await noCallback.close();
        await noCallbackPromise;

        // With a callback: clicking delegates exactly once.
        const onOpenHistory = jest.fn();
        const controller = new TaskWizardController({ client: createTaskClient(), onOpenHistory });
        const { openPromise } = await openAndFlush(controller);
        header().children[4].click();
        expect(onOpenHistory).toHaveBeenCalledTimes(1);

        await controller.close();
        await openPromise;
    });

    test('navigation re-renders the target page WITHOUT calling any execution endpoint', async () => {
        taskFixture = makeTask({ currentPage: 1, furthestPage: 2 });
        const controller = new TaskWizardController({ client: createTaskClient() });
        const { openPromise } = await openAndFlush(controller);

        railItems()[1].click();
        await flush();

        expect(controller.activePageKey).toBe('prompt');
        expect(pageHeading()?.textContent).toBe('Prompt & Settings');
        // Focus moved to the page heading on page change (a11y contract).
        // (The post-sync re-render replaces the node, so assert by identity
        // of the captured focused element, not the current DOM child.)
        expect(fakeDocument.activeElement?.className).toBe('bc-task-page-title');
        expect(fakeDocument.activeElement?.textContent).toBe('Prompt & Settings');
        // Page position persisted.
        const patchCall = fetchMock.mock.calls.find((call) => (call[1]?.method ?? 'GET') === 'PATCH');
        expect(JSON.parse(patchCall[1].body).patch).toEqual({ currentPage: 2, furthestPage: 2 });
        // Rail selection moved.
        expect(railItems()[1].getAttribute('aria-selected')).toBe('true');
        // Navigation never executes.
        const urls = fetchMock.mock.calls.map((call) => `${call[1]?.method ?? 'GET'} ${call[0]}`);
        expect(urls.every((url) => !/\/run|\/resume|\/cancel|\/assist|\/post-process/.test(url))).toBe(true);

        await controller.close();
        await openPromise;
    });

    test('pages beyond furthestPage and disabled pages are not navigable', async () => {
        taskFixture = makeTask({ currentPage: 1, furthestPage: 8 });
        const controller = new TaskWizardController({ client: createTaskClient() });
        const { openPromise } = await openAndFlush(controller);

        // transform2 is conditionally disabled (secondPassEnabled false).
        railItems()[3].click();
        await flush();
        expect(controller.activePageKey).toBe('cards');
        expect(fetchMock.mock.calls.some((call) => (call[1]?.method ?? 'GET') === 'PATCH')).toBe(false);

        // Beyond furthestPage: re-open with furthestPage 2.
        await controller.close();
        await openPromise;

        taskFixture = makeTask({ currentPage: 1, furthestPage: 2 });
        const controller2 = new TaskWizardController({ client: createTaskClient() });
        const { openPromise: openPromise2 } = await openAndFlush(controller2);
        expect(railItems()[2].disabled).toBe(true);
        railItems()[2].click();
        await flush();
        expect(controller2.activePageKey).toBe('cards');

        await controller2.close();
        await openPromise2;
    });

    test('render passes the state snapshot to the registered page module', async () => {
        taskFixture = makeTask({ currentPage: 2, furthestPage: 2 });
        const renderSpy = jest.fn((container, state) => {
            const heading = fakeDocument.createElement('h2');
            heading.textContent = 'Spy page';
            container.replaceChildren(heading);
            return heading;
        });
        const controller = new TaskWizardController({
            client: createTaskClient(),
            pages: { prompt: { render: renderSpy } },
        });
        const { openPromise } = await openAndFlush(controller);

        expect(renderSpy).toHaveBeenCalled();
        const [containerArg, stateArg] = renderSpy.mock.calls.at(-1);
        expect(containerArg).toBe(canvas());
        expect(stateArg.task.id).toBe('task-1');
        expect(stateArg.pageStates).toHaveLength(8);
        expect(stateArg.currentPage).toBe(2);

        await controller.close();
        await openPromise;
    });

    test('arrow keys move rail focus without selecting; roving tabindex is maintained', async () => {
        taskFixture = makeTask({ currentPage: 1, furthestPage: 3 });
        const controller = new TaskWizardController({ client: createTaskClient() });
        const { openPromise } = await openAndFlush(controller);

        const items = railItems();
        railRoot().fire('keydown', { key: 'ArrowDown', target: items[0] });
        expect(fakeDocument.activeElement).toBe(railItems()[1]);
        expect(railItems()[1].tabIndex).toBe(0);
        expect(railItems()[0].tabIndex).toBe(-1);
        // Focus movement alone never navigates.
        expect(controller.activePageKey).toBe('cards');
        expect(fetchMock.mock.calls.some((call) => (call[1]?.method ?? 'GET') === 'PATCH')).toBe(false);

        railRoot().fire('keydown', { key: 'End', target: railItems()[1] });
        // End skips disabled tail pages and lands on the last enabled one.
        expect(fakeDocument.activeElement).toBe(railItems()[2]);

        await controller.close();
        await openPromise;
    });

    test('close() disposes pages, unsubscribes task events, closes popup, and is idempotent', async () => {
        const disposeSpy = jest.fn();
        const controller = new TaskWizardController({
            client: createTaskClient(),
            pages: {
                cards: {
                    render: (container) => {
                        const heading = fakeDocument.createElement('h2');
                        heading.textContent = 'Cards spy';
                        container.replaceChildren(heading);
                        return heading;
                    },
                    dispose: disposeSpy,
                },
            },
        });
        const { openPromise } = await openAndFlush(controller);
        expect(FakeEventSource.instances).toHaveLength(1);

        await controller.close();
        await openPromise;

        expect(disposeSpy).toHaveBeenCalledTimes(1);
        expect(FakeEventSource.instances[0].closed).toBe(true);
        expect(lastPopup.completeCancelled).toHaveBeenCalledTimes(1);
        expect(controller.state).toBe(null);
        expect(controller.activePageKey).toBe(null);

        await controller.close(); // idempotent
        expect(lastPopup.completeCancelled).toHaveBeenCalledTimes(1);
    });

    test('popup-initiated close (user X button) also tears down the controller', async () => {
        const controller = new TaskWizardController({ client: createTaskClient() });
        const { openPromise } = await openAndFlush(controller);

        await lastPopupOptions.onClose?.(lastPopup);
        await openPromise;

        expect(controller.state).toBe(null);
        expect(FakeEventSource.instances[0].closed).toBe(true);
        // The popup initiated the close; the controller does not re-complete it.
        expect(lastPopup.completeCancelled).not.toHaveBeenCalled();
    });
});

describe('openTaskHistoryPopup (standalone entry)', () => {
    /**
     * Routes fetchMock like a tiny Bulk Combine API: list, get, create.
     *
     * @param {object} [options] Options.
     * @param {object[]} [options.summaries] listTasks() response.
     * @param {Object<string, object>} [options.tasksById] getTask() fixtures by id.
     * @param {object} [options.created] createTask() response.
     * @returns {void}
     */
    function mockHistoryFetch({ summaries = [], tasksById = {}, created } = {}) {
        fetchMock.mockImplementation(async (url, options = {}) => {
            const method = options.method ?? 'GET';
            const path = String(url);
            if (method === 'GET' && path.endsWith('/tasks')) {
                return jsonResponse(summaries);
            }
            if (method === 'POST' && path.endsWith('/tasks')) {
                const body = JSON.parse(options.body);
                return jsonResponse(created ?? makeTask({ id: 'task-new', name: body.name }));
            }
            const getMatch = path.match(/\/tasks\/([^/]+)$/);
            if (method === 'GET' && getMatch) {
                return jsonResponse(tasksById[getMatch[1]] ?? makeTask({ id: getMatch[1] }));
            }
            return jsonResponse(taskFixture);
        });
    }

    /** @returns {Element} Task History panel root inside the captured popup. */
    function historyRoot() {
        return lastPopup.content.children[0];
    }

    test('lists tasks; Open closes the popup and opens that task in the wizard', async () => {
        mockHistoryFetch({
            summaries: [{ id: 'task-9', name: 'Old task', status: 'draft', updatedAt: '' }],
            tasksById: { 'task-9': makeTask({ id: 'task-9', name: 'Old task' }) },
        });

        const popupPromise = openTaskHistoryPopup({ client: createTaskClient() });
        await flush();

        expect(mockCallGenericPopup).toHaveBeenCalledTimes(1);
        expect(lastPopupOptions.wide).toBe(true);
        expect(historyRoot().className).toBe('bc-task-history');

        const list = historyRoot().children[2];
        expect(list.className).toBe('bc-task-history-list');
        const row = list.children[0];
        expect(row.textContent).toContain('Old task');
        const openButton = row.children[1].children[0];
        expect(openButton.textContent).toBe('Open');

        const historyPopup = lastPopup;
        openButton.click();
        await flush();

        // History popup closed; the wizard opened for task-9.
        expect(historyPopup.completeCancelled).toHaveBeenCalledTimes(1);
        expect(mockCallGenericPopup).toHaveBeenCalledTimes(2);
        expect(lastPopup.dlg.className).toBe('bc-task');
        expect(header().children[1].value).toBe('Old task');

        await popupPromise;
        await lastPopup.completeCancelled(); // close the wizard
        await flush();
    });

    test('New task creates a fresh task and opens it in the wizard', async () => {
        mockHistoryFetch({
            summaries: [],
            created: makeTask({ id: 'task-new', name: 'New Combine Task' }),
            tasksById: { 'task-new': makeTask({ id: 'task-new', name: 'New Combine Task' }) },
        });

        const popupPromise = openTaskHistoryPopup({ client: createTaskClient() });
        await flush();

        expect(historyRoot().children[2].className).toBe('bc-task-history-empty');

        const newButton = historyRoot().children[0].children[1];
        expect(newButton.textContent).toBe('New task');
        newButton.click();
        await flush();

        expect(fetchMock.mock.calls.some((call) =>
            (call[1]?.method ?? 'GET') === 'POST' && String(call[0]).endsWith('/tasks'),
        )).toBe(true);
        expect(mockCallGenericPopup).toHaveBeenCalledTimes(2);
        expect(header().children[1].value).toBe('New Combine Task');

        await popupPromise;
        await lastPopup.completeCancelled(); // close the wizard
        await flush();
    });
});
