'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/pages/transformPage.js`.
 *
 * `script.js` is mocked for `getThumbnailUrl` (avatar thumbnails);
 * `resolveCompletionSettings.js` is mocked (its real import chain pulls
 * window-touching modules) — it returns `{ model: 'x', stream: false }` by
 * default and `{}` for the no-model cases. The Node test environment has
 * no DOM, so a minimal fake `document`/element tree backs the page (the
 * implementation uses plain DOM APIs only — no jQuery, no HTML parsing).
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

/** @type {jest.Mock} Controllable resolveCompletionSettings double. */
const mockResolveCompletionSettings = jest.fn(() => ({ model: 'x', stream: false }));

jest.unstable_mockModule('../../public/script.js', () => ({
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(String(file ?? ''))}`,
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/resolveCompletionSettings.js', () => ({
    resolveCompletionSettings: (...args) => mockResolveCompletionSettings(...args),
}));

// ---------------------------------------------------------------------------
// Minimal fake DOM (mirrors cardsPage.test.js)
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

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(fn);
    }

    removeEventListener() { /* not exercised */ }

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

// ---------------------------------------------------------------------------
// Traversal helpers (the fake DOM has no querySelector)
// ---------------------------------------------------------------------------

/**
 * @param {object} node Root fake element.
 * @param {(node: object) => void} visit Visitor.
 * @returns {void}
 */
function walk(node, visit) {
    visit(node);
    for (const child of node.children ?? []) {
        walk(child, visit);
    }
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object[]} Matching elements in document order.
 */
function findAll(root, predicate) {
    const matches = [];
    walk(root, (element) => {
        if (predicate(element)) {
            matches.push(element);
        }
    });
    return matches;
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object|null} First match, or null.
 */
function findOne(root, predicate) {
    return findAll(root, predicate)[0] ?? null;
}

/**
 * @param {string} className Single class token.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasClass(className) {
    return (element) => String(element.className ?? '').split(/\s+/).includes(className);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Source snapshot fixture.
 */
function makeSource(overrides = {}) {
    return {
        key: 'a.png',
        name: 'Alice',
        avatar: 'a.png',
        ...overrides,
    };
}

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Pass item fixture (mirrors `newItem` in the task runner).
 */
function makeItem(overrides = {}) {
    return {
        status: 'pending',
        output: '',
        error: null,
        attempts: 0,
        inputHash: '',
        regenHint: '',
        hintApplied: false,
        ...overrides,
    };
}

/**
 * @returns {Array} Default pageStates (transform1 current; transform2/summary disabled).
 */
function defaultPageStates() {
    return [
        { key: 'cards', index: 1, title: 'Cards', status: 'complete' },
        { key: 'prompt', index: 2, title: 'Prompt & Settings', status: 'ready' },
        { key: 'transform1', index: 3, title: 'Transform 1', status: 'ready' },
        { key: 'transform2', index: 4, title: 'Transform 2', status: 'disabled' },
        { key: 'summary', index: 5, title: 'Lorebook Summary', status: 'disabled' },
        { key: 'post', index: 6, title: 'Post Processing', status: 'not_started' },
        { key: 'review', index: 7, title: 'Review', status: 'not_started' },
        { key: 'avatar', index: 8, title: 'Avatar Studio & Create', status: 'not_started' },
    ];
}

/**
 * @param {object} [overrides] Snapshot overrides (`task` sub-objects are merged explicitly).
 * @returns {object} State snapshot payload (mirrors `TaskWizardState#getSnapshot`).
 */
function makeSnapshot(overrides = {}) {
    const passDefault = () => ({ status: 'pending', inputRevision: null, items: {} });
    const taskDefaults = {
        id: 'task-1',
        name: 'Task',
        revision: 1,
        sources: [
            makeSource(),
            makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png' }),
        ],
        settings: {},
        execution: { status: 'idle', pass: null },
    };
    const t = overrides.task ?? {};
    return {
        derivedStaleness: {},
        pageStates: defaultPageStates(),
        currentPage: 3,
        furthestPage: 3,
        conflict: false,
        syncState: 'saved',
        ...overrides,
        task: {
            ...taskDefaults,
            ...t,
            sources: t.sources ?? taskDefaults.sources,
            settings: { ...taskDefaults.settings, ...(t.settings ?? {}) },
            passes: {
                transform1: { ...passDefault(), ...(t.passes?.transform1 ?? {}) },
                transform2: { ...passDefault(), ...(t.passes?.transform2 ?? {}) },
                summary: { ...passDefault(), ...(t.passes?.summary ?? {}) },
            },
            execution: { ...taskDefaults.execution, ...(t.execution ?? {}) },
        },
    };
}

/** @returns {object} Actions facade mock. */
function makeActions() {
    return {
        update: jest.fn(async () => {}),
        refresh: jest.fn(async () => {}),
        goToPage: jest.fn(),
        navigate: jest.fn(),
        runPass: jest.fn(async () => {}),
        resumePass: jest.fn(async () => {}),
        cancel: jest.fn(async () => {}),
        cancelItem: jest.fn(async () => {}),
        runPostProcess: jest.fn(async () => {}),
        runPromptAssist: jest.fn(async () => {}),
        getReview: jest.fn(async () => {}),
        validateItem: jest.fn(async () => ({ ok: true, issues: [], status: 'succeeded' })),
    };
}

let createTransformPage;
let container;

/** @returns {Promise<void>} Flushes microtasks and short timers (async fire handlers). */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a page, renders it, and returns the pieces under test.
 *
 * @param {object} [snapshot] State snapshot.
 * @param {object} [actions] Actions facade mock.
 * @param {object} [options] Factory options (passKey/title overrides).
 * @returns {{page: object, heading: Element, root: Element, actions: object}} Rendered page pieces.
 */
function renderTransformPage(snapshot = makeSnapshot(), actions = makeActions(), options = {}) {
    const page = createTransformPage({ passKey: 'transform1', title: 'Transform 1', ...options });
    const heading = page.render(container, snapshot, actions);
    return { page, heading, root: container.children[0], actions };
}

beforeAll(async () => {
    ({ createTransformPage } = await import('../../public/scripts/bulk-combine/wizard/pages/transformPage.js'));
});

beforeEach(() => {
    mockResolveCompletionSettings.mockReset();
    mockResolveCompletionSettings.mockReturnValue({ model: 'x', stream: false });
    fakeDocument.activeElement = null;
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('transformPage', () => {
    test('renders heading, one list row per source key with avatar/name/status badge, and queue totals', () => {
        const { heading, root } = renderTransformPage(makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ status: 'succeeded', output: 'AAA' }),
                            'b.png': makeItem({ status: 'pending' }),
                        },
                    },
                },
            },
        }));

        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Transform 1');
        expect(heading.tabIndex).toBe(-1);

        const rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('data-source-key')).toBe('a.png');
        expect(rows[1].getAttribute('data-source-key')).toBe('b.png');
        expect(rows[0].textContent).toContain('Alice');
        expect(rows[1].textContent).toContain('Bob');

        // Status badges use the .bc-task-status pill family.
        const badges = findAll(rows[0], hasClass('bc-task-status'));
        expect(badges).toHaveLength(1);
        expect(badges[0].textContent).toBe('succeeded');
        expect(hasClass('bc-task-status--succeeded')(badges[0])).toBe(true);
        expect(findOne(rows[1], hasClass('bc-task-status')).textContent).toBe('pending');

        // Avatar thumbnails resolve via getThumbnailUrl('avatar', file).
        expect(findOne(rows[0], hasClass('bc-task-transform-item-avatar')).src).toBe('/thumbnail?type=avatar&file=a.png');

        // Queue totals: succeeded/total.
        expect(findOne(root, hasClass('bc-task-transform-totals')).textContent).toBe('1/2 succeeded');
    });

    test('defaults the inspector to the first source; selecting a row shows that item\'s output', () => {
        const snapshot = makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ status: 'succeeded', output: 'AAA' }),
                            'b.png': makeItem({ status: 'succeeded', output: 'BBB' }),
                        },
                    },
                },
            },
        });
        const { root } = renderTransformPage(snapshot);

        // Default selection: first source key.
        let rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows[0].getAttribute('aria-pressed')).toBe('true');
        expect(rows[1].getAttribute('aria-pressed')).toBe('false');
        expect(findOne(root, hasClass('bc-task-transform-output')).value).toBe('AAA');

        // Selecting Bob re-renders locally (no PATCH) and swaps the inspector.
        rows[1].click();
        const freshRows = findAll(container, hasClass('bc-task-transform-item'));
        expect(freshRows[1].getAttribute('aria-pressed')).toBe('true');
        expect(freshRows[0].getAttribute('aria-pressed')).toBe('false');
        expect(findOne(container, hasClass('bc-task-transform-output')).value).toBe('BBB');
        expect(findOne(container, hasClass('bc-task-transform-inspector-name')).textContent).toBe('Bob');
    });

    test('selection falls back to the first key when the selected source disappears', () => {
        const withTwo = makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ output: 'AAA' }),
                            'b.png': makeItem({ output: 'BBB' }),
                        },
                    },
                },
            },
        });
        const page = createTransformPage({ passKey: 'transform1', title: 'Transform 1' });
        const actions = makeActions();
        page.render(container, withTwo, actions);

        findAll(container, hasClass('bc-task-transform-item'))[1].click();
        expect(findOne(container, hasClass('bc-task-transform-output')).value).toBe('BBB');

        // Bob removed on the Cards page: the inspector falls back to Alice.
        const onlyAlice = makeSnapshot({
            task: {
                sources: [makeSource()],
                passes: { transform1: { items: { 'a.png': makeItem({ output: 'AAA' }) } } },
            },
        });
        page.render(container, onlyAlice, actions);
        expect(findAll(container, hasClass('bc-task-transform-item'))).toHaveLength(1);
        expect(findOne(container, hasClass('bc-task-transform-output')).value).toBe('AAA');
        expect(findOne(container, hasClass('bc-task-transform-inspector-name')).textContent).toBe('Alice');
    });

    test('Run calls runPass with resolved completionSettings (default scope omitted)', async () => {
        const { root, actions } = renderTransformPage();
        const run = findOne(root, hasClass('bc-task-transform-run'));
        expect(run.textContent).toBe('Run');
        expect(run.disabled).toBe(false);
        run.click();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
        expect(actions.runPass).toHaveBeenCalledWith('transform1', { completionSettings: { model: 'x', stream: false } });
    });

    test('no resolved model: inline warning plus Run/Regenerate disabled (clicks are no-ops)', () => {
        mockResolveCompletionSettings.mockReturnValue({ stream: false });
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'AAA' }) } } } },
        }));

        const warning = findOne(root, hasClass('bc-task-transform-warning'));
        expect(warning).not.toBe(null);
        expect(warning.getAttribute('role')).toBe('alert');
        expect(warning.textContent).toContain('Prompt & Settings');

        for (const cls of ['bc-task-transform-run', 'bc-task-transform-regen-all', 'bc-task-transform-regen']) {
            const button = findOne(root, hasClass(cls));
            expect(button.disabled).toBe(true);
            expect(button.title).toContain('Prompt & Settings');
            button.click();
        }
        expect(actions.runPass).not.toHaveBeenCalled();
        expect(actions.resumePass).not.toHaveBeenCalled();
    });

    test('Regenerate all calls runPass with scope: all', async () => {
        const { root, actions } = renderTransformPage();
        findOne(root, hasClass('bc-task-transform-regen-all')).click();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
        expect(actions.runPass).toHaveBeenCalledWith('transform1', { scope: 'all', completionSettings: { model: 'x', stream: false } });
    });

    test('Regenerate awaits a pending hint commit before starting the pass (no stale-hint race)', async () => {
        let resolveUpdate;
        const actions = makeActions();
        actions.update = jest.fn(() => new Promise((resolve) => {
            resolveUpdate = resolve;
        }));
        const { root } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'AAA' }) } } } },
        }), actions);

        // Commit a hint change: the PATCH is now in flight (never resolves yet).
        const hint = findOne(root, hasClass('bc-task-transform-hint'));
        hint.value = 'Focus on the betrayal';
        hint.fire('change');
        expect(actions.update).toHaveBeenCalledWith({ passes: { transform1: { items: { 'a.png': { regenHint: 'Focus on the betrayal' } } } } });

        // Regenerate while the hint PATCH is still in flight → the run waits.
        findOne(container, hasClass('bc-task-transform-regen')).click();
        await flush();
        expect(actions.runPass).not.toHaveBeenCalled();

        // Once the hint save settles, the pass starts.
        resolveUpdate();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
        expect(actions.runPass).toHaveBeenCalledWith('transform1', { itemKeys: ['a.png'], completionSettings: { model: 'x', stream: false } });
    });

    test('Run awaits a pending output commit before starting the pass', async () => {
        let resolveUpdate;
        const actions = makeActions();
        actions.update = jest.fn(() => new Promise((resolve) => {
            resolveUpdate = resolve;
        }));
        const { root } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'AAA' }) } } } },
        }), actions);

        const output = findOne(root, hasClass('bc-task-transform-output'));
        output.value = 'AAA edited';
        output.fire('change');

        findOne(root, hasClass('bc-task-transform-run')).click();
        await flush();
        expect(actions.runPass).not.toHaveBeenCalled();

        resolveUpdate();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
    });

    test('Regenerate one calls runPass with itemKeys: [selected key]', async () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ output: 'AAA' }),
                            'b.png': makeItem({ output: 'BBB' }),
                        },
                    },
                },
            },
        }));

        // Select Bob, then regenerate only him.
        findAll(root, hasClass('bc-task-transform-item'))[1].click();
        findOne(container, hasClass('bc-task-transform-regen')).click();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
        expect(actions.runPass).toHaveBeenCalledWith('transform1', { itemKeys: ['b.png'], completionSettings: { model: 'x', stream: false } });
    });

    test('interrupted pass relabels Run to Resume and calls resumePass', async () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { status: 'interrupted' } } },
        }));
        const run = findOne(root, hasClass('bc-task-transform-run'));
        expect(run.textContent).toBe('Resume');
        expect(run.disabled).toBe(false);
        run.click();
        await flush();
        expect(actions.resumePass).toHaveBeenCalledTimes(1);
        expect(actions.resumePass).toHaveBeenCalledWith('transform1');
        expect(actions.runPass).not.toHaveBeenCalled();
    });

    test('Cancel is enabled only while running; running disables Run/Regenerate all but not item Regenerate', () => {
        // Not running: Cancel disabled and inert.
        const settled = renderTransformPage();
        const settledCancel = findOne(settled.root, hasClass('bc-task-transform-cancel'));
        expect(settledCancel.disabled).toBe(true);
        settledCancel.click();
        expect(settled.actions.cancel).not.toHaveBeenCalled();
        expect(findOne(settled.root, hasClass('bc-task-transform-running'))).toBe(null);

        // Running (pass status): Cancel enabled; Run/Regenerate all disabled;
        // single-item Regenerate stays enabled (regens overlap runs server-side).
        const running = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { status: 'running' } } },
        }));
        const cancel = findOne(running.root, hasClass('bc-task-transform-cancel'));
        expect(cancel.disabled).toBe(false);
        expect(findOne(running.root, hasClass('bc-task-transform-run')).disabled).toBe(true);
        expect(findOne(running.root, hasClass('bc-task-transform-regen-all')).disabled).toBe(true);
        expect(findOne(running.root, hasClass('bc-task-transform-regen')).disabled).toBe(false);
        const indicator = findOne(running.root, hasClass('bc-task-transform-running'));
        expect(indicator.getAttribute('role')).toBe('status');
        expect(indicator.textContent).toContain('Running');
        cancel.click();
        expect(running.actions.cancel).toHaveBeenCalledTimes(1);
    });

    test('item Regenerate is disabled while that item is queued or running', () => {
        for (const status of ['queued', 'running']) {
            const { root } = renderTransformPage(makeSnapshot({
                task: {
                    passes: {
                        transform1: {
                            status: 'running',
                            items: { 'a.png': makeItem({ status }) },
                        },
                    },
                },
            }));
            const regen = findOne(root, hasClass('bc-task-transform-regen'));
            expect(regen.disabled).toBe(true);
            regen.click();
        }
    });

    test('item Cancel is enabled while the item is busy and calls cancelItem', async () => {
        const busy = renderTransformPage(makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        status: 'running',
                        items: { 'a.png': makeItem({ status: 'running' }) },
                    },
                },
            },
        }));
        const cancel = findOne(busy.root, hasClass('bc-task-transform-item-cancel'));
        expect(cancel.disabled).toBe(false);
        cancel.click();
        await flush();
        expect(busy.actions.cancelItem).toHaveBeenCalledTimes(1);
        expect(busy.actions.cancelItem).toHaveBeenCalledWith('transform1', 'a.png');

        // Idle item: Cancel disabled and inert.
        const idle = renderTransformPage();
        const idleCancel = findOne(idle.root, hasClass('bc-task-transform-item-cancel'));
        expect(idleCancel.disabled).toBe(true);
        idleCancel.click();
        expect(idle.actions.cancelItem).not.toHaveBeenCalled();
    });

    test('transform1 never merges: combined second-pass mode still renders one row per source', () => {
        const { root } = renderTransformPage(makeSnapshot({
            task: {
                settings: { secondPassEnabled: true, secondPassMode: 'combined' },
                passes: {
                    transform1: {
                        status: 'succeeded',
                        items: {
                            'a.png': makeItem({ status: 'succeeded', output: 'AAA' }),
                            'b.png': makeItem({ status: 'succeeded', output: 'BBB' }),
                        },
                    },
                },
            },
        }));

        const rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('data-source-key')).toBe('a.png');
        expect(rows[1].getAttribute('data-source-key')).toBe('b.png');
        expect(findOne(root, hasClass('bc-task-transform-totals')).textContent).toBe('2/2 succeeded');
    });

    test('transform2 renders one merged placeholder row in combined second-pass mode and regenerates it', async () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            currentPage: 4,
            task: {
                settings: { secondPassEnabled: true, secondPassMode: 'combined' },
                passes: {
                    transform2: {
                        status: 'succeeded',
                        items: { __combined__: makeItem({ status: 'succeeded', output: 'MERGED' }) },
                    },
                },
            },
        }), makeActions(), { passKey: 'transform2', title: 'Transform 2' });

        const rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(1);
        expect(rows[0].getAttribute('data-source-key')).toBe('__combined__');
        expect(rows[0].textContent).toContain('All characters (2)');
        expect(findOne(root, hasClass('bc-task-transform-output')).value).toBe('MERGED');
        expect(findOne(root, hasClass('bc-task-transform-totals')).textContent).toBe('1/1 succeeded');

        findOne(root, hasClass('bc-task-transform-regen')).click();
        await flush();
        expect(actions.runPass).toHaveBeenCalledTimes(1);
        expect(actions.runPass).toHaveBeenCalledWith('transform2', { itemKeys: ['__combined__'], completionSettings: { model: 'x', stream: false } });
    });

    test('transform2 in individual second-pass mode renders one row per source', () => {
        const { root } = renderTransformPage(makeSnapshot({
            currentPage: 4,
            task: {
                settings: { secondPassEnabled: true, secondPassMode: 'individual' },
                passes: {
                    transform2: {
                        status: 'succeeded',
                        items: {
                            'a.png': makeItem({ status: 'succeeded', output: 'A2' }),
                            'b.png': makeItem({ status: 'succeeded', output: 'B2' }),
                        },
                    },
                },
            },
        }), makeActions(), { passKey: 'transform2', title: 'Transform 2' });

        const rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(2);
        expect(rows[0].getAttribute('data-source-key')).toBe('a.png');
        expect(rows[1].getAttribute('data-source-key')).toBe('b.png');
        expect(findOne(root, hasClass('bc-task-transform-totals')).textContent).toBe('2/2 succeeded');
    });

    test('the summary pass merges only when the combined second pass ran', () => {
        const mergedPasses = {
            summary: {
                status: 'succeeded',
                items: { __combined__: makeItem({ status: 'succeeded', output: 'SUMMARY' }) },
            },
        };

        // Combined second pass ran → single merged summary row.
        const merged = renderTransformPage(makeSnapshot({
            currentPage: 5,
            task: {
                settings: { secondPassEnabled: true, secondPassMode: 'combined' },
                passes: mergedPasses,
            },
        }), makeActions(), { passKey: 'summary', title: 'Lorebook Summary' });
        const mergedRows = findAll(merged.root, hasClass('bc-task-transform-item'));
        expect(mergedRows).toHaveLength(1);
        expect(mergedRows[0].getAttribute('data-source-key')).toBe('__combined__');
        expect(findOne(merged.root, hasClass('bc-task-transform-output')).value).toBe('SUMMARY');

        // Individual second pass → per-source rows.
        const individual = renderTransformPage(makeSnapshot({
            currentPage: 5,
            task: {
                settings: { secondPassEnabled: true, secondPassMode: 'individual' },
                passes: mergedPasses,
            },
        }), makeActions(), { passKey: 'summary', title: 'Lorebook Summary' });
        expect(findAll(individual.root, hasClass('bc-task-transform-item'))).toHaveLength(2);

        // Second pass disabled → per-source rows even with a combined mode stored.
        const disabled = renderTransformPage(makeSnapshot({
            currentPage: 5,
            task: {
                settings: { secondPassEnabled: false, secondPassMode: 'combined' },
                passes: mergedPasses,
            },
        }), makeActions(), { passKey: 'summary', title: 'Lorebook Summary' });
        expect(findAll(disabled.root, hasClass('bc-task-transform-item'))).toHaveLength(2);
    });

    test('execution record pointing at the pass also counts as running', () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: { execution: { status: 'running', pass: 'transform1' } },
        }));
        expect(findOne(root, hasClass('bc-task-transform-cancel')).disabled).toBe(false);
        findOne(root, hasClass('bc-task-transform-cancel')).click();
        expect(actions.cancel).toHaveBeenCalledTimes(1);
    });

    test('output input drafts without patching; change patches the item output', () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'server text' }) } } } },
        }));
        const output = findOne(root, hasClass('bc-task-transform-output'));
        expect(output.value).toBe('server text');

        output.value = 'edited output';
        output.fire('input');
        expect(actions.update).not.toHaveBeenCalled();

        output.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ passes: { transform1: { items: { 'a.png': { output: 'edited output' } } } } });
    });

    test('output char-count row reflects the server value, then live typing', () => {
        const { root } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'abcd' }) } } } },
        }));
        const count = findOne(root, hasClass('bc-task-transform-output-count'));
        expect(count.textContent).toBe('4 characters');

        const output = findOne(root, hasClass('bc-task-transform-output'));
        output.value = 'x';
        output.fire('input');
        expect(count.textContent).toBe('1 character');
    });

    test('hint change patches regenHint; hintApplied badge appears when server-set', () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ regenHint: '' }) } } } },
        }));
        expect(findOne(root, hasClass('bc-task-transform-hint-applied'))).toBe(null);

        const hint = findOne(root, hasClass('bc-task-transform-hint'));
        hint.value = 'emphasize the wit';
        hint.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ passes: { transform1: { items: { 'a.png': { regenHint: 'emphasize the wit' } } } } });

        // Server-set hintApplied renders the badge.
        const applied = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ regenHint: 'x', hintApplied: true }) } } } },
        }));
        expect(findOne(applied.root, hasClass('bc-task-transform-hint-applied')).textContent).toContain('Hint applied');
    });

    test('a focused (uncommitted) output draft is not clobbered by a state-driven re-render', () => {
        const snapshot = makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'server text' }) } } } },
        });
        const page = createTransformPage({ passKey: 'transform1', title: 'Transform 1' });
        const actions = makeActions();
        page.render(container, snapshot, actions);

        const output = findOne(container, hasClass('bc-task-transform-output'));
        output.value = 'typing a draft';
        output.fire('input');

        // A snapshot re-render with the unchanged server value keeps the draft.
        page.render(container, makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ output: 'server text' }) } } } },
        }), actions);
        expect(findOne(container, hasClass('bc-task-transform-output')).value).toBe('typing a draft');
        expect(actions.update).not.toHaveBeenCalled();
    });

    test('filter narrows the list by name or status', () => {
        const { root } = renderTransformPage(makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ status: 'failed' }),
                            'b.png': makeItem({ status: 'succeeded' }),
                        },
                    },
                },
            },
        }));
        const filter = findOne(root, hasClass('bc-task-transform-filter'));

        filter.value = 'bob';
        filter.fire('input');
        let rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('Bob');

        filter.value = 'failed';
        filter.fire('input');
        rows = findAll(root, hasClass('bc-task-transform-item'));
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('Alice');

        filter.value = 'zzz';
        filter.fire('input');
        expect(findAll(root, hasClass('bc-task-transform-item'))).toHaveLength(0);
        expect(root.textContent).toContain('No items match the filter.');

        // Clearing restores the full list.
        filter.value = '';
        filter.fire('input');
        expect(findAll(root, hasClass('bc-task-transform-item'))).toHaveLength(2);
    });

    test('failed items surface the error text as an alert in the inspector', () => {
        const { root } = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ status: 'failed', error: 'rate limited' }) } } } },
        }));
        const error = findOne(root, hasClass('bc-task-transform-error'));
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toContain('rate limited');
    });

    test('derived staleness shows a stale note with reasons in the tooltip', () => {
        const { root } = renderTransformPage(makeSnapshot({
            derivedStaleness: { transform1: { stale: true, reasons: ['Sources changed'] } },
        }));
        const stale = findOne(root, hasClass('bc-task-transform-stale'));
        expect(stale.textContent).toContain('may be outdated');
        expect(stale.title).toBe('Sources changed');
    });

    test('Continue is gated on a settled, non-stale pass and goes to the next non-disabled page', () => {
        // Pending pass: Continue is disabled with an explanation.
        const pending = renderTransformPage();
        const pendingContinue = findOne(pending.root, hasClass('bc-task-continue'));
        expect(pendingContinue.disabled).toBe(true);
        expect(pendingContinue.title).toContain('Run this pass');
        pendingContinue.click();
        expect(pending.actions.goToPage).not.toHaveBeenCalled();

        // Failed pass: still locked.
        const failed = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { status: 'failed' } } },
        }));
        expect(findOne(failed.root, hasClass('bc-task-continue')).disabled).toBe(true);

        // Settled (succeeded): enabled → next non-disabled page (Post Processing, 6).
        const settled = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { status: 'succeeded', items: { 'a.png': makeItem({ status: 'succeeded' }) } } } },
        }));
        const continueButton = findOne(settled.root, hasClass('bc-task-continue'));
        expect(continueButton.textContent).toBe('Continue to Post Processing');
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        expect(settled.actions.goToPage).toHaveBeenCalledTimes(1);
        expect(settled.actions.goToPage).toHaveBeenCalledWith(6);

        // Settled but stale: locked with a re-run explanation.
        const stale = renderTransformPage(makeSnapshot({
            derivedStaleness: { transform1: { stale: true, reasons: ['Sources changed'] } },
            task: { passes: { transform1: { status: 'succeeded', items: { 'a.png': makeItem({ status: 'succeeded' }) } } } },
        }));
        const staleContinue = findOne(stale.root, hasClass('bc-task-continue'));
        expect(staleContinue.disabled).toBe(true);
        expect(staleContinue.title).toContain('re-run');

        // Partial counts as settled; running locks it again.
        const running = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { status: 'running' } } },
        }));
        expect(findOne(running.root, hasClass('bc-task-continue')).disabled).toBe(true);
    });

    test('Continue falls back to Review (page 7) when every later page is disabled', () => {
        const pageStates = defaultPageStates().map((state) => state.index > 3 ? { ...state, status: 'disabled' } : state);
        const { root, actions } = renderTransformPage(makeSnapshot({
            pageStates,
            task: { passes: { transform1: { status: 'succeeded', items: { 'a.png': makeItem({ status: 'succeeded' }) } } } },
        }));
        const continueButton = findOne(root, hasClass('bc-task-continue'));
        expect(continueButton.textContent).toBe('Continue to Review');
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        expect(actions.goToPage).toHaveBeenCalledWith(7);
    });

    test('serves the summary pass key (factory parameterization)', async () => {
        const { heading, root, actions } = renderTransformPage(makeSnapshot({
            currentPage: 5,
            task: { passes: { summary: { items: { 'a.png': makeItem({ output: 'SUM' }) } } } },
        }), makeActions(), { passKey: 'summary', title: 'Lorebook Summary' });

        expect(heading.textContent).toBe('Lorebook Summary');
        expect(findOne(root, hasClass('bc-task-transform-output')).value).toBe('SUM');
        findOne(root, hasClass('bc-task-transform-run')).click();
        await flush();
        expect(actions.runPass).toHaveBeenCalledWith('summary', { completionSettings: { model: 'x', stream: false } });
    });

    test('queued/skipped/interrupted item statuses render as their own badges (not pending)', () => {
        const { root } = renderTransformPage(makeSnapshot({
            task: {
                sources: [
                    makeSource(),
                    makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png' }),
                    makeSource({ key: 'c.png', name: 'Carol', avatar: 'c.png' }),
                ],
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ status: 'queued' }),
                            'b.png': makeItem({ status: 'skipped' }),
                            'c.png': makeItem({ status: 'interrupted' }),
                        },
                    },
                },
            },
        }));

        const badges = findAll(root, hasClass('bc-task-status')).map((badge) => badge.textContent);
        expect(badges).toContain('queued');
        expect(badges).toContain('skipped');
        expect(badges).toContain('interrupted');
        expect(badges).not.toContain('pending');
    });

    test('completed tasks render read-only: runs disabled, outputs read-only, Continue stays navigable', () => {
        const { root, actions } = renderTransformPage(makeSnapshot({
            task: {
                status: 'completed',
                passes: { transform1: { status: 'succeeded', items: { 'a.png': makeItem({ status: 'succeeded', output: 'AAA' }) } } },
            },
        }));

        expect(root.textContent).toContain('read-only');
        expect(findOne(root, hasClass('bc-task-transform-run')).disabled).toBe(true);
        expect(findOne(root, hasClass('bc-task-transform-regen-all')).disabled).toBe(true);
        expect(findOne(root, hasClass('bc-task-transform-regen')).disabled).toBe(true);
        expect(findOne(root, hasClass('bc-task-transform-output')).readOnly).toBe(true);
        expect(findOne(root, hasClass('bc-task-transform-hint')).readOnly).toBe(true);

        const continueButton = findOne(root, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        expect(actions.goToPage).toHaveBeenCalled();
    });

    test('re-render is idempotent and dispose clears without throwing', () => {
        const snapshot = makeSnapshot({
            task: {
                passes: {
                    transform1: {
                        items: {
                            'a.png': makeItem({ output: 'AAA' }),
                            'b.png': makeItem({ output: 'BBB' }),
                        },
                    },
                },
            },
        });
        const page = createTransformPage({ passKey: 'transform1', title: 'Transform 1' });
        const actions = makeActions();

        expect(() => {
            page.render(container, snapshot, actions);
            page.render(container, snapshot, actions);
        }).not.toThrow();
        expect(container.children).toHaveLength(1);
        expect(findAll(container, hasClass('bc-task-transform-item'))).toHaveLength(2);
        expect(findAll(container, hasClass('bc-task-transform-output'))).toHaveLength(1);

        page.dispose();
        expect(() => page.render(container, snapshot, actions)).not.toThrow();
        expect(findAll(container, hasClass('bc-task-transform-item'))).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// Structure validation row (TASK #60)
// ---------------------------------------------------------------------------

describe('transformPage structure validation', () => {
    /** @type {object} XML structure fixture (format + minimal template). */
    const XML_STRUCTURE = { format: 'xml', template: [{ id: 'root', name: 'character' }] };

    /**
     * @param {object} [itemOverrides] Pass item overrides.
     * @param {object} [taskOverrides] Extra task overrides.
     * @returns {object} Snapshot with one structured-output transform1 item.
     */
    function structuredSnapshot(itemOverrides = {}, taskOverrides = {}) {
        return makeSnapshot({
            task: {
                structure: XML_STRUCTURE,
                passes: {
                    transform1: {
                        items: { 'a.png': makeItem({ status: 'succeeded', output: 'AAA', ...itemOverrides }) },
                    },
                },
                ...taskOverrides,
            },
        });
    }

    test('hides the validation row when the structure format is none or absent', () => {
        const none = renderTransformPage(makeSnapshot({
            task: {
                structure: { format: 'none', template: [] },
                passes: { transform1: { items: { 'a.png': makeItem({ status: 'succeeded', output: 'AAA' }) } } },
            },
        }));
        expect(findOne(none.root, hasClass('bc-task-transform-validation'))).toBe(null);
        // The character-count row is still there.
        expect(findOne(none.root, hasClass('bc-task-transform-output-count'))).not.toBe(null);

        // Legacy task without a structure record at all.
        const legacy = renderTransformPage(makeSnapshot({
            task: { passes: { transform1: { items: { 'a.png': makeItem({ status: 'succeeded', output: 'AAA' }) } } } },
        }));
        expect(findOne(legacy.root, hasClass('bc-task-transform-validation'))).toBe(null);
    });

    test('shows the uppercased format badge and ✓ Structure valid for a clean succeeded item', () => {
        const { root } = renderTransformPage(structuredSnapshot());
        const block = findOne(root, hasClass('bc-task-transform-validation'));
        expect(block).not.toBe(null);
        expect(hasClass('bc-task-transform-validation--ok')(block)).toBe(true);
        expect(findOne(block, hasClass('bc-task-transform-validation-format')).textContent).toBe('Format: XML');
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('✓ Structure valid');
        expect(findOne(block, hasClass('bc-task-transform-issues'))).toBe(null);

        for (const [format, label] of [['json', 'Format: JSON'], ['toon', 'Format: TOON']]) {
            const variant = renderTransformPage(structuredSnapshot({}, { structure: { format, template: [] } }));
            expect(findOne(variant.root, hasClass('bc-task-transform-validation-format')).textContent).toBe(label);
        }
    });

    test('⚠ N issues lists each issue as "path — message" behind a toggle', () => {
        const { root } = renderTransformPage(structuredSnapshot({
            issues: [
                { path: '/character/style', kind: 'missing', message: 'Missing required element' },
                { path: '/character/summary', kind: 'overlength', message: '812 > 800 characters' },
            ],
        }));

        const block = findOne(root, hasClass('bc-task-transform-validation'));
        expect(hasClass('bc-task-transform-validation--issues')(block)).toBe(true);
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('⚠ 2 issues');

        // Collapsed by default; the toggle expands the list.
        expect(findOne(block, hasClass('bc-task-transform-issues'))).toBe(null);
        const toggle = findOne(block, hasClass('bc-task-transform-issues-toggle'));
        expect(toggle.textContent).toBe('Show issues');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        toggle.click();

        const expandedBlock = findOne(container, hasClass('bc-task-transform-validation'));
        const expandedToggle = findOne(expandedBlock, hasClass('bc-task-transform-issues-toggle'));
        expect(expandedToggle.textContent).toBe('Hide issues');
        expect(expandedToggle.getAttribute('aria-expanded')).toBe('true');
        const entries = findAll(expandedBlock, (element) => element.tagName === 'LI');
        expect(entries).toHaveLength(2);
        expect(entries[0].textContent).toBe('/character/style — Missing required element');
        expect(entries[1].textContent).toBe('/character/summary — 812 > 800 characters');

        // Toggling again collapses the list.
        expandedToggle.click();
        expect(findOne(container, hasClass('bc-task-transform-issues'))).toBe(null);
    });

    test('✗ Unparseable output with the error message for an unparseable failed item', () => {
        const { root } = renderTransformPage(structuredSnapshot({
            status: 'failed',
            error: 'Unparseable toon output: unexpected indent',
        }, { structure: { format: 'toon', template: [] } }));

        const block = findOne(root, hasClass('bc-task-transform-validation'));
        expect(hasClass('bc-task-transform-validation--unparseable')(block)).toBe(true);
        expect(findOne(block, hasClass('bc-task-transform-validation-format')).textContent).toBe('Format: TOON');
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('✗ Unparseable output');
        expect(findOne(block, hasClass('bc-task-transform-validation-detail')).textContent).toBe('Unparseable toon output: unexpected indent');
    });

    test('a generation failure is not mislabeled as unparseable; the normal failed UI stays', () => {
        const { root } = renderTransformPage(structuredSnapshot({ status: 'failed', error: 'rate limited' }));

        const block = findOne(root, hasClass('bc-task-transform-validation'));
        expect(hasClass('bc-task-transform-validation--unparseable')(block)).toBe(false);
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).not.toContain('Unparseable');
        // The existing failed-item error alert is untouched.
        const alert = findOne(root, hasClass('bc-task-transform-error'));
        expect(alert.getAttribute('role')).toBe('alert');
        expect(alert.textContent).toContain('rate limited');
    });

    test('Validate calls actions.validateItem and refreshes the row from the response (no new snapshot needed)', async () => {
        const actions = makeActions();
        actions.validateItem = jest.fn(async () => ({
            ok: true,
            issues: [{ path: '/character/mood', kind: 'unknown', message: 'Unknown element' }],
            status: 'succeeded',
        }));
        const { root } = renderTransformPage(structuredSnapshot(), actions);
        expect(findOne(root, hasClass('bc-task-transform-validation-state')).textContent).toBe('✓ Structure valid');

        findOne(root, hasClass('bc-task-transform-validate')).click();
        await flush();

        expect(actions.validateItem).toHaveBeenCalledTimes(1);
        expect(actions.validateItem).toHaveBeenCalledWith('transform1', 'a.png');

        // The row re-rendered from the RESPONSE (singular "issue") while the
        // snapshot still holds the old clean item.
        const block = findOne(container, hasClass('bc-task-transform-validation'));
        expect(hasClass('bc-task-transform-validation--issues')(block)).toBe(true);
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('⚠ 1 issue');
        // A snapshot refresh was requested so the rest of the page can settle.
        expect(actions.refresh).toHaveBeenCalled();
    });

    test('a Validate response flipping the item to failed shows the unparseable state immediately', async () => {
        const actions = makeActions();
        actions.validateItem = jest.fn(async () => ({ ok: false, issues: [], status: 'failed' }));
        const { root } = renderTransformPage(structuredSnapshot(), actions);

        findOne(root, hasClass('bc-task-transform-validate')).click();
        await flush();

        const block = findOne(container, hasClass('bc-task-transform-validation'));
        expect(hasClass('bc-task-transform-validation--unparseable')(block)).toBe(true);
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('✗ Unparseable output');
    });

    test('a refreshed snapshot takes over from the optimistic result (same state, plus the persisted error)', async () => {
        const actions = makeActions();
        actions.validateItem = jest.fn(async () => ({ ok: false, issues: [], status: 'failed' }));
        const { page, root } = renderTransformPage(structuredSnapshot(), actions);

        findOne(root, hasClass('bc-task-transform-validate')).click();
        await flush();
        expect(findOne(container, hasClass('bc-task-transform-validation-state')).textContent).toBe('✗ Unparseable output');

        // The endpoint persisted the failure; the refreshed snapshot (revision
        // bumped) now drives the row, including the error detail.
        page.render(container, makeSnapshot({
            task: {
                revision: 2,
                structure: XML_STRUCTURE,
                passes: {
                    transform1: {
                        items: { 'a.png': makeItem({ status: 'failed', output: 'AAA', error: 'Unparseable xml output: tag mismatch' }) },
                    },
                },
            },
        }), actions);
        const block = findOne(container, hasClass('bc-task-transform-validation'));
        expect(findOne(block, hasClass('bc-task-transform-validation-state')).textContent).toBe('✗ Unparseable output');
        expect(findOne(block, hasClass('bc-task-transform-validation-detail')).textContent).toBe('Unparseable xml output: tag mismatch');
    });

    test('a failed validate request shows a transient inline error on the row', async () => {
        const actions = makeActions();
        actions.validateItem = jest.fn(async () => {
            throw new Error('{"error":"item_not_found"}');
        });
        const { root } = renderTransformPage(structuredSnapshot(), actions);

        findOne(root, hasClass('bc-task-transform-validate')).click();
        await flush();

        const failure = findOne(container, hasClass('bc-task-transform-validation-request-error'));
        expect(failure).not.toBe(null);
        expect(failure.getAttribute('role')).toBe('alert');
        expect(failure.textContent).toContain('item_not_found');
        // The row stays in its snapshot-derived state and the button recovers.
        expect(findOne(container, hasClass('bc-task-transform-validation-state')).textContent).toBe('✓ Structure valid');
        expect(findOne(container, hasClass('bc-task-transform-validate')).disabled).toBe(false);
    });

    test('Validate is disabled in read-only mode, for empty output, and while validating', async () => {
        // Read-only completed task.
        const readOnly = renderTransformPage(structuredSnapshot({}, {
            status: 'completed',
            passes: {
                transform1: {
                    status: 'succeeded',
                    items: { 'a.png': makeItem({ status: 'succeeded', output: 'AAA' }) },
                },
            },
        }));
        const readOnlyValidate = findOne(readOnly.root, hasClass('bc-task-transform-validate'));
        expect(readOnlyValidate.disabled).toBe(true);
        readOnlyValidate.click();
        expect(readOnly.actions.validateItem).not.toHaveBeenCalled();

        // Empty output: nothing to validate (a validate would flip a pending
        // item to failed server-side).
        const empty = renderTransformPage(structuredSnapshot({ status: 'pending', output: '' }));
        const emptyValidate = findOne(empty.root, hasClass('bc-task-transform-validate'));
        expect(emptyValidate.disabled).toBe(true);
        emptyValidate.click();
        expect(empty.actions.validateItem).not.toHaveBeenCalled();

        // While validating: busy label, disabled, extra clicks are no-ops.
        let resolveValidate;
        const actions = makeActions();
        actions.validateItem = jest.fn(() => new Promise((resolve) => {
            resolveValidate = resolve;
        }));
        const { root } = renderTransformPage(structuredSnapshot(), actions);
        findOne(root, hasClass('bc-task-transform-validate')).click();
        await flush();
        const busy = findOne(container, hasClass('bc-task-transform-validate'));
        expect(busy.disabled).toBe(true);
        expect(busy.textContent).toBe('Validating…');
        busy.click();
        expect(actions.validateItem).toHaveBeenCalledTimes(1);

        resolveValidate({ ok: true, issues: [], status: 'succeeded' });
        await flush();
        expect(findOne(container, hasClass('bc-task-transform-validate')).disabled).toBe(false);
    });

    test('Validate awaits a pending output commit before calling the endpoint (no stale-output race)', async () => {
        let resolveUpdate;
        const actions = makeActions();
        actions.update = jest.fn(() => new Promise((resolve) => {
            resolveUpdate = resolve;
        }));
        const { root } = renderTransformPage(structuredSnapshot(), actions);

        // Commit an output edit: the PATCH is now in flight.
        const output = findOne(root, hasClass('bc-task-transform-output'));
        output.value = 'AAA edited';
        output.fire('change');
        expect(actions.update).toHaveBeenCalledWith({ passes: { transform1: { items: { 'a.png': { output: 'AAA edited' } } } } });

        findOne(container, hasClass('bc-task-transform-validate')).click();
        await flush();
        expect(actions.validateItem).not.toHaveBeenCalled();

        resolveUpdate();
        await flush();
        expect(actions.validateItem).toHaveBeenCalledTimes(1);
        expect(actions.validateItem).toHaveBeenCalledWith('transform1', 'a.png');
    });
});
