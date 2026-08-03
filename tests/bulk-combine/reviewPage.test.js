'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/pages/reviewPage.js`.
 *
 * The module is pure (no imports); the only harness is a minimal fake
 * `document`/element tree. The review payload arrives via an async
 * `actions.getReview()` whose resolution drives a re-render, so several
 * tests flush the microtask queue before asserting the settled view.
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

    // Real DOM: a text node set via textContent coexists with later-appended
    // children, so the getter concatenates both (not one-or-the-other).
    get textContent() {
        return this._text + this.children.map((child) => child.textContent).join('');
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

function hasRole(role) {
    return (element) => typeof element.getAttribute === 'function' && element.getAttribute('role') === role;
}

/** Flushes the full promise microtask queue so async getReview settles. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSnapshot(overrides = {}) {
    const taskDefaults = {
        id: 'task-1',
        name: 'Task',
        revision: 1,
        settings: {},
        review: {},
    };
    const t = overrides.task ?? {};
    return {
        derivedStaleness: {},
        pageStates: [],
        currentPage: 7,
        furthestPage: 7,
        conflict: false,
        syncState: 'saved',
        ...overrides,
        task: { ...taskDefaults, ...t },
    };
}

function makePayload(overrides = {}) {
    return {
        destination: 'card',
        cardBlocks: [{ name: 'Alice' }, { name: 'Bob' }],
        mergedDescription: 'Merged description of both cards.',
        post: { enabled: false, output: '' },
        lorebookData: { entries: {} },
        ...overrides,
    };
}

function makeActions(payload = makePayload()) {
    return {
        update: jest.fn(async () => {}),
        refresh: jest.fn(async () => {}),
        goToPage: jest.fn(),
        navigate: jest.fn(),
        runPass: jest.fn(async () => {}),
        resumePass: jest.fn(async () => {}),
        cancel: jest.fn(async () => {}),
        runPostProcess: jest.fn(async () => {}),
        runPromptAssist: jest.fn(async () => {}),
        getReview: jest.fn(() => Promise.resolve(payload)),
    };
}

let createReviewPage;
let container;

beforeAll(async () => {
    ({ createReviewPage } = await import('../../public/scripts/bulk-combine/wizard/pages/reviewPage.js'));
});

beforeEach(() => {
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    jest.restoreAllMocks();
});

/**
 * Renders the page and flushes the async getReview fetch so the payload
 * view is settled. Returns the rendered pieces.
 */
async function renderSettled(snapshot = makeSnapshot(), actions = makeActions()) {
    const page = createReviewPage();
    const heading = page.render(container, snapshot, actions);
    await flush();
    return { page, heading, root: container.children[0], actions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reviewPage', () => {
    test('renders heading, triggers one getReview fetch, and shows loading before settle', () => {
        const actions = makeActions();
        const page = createReviewPage();
        const heading = page.render(container, makeSnapshot(), actions);

        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Review');
        expect(heading.tabIndex).toBe(-1);

        // First render kicks off exactly one fetch (dedupe guard).
        expect(actions.getReview).toHaveBeenCalledTimes(1);

        // Before settle: loading indicator with role=status.
        const loading = findOne(container, hasClass('bc-task-review-loading'));
        expect(loading.getAttribute('role')).toBe('status');
        expect(loading.textContent).toContain('Assembling');
    });

    test('after settle, shows the editable card with the assembled name and description defaults', async () => {
        const payload = makePayload({ mergedDescription: 'The merged text.' });
        const { root } = await renderSettled(makeSnapshot(), makeActions(payload));

        const cardSection = findOne(root, hasClass('bc-task-review-card'));
        expect(cardSection).not.toBe(null);

        const nameField = findOne(cardSection, (e) => e.id === 'bc-task-review-name');
        expect(nameField.value).toBe('Alice + Bob'); // joined cardBlocks names

        const descriptionField = findOne(cardSection, (e) => e.id === 'bc-task-review-description');
        expect(descriptionField.value).toBe('The merged text.');
    });

    test('uses the post-processed output as the description default when post is enabled and produced text', async () => {
        const payload = makePayload({ post: { enabled: true, output: 'CLEANED OUTPUT' }, mergedDescription: 'merged' });
        const { root } = await renderSettled(makeSnapshot(), makeActions(payload));
        expect(findOne(root, (e) => e.id === 'bc-task-review-description').value).toBe('CLEANED OUTPUT');
    });

    test('persisted task.review edits override the assembled defaults; drafts win while editing', async () => {
        const payload = makePayload({ mergedDescription: 'assembled' });
        const { root, actions } = await renderSettled(
            makeSnapshot({ task: { review: { name: 'My Override Name' } } }),
            makeActions(payload),
        );

        expect(findOne(root, (e) => e.id === 'bc-task-review-name').value).toBe('My Override Name');

        // Editing the description: input drafts only, change PATCHes task.review.
        const descriptionField = findOne(root, (e) => e.id === 'bc-task-review-description');
        descriptionField.value = 'edited body';
        descriptionField.fire('input');
        expect(actions.update).not.toHaveBeenCalled();
        descriptionField.fire('change');
        expect(actions.update).toHaveBeenCalledWith({ review: { description: 'edited body' } });
    });

    test('destination defaults to the payload; lorebook tab lists sorted entries', async () => {
        const entries = {
            '1': { comment: 'Second', key: ['b'], content: 'B content', order: 100, displayIndex: 2, uid: 1 },
            '0': { comment: 'First', key: ['a'], content: 'A content', order: 100, displayIndex: 1, uid: 0 },
        };
        const payload = makePayload({ destination: 'lorebook', lorebookData: { entries } });
        const { root } = await renderSettled(makeSnapshot(), makeActions(payload));

        // Lorebook tab is the active destination.
        const lorebookTab = findAll(root, hasRole('tab')).find((tab) => tab.textContent.includes('Lorebook'));
        expect(lorebookTab.getAttribute('aria-selected')).toBe('true');

        const entryArticles = findAll(root, hasClass('bc-task-review-entry'));
        expect(entryArticles).toHaveLength(2);
        // Sorted by displayIndex ascending.
        expect(entryArticles[0].textContent).toContain('First');
        expect(entryArticles[1].textContent).toContain('Second');
    });

    test('switching to the Card tab shows the description preview', async () => {
        const payload = makePayload({ destination: 'lorebook', mergedDescription: 'PREVIEW TEXT' });
        const { root } = await renderSettled(makeSnapshot(), makeActions(payload));

        const cardTab = findAll(root, hasRole('tab')).find((tab) => tab.textContent.includes('Card'));
        cardTab.click();

        const preview = findOne(container, hasClass('bc-task-review-card-preview'));
        expect(preview.textContent).toBe('PREVIEW TEXT');
    });

    test('stale upstream renders a warning banner with role=status', async () => {
        const { root } = await renderSettled(
            makeSnapshot({ derivedStaleness: { transform1: { stale: true } } }),
        );
        const banner = findOne(root, hasClass('bc-task-review-stale'));
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.textContent).toContain('Upstream results changed');
    });

    test('getReview failure renders an inline error with a Retry that refetches', async () => {
        const actions = {
            ...makeActions(),
            getReview: jest.fn(() => Promise.reject(new Error('server down'))),
        };
        const page = createReviewPage();
        page.render(container, makeSnapshot(), actions);
        await flush();

        const errorBox = findOne(container, hasClass('bc-task-review-error'));
        expect(errorBox.getAttribute('role')).toBe('alert');
        expect(errorBox.textContent).toContain('server down');

        const callsBefore = actions.getReview.mock.calls.length;
        findOne(errorBox, hasClass('bc-task-review-retry')).click();
        await flush();
        expect(actions.getReview.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    test('Refresh forces a refetch at the current revision', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);
        const callsBefore = actions.getReview.mock.calls.length;

        findOne(root, hasClass('bc-task-review-refresh')).click();
        await flush();
        expect(actions.getReview.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    test('a settled revision does not refetch on re-render; a new revision does', async () => {
        const actions = makeActions();
        const page = createReviewPage();
        page.render(container, makeSnapshot({ task: { revision: 5 } }), actions);
        await flush();
        expect(actions.getReview.mock.calls.length).toBe(1);

        // Same revision: cache hit, no new fetch.
        page.render(container, makeSnapshot({ task: { revision: 5 } }), actions);
        await flush();
        expect(actions.getReview.mock.calls.length).toBe(1);

        // New revision: refetch.
        page.render(container, makeSnapshot({ task: { revision: 6 } }), actions);
        await flush();
        expect(actions.getReview.mock.calls.length).toBe(2);
    });

    test('a stale fetch response (revision moved on) is discarded and not rendered', async () => {
        const actions = makeActions(makePayload({ mergedDescription: 'STALE PAYLOAD' }));
        const page = createReviewPage();
        page.render(container, makeSnapshot({ task: { revision: 1 } }), actions);

        // Before the fetch settles, advance the revision.
        page.render(container, makeSnapshot({ task: { revision: 2 } }), actions);
        await flush();

        // The revision-1 response is discarded; the tree reflects revision-2's fetch.
        expect(container.textContent).not.toContain('STALE PAYLOAD');
    });

    test('Continue navigates to the Avatar Studio (page 8)', async () => {
        const { root, actions } = await renderSettled(makeSnapshot());
        findOne(root, hasClass('bc-task-continue')).click();
        expect(actions.goToPage).toHaveBeenCalledWith(8);
    });

    test('dispose clears state and a later render does not throw', async () => {
        const page = createReviewPage();
        const actions = makeActions();
        page.render(container, makeSnapshot(), actions);
        await flush();
        page.dispose();
        expect(() => page.render(container, makeSnapshot(), actions)).not.toThrow();
    });
});
