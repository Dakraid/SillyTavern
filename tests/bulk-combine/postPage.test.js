'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/pages/postPage.js`.
 *
 * The module is pure (no imports), so the only harness is a minimal fake
 * `document`/element tree — the implementation uses plain DOM APIs only.
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

function makeSnapshot(overrides = {}) {
    const taskDefaults = {
        id: 'task-1',
        name: 'Task',
        revision: 1,
        settings: { postProcessingEnabled: true, postProcessingMode: 'append' },
        prompts: { post: { text: '', assistant: { request: '', proposal: '', diff: '', applied: false, error: '' } } },
        post: { status: 'pending', input: '', output: '', error: '' },
    };
    const t = overrides.task ?? {};
    return {
        derivedStaleness: {},
        pageStates: [],
        currentPage: 6,
        furthestPage: 6,
        conflict: false,
        syncState: 'saved',
        ...overrides,
        task: {
            ...taskDefaults,
            ...t,
            settings: { ...taskDefaults.settings, ...(t.settings ?? {}) },
            prompts: {
                ...taskDefaults.prompts,
                ...(t.prompts ?? {}),
                post: { ...taskDefaults.prompts.post, ...(t.prompts?.post ?? {}) },
            },
            post: { ...taskDefaults.post, ...(t.post ?? {}) },
        },
    };
}

function makeActions() {
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
        getReview: jest.fn(async () => {}),
    };
}

let createPostPage;
let container;

beforeAll(async () => {
    ({ createPostPage } = await import('../../public/scripts/bulk-combine/wizard/pages/postPage.js'));
});

beforeEach(() => {
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    jest.restoreAllMocks();
});

function renderPage(snapshot = makeSnapshot(), actions = makeActions()) {
    const page = createPostPage();
    const heading = page.render(container, snapshot, actions);
    return { page, heading, root: container.children[0], actions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('postPage', () => {
    test('renders heading, guidance, and a pending banner; Continue locked when post is enabled and unsettled', () => {
        const { heading, root } = renderPage();

        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Post Processing');
        expect(heading.tabIndex).toBe(-1);

        const banner = findOne(root, hasClass('bc-task-post-banner'));
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.getAttribute('data-status')).toBe('pending');
        expect(banner.textContent).toContain('not run yet');

        // Workspace is present when post-processing is enabled.
        expect(findOne(root, (e) => e.id === 'bc-task-post-prompt')).not.toBe(null);
        expect(findOne(root, (e) => e.id === 'bc-task-post-mode')).not.toBe(null);

        // Continue is locked until succeeded|skipped.
        const continueButton = findOne(root, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(true);
        expect(continueButton.textContent).toBe('Continue to Review');
    });

    test('disabled post hides the workspace and Run/Skip and always allows Continue', () => {
        const { root, actions } = renderPage(makeSnapshot({ task: { settings: { postProcessingEnabled: false } } }));

        expect(findOne(root, hasClass('bc-task-post-banner')).getAttribute('data-status')).toBe('disabled');
        expect(findOne(root, (e) => e.id === 'bc-task-post-prompt')).toBe(null);
        expect(findOne(root, hasClass('bc-task-post-run'))).toBe(null);
        expect(findOne(root, hasClass('bc-task-post-skip'))).toBe(null);

        const continueButton = findOne(root, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        expect(actions.goToPage).toHaveBeenCalledWith(7);
    });

    test('banner reflects succeeded/failed/skipped statuses', () => {
        const statuses = [
            ['succeeded', 'succeeded'],
            ['failed', 'failed'],
            ['skipped', 'skipped'],
        ];
        for (const [status, dataStatus] of statuses) {
            const { root } = renderPage(makeSnapshot({ task: { post: { status } } }));
            expect(findOne(root, hasClass('bc-task-post-banner')).getAttribute('data-status')).toBe(dataStatus);
        }
    });

    test('failed status surfaces the error text in the banner', () => {
        const { root } = renderPage(makeSnapshot({ task: { post: { status: 'failed', error: 'rate limited' } } }));
        expect(findOne(root, hasClass('bc-task-post-banner')).textContent).toContain('rate limited');
    });

    test('prompt textarea input drafts without patching; change patches the prompt text', () => {
        const { root, actions } = renderPage(makeSnapshot({ task: { prompts: { post: { text: 'original' } } } }));
        const textarea = findOne(root, (e) => e.id === 'bc-task-post-prompt');
        expect(textarea.value).toBe('original');

        // input → draft only, no server write.
        textarea.value = 'new draft';
        textarea.fire('input');
        expect(actions.update).not.toHaveBeenCalled();

        // change → sparse PATCH; draft cleared on success.
        textarea.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ prompts: { post: { text: 'new draft' } } });
    });

    test('the mode select offers only prepend/append; a legacy stored replace resolves to append', () => {
        const { root } = renderPage();
        const select = findOne(root, (e) => e.id === 'bc-task-post-mode');
        expect(select.children.map((option) => option.value)).toEqual(['prepend', 'append']);
        // Fixture default is append.
        expect(select.value).toBe('append');
        // The note explains the append behavior (added around the transform output, never editing it).
        const note = findOne(root, hasClass('bc-task-post-mode-note'));
        expect(note.textContent).toContain('Append');
        expect(note.textContent).toContain('never edited');

        // A legacy stored 'replace' normalizes to 'append' for display.
        const legacy = renderPage(makeSnapshot({ task: { settings: { postProcessingMode: 'replace' } } }));
        expect(findOne(legacy.root, (e) => e.id === 'bc-task-post-mode').value).toBe('append');
        expect(findOne(legacy.root, hasClass('bc-task-post-mode-note')).textContent).toContain('Append');
    });

    test('mode select change patches postProcessingMode and updates the note', () => {
        const { root, actions } = renderPage();
        const select = findOne(root, (e) => e.id === 'bc-task-post-mode');
        select.value = 'prepend';
        select.fire('change');
        expect(actions.update).toHaveBeenCalledWith({ settings: { postProcessingMode: 'prepend' } });
        const note = findOne(root, hasClass('bc-task-post-mode-note'));
        expect(note.textContent).toContain('Prepend');
        expect(note.textContent).toContain('never edited');
    });

    test('Run is disabled without prompt text, enabled with a draft, commits the draft then calls runPostProcess', async () => {
        const page = createPostPage();
        const actions = makeActions();
        page.render(container, makeSnapshot({ task: { prompts: { post: { text: '' } } } }), actions);
        let runButton = findOne(container, hasClass('bc-task-post-run'));
        expect(runButton.disabled).toBe(true); // no text

        // Type a prompt (draft) then re-render: effective text now enables Run.
        const textarea = findOne(container, (e) => e.id === 'bc-task-post-prompt');
        textarea.value = 'clean it up';
        textarea.fire('input');
        page.render(container, makeSnapshot({ task: { prompts: { post: { text: '' } } } }), actions);

        runButton = findOne(container, hasClass('bc-task-post-run'));
        expect(runButton.disabled).toBe(false);
        runButton.click();
        // Draft differs from server ('') → patch first, then run.
        expect(actions.update).toHaveBeenCalledWith({ prompts: { post: { text: 'clean it up' } } });
        await flush();
        expect(actions.runPostProcess).toHaveBeenCalledTimes(1);
    });

    test('Run fires runPostProcess directly when prompt text is already committed', async () => {
        const { root, actions } = renderPage(makeSnapshot({ task: { prompts: { post: { text: 'already here' } } } }));
        // No draft change: effective text equals server text.
        findOne(root, hasClass('bc-task-post-run')).click();
        expect(actions.update).not.toHaveBeenCalled();
        expect(actions.runPostProcess).toHaveBeenCalledTimes(1);
    });

    test('Skip and Unskip toggle post.status between skipped and pending', () => {
        const { root, actions } = renderPage();

        findOne(root, hasClass('bc-task-post-skip')).click();
        expect(actions.update).toHaveBeenCalledWith({ post: { status: 'skipped' } });

        // Re-render with skipped → button relabels to Unskip.
        const { root: root2, actions: actions2 } = renderPage(makeSnapshot({ task: { post: { status: 'skipped' } } }));
        const unskip = findOne(root2, hasClass('bc-task-post-skip'));
        expect(unskip.textContent).toBe('Unskip');
        unskip.click();
        expect(actions2.update).toHaveBeenCalledWith({ post: { status: 'pending' } });
    });

    test('Continue unlocks on succeeded or skipped and navigates to Review (page 7)', () => {
        for (const status of ['succeeded', 'skipped']) {
            const { root, actions } = renderPage(makeSnapshot({ task: { post: { status } } }));
            const continueButton = findOne(root, hasClass('bc-task-continue'));
            expect(continueButton.disabled).toBe(false);
            continueButton.click();
            expect(actions.goToPage).toHaveBeenCalledWith(7);
        }
    });

    test('assist Suggest calls runPromptAssist with the request text', () => {
        const { root, actions } = renderPage();
        const request = findOne(root, hasClass('bc-task-assist-request'));
        request.value = 'make it punchier';
        request.fire('input'); // enables Suggest
        findOne(root, hasClass('bc-task-assist-suggest')).click();
        expect(actions.runPromptAssist).toHaveBeenCalledWith('post', { request: 'make it punchier' });
    });

    test('assist Apply patches the proposal as the prompt text and marks applied; Dismiss clears the assistant', () => {
        // Proposal present, not yet applied.
        const { root, actions } = renderPage(makeSnapshot({
            task: { prompts: { post: { text: 'old', assistant: { proposal: 'better prompt', applied: false } } } },
        }));

        findOne(root, hasClass('bc-task-assist-apply')).click();
        expect(actions.update).toHaveBeenCalledWith({
            prompts: { post: { text: 'better prompt', assistant: expect.objectContaining({ applied: true, proposal: 'better prompt' }) } },
        });

        findOne(root, hasClass('bc-task-assist-dismiss')).click();
        expect(actions.update).toHaveBeenLastCalledWith({
            prompts: { post: { assistant: expect.objectContaining({ request: '', proposal: '', applied: false, error: '' }) } },
        });
    });

    test('assist error is surfaced as an alert', () => {
        const { root } = renderPage(makeSnapshot({
            task: { prompts: { post: { assistant: { error: 'model overloaded' } } } },
        }));
        const error = findOne(root, hasClass('bc-task-assist-error'));
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toContain('model overloaded');
    });

    test('before/after panes show captured input and output on a succeeded run', () => {
        const { root } = renderPage(makeSnapshot({
            task: { post: { status: 'succeeded', input: 'ASSEMBLED', output: 'CLEANED' } },
        }));
        const section = findOne(root, hasClass('bc-task-post-beforeafter'));
        expect(section).not.toBe(null);
        expect(section.textContent).toContain('ASSEMBLED');
        expect(section.textContent).toContain('CLEANED');
    });

    test('stale upstream surfaces a stale note when post succeeded', () => {
        const { root } = renderPage(makeSnapshot({
            task: { post: { status: 'succeeded', output: 'x' }, settings: { postProcessingEnabled: true } },
            derivedStaleness: { transform1: { stale: true } },
        }));
        expect(findOne(root, hasClass('bc-task-post-stale')).textContent).toContain('Upstream results changed');
    });

    test('re-render does not clobber a focused prompt draft and is idempotent', () => {
        const page = createPostPage();
        const actions = makeActions();
        page.render(container, makeSnapshot({ task: { prompts: { post: { text: 'server text' } } } }), actions);
        const textarea = findOne(container, (e) => e.id === 'bc-task-post-prompt');
        textarea.value = 'typing...';
        textarea.fire('input');

        // Re-render with an unchanged server snapshot: the draft wins.
        expect(() => page.render(container, makeSnapshot({ task: { prompts: { post: { text: 'server text' } } } }), actions)).not.toThrow();
        const refreshed = findOne(container, (e) => e.id === 'bc-task-post-prompt');
        expect(refreshed.value).toBe('typing...');

        page.dispose();
        expect(() => page.render(container, makeSnapshot(), actions)).not.toThrow();
    });

    test('an identical rerun clears the running state once the new ranAt lands', async () => {
        const page = createPostPage();
        const actions = makeActions();
        // Previously succeeded run with a captured ranAt.
        const succeeded = {
            status: 'succeeded',
            input: 'IN',
            output: 'OUT',
            error: null,
            ranAt: '2026-01-01T00:00:00.000Z',
        };
        page.render(container, makeSnapshot({
            task: { prompts: { post: { text: 'clean it up' } }, post: succeeded },
        }), actions);

        // Rerun: optimistic running indicator shows.
        findOne(container, hasClass('bc-task-post-run')).click();
        await flush();
        expect(actions.runPostProcess).toHaveBeenCalledTimes(1);
        expect(container.textContent).toContain('Post-processing is running');

        // The rerun settles with an IDENTICAL record except a fresh ranAt.
        page.render(container, makeSnapshot({
            task: {
                prompts: { post: { text: 'clean it up' } },
                post: { ...succeeded, ranAt: '2026-01-01T00:05:00.000Z' },
            },
        }), actions);

        // The optimistic running state cleared (the signature tracks ranAt).
        expect(container.textContent).not.toContain('Post-processing is running');
        expect(findOne(container, hasClass('bc-task-post-run')).disabled).toBe(false);
    });

    test('completed tasks render read-only: Run/Skip/Suggest disabled, Continue stays navigable', () => {
        const { root, actions } = renderPage(makeSnapshot({
            task: {
                status: 'completed',
                prompts: { post: { text: 'clean it up' } },
                post: { status: 'succeeded', output: 'OUT' },
            },
        }));

        expect(root.textContent).toContain('read-only');
        expect(findOne(root, hasClass('bc-task-post-run')).disabled).toBe(true);
        expect(findOne(root, hasClass('bc-task-post-skip')).disabled).toBe(true);
        expect(findOne(container, (e) => e.id === 'bc-task-post-prompt').readOnly).toBe(true);
        expect(findOne(container, (e) => e.id === 'bc-task-post-mode').disabled).toBe(true);

        const continueButton = findOne(root, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        expect(actions.goToPage).toHaveBeenCalledWith(7);
    });
});
