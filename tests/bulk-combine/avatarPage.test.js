'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/pages/avatarPage.js`.
 *
 * Module seams are mocked: `AvatarCompositor.js` (no real canvas in Node),
 * `CardCreator.js` (no server), and `script.js` (`getCharacters`). The only
 * other harness is a minimal fake `document`/element tree (mirrors
 * reviewPage.test.js). The review payload arrives via an async
 * `actions.getReview()`, so several tests flush the microtask queue before
 * asserting the settled view.
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

/** @type {jest.Mock} Mocked roster refresh. */
const mockGetCharacters = jest.fn(async () => {});

jest.unstable_mockModule('../../public/script.js', () => ({
    getCharacters: mockGetCharacters,
}));

/** @type {jest.Mock} Mocked task-friendly CardCreator wrapper. */
const mockCreateGroupCardFromTask = jest.fn(async () => ({
    characterName: 'Alice + Bob',
    characterAvatar: 'alice-bob.png',
    lorebookName: '',
    avatarError: '',
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/services/CardCreator.js', () => ({
    createGroupCardFromTask: mockCreateGroupCardFromTask,
}));

/** @type {Array<{options: object, instance: object}>} Recorded compositor constructions. */
const compositorCalls = [];

/** @type {boolean} When true, the mocked compositor factory throws (startup failure). */
let compositorShouldThrow = false;

jest.unstable_mockModule('../../public/scripts/bulk-combine/components/AvatarCompositor.js', () => ({
    createAvatarCompositor: (options) => {
        if (compositorShouldThrow) {
            throw new Error('no canvas');
        }
        const instance = {
            getOffsets: jest.fn(() => [{ x: 1, y: 2, scale: 110 }]),
            getComposedImageDataURL: jest.fn(() => 'data:image/png;base64,COMPOSED'),
            isReady: jest.fn(() => true),
            setLayout: jest.fn(),
            resetCellOffset: jest.fn(),
            resetAllOffsets: jest.fn(),
            dispose: jest.fn(),
        };
        compositorCalls.push({ options, instance });
        return instance;
    },
}));

// ---------------------------------------------------------------------------
// Minimal fake DOM (mirrors reviewPage.test.js)
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

/** Flushes the full promise microtask queue so async work settles. */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSources() {
    return [
        { key: 'alice.png', name: 'Alice', avatar: 'alice.png', fields: { name: 'Alice', description: 'A.' } },
        { key: 'bob.png', name: 'Bob', avatar: 'bob.png', fields: { name: 'Bob', description: 'B.' } },
    ];
}

function makeSnapshot(overrides = {}) {
    const taskDefaults = {
        id: 'task-1',
        name: 'Task',
        revision: 1,
        settings: { destination: 'card' },
        review: {},
        avatar: {},
        artifacts: {},
        sources: makeSources(),
    };
    const t = overrides.task ?? {};
    return {
        derivedStaleness: {},
        pageStates: [],
        currentPage: 8,
        furthestPage: 8,
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

let createAvatarPage;
let container;

beforeAll(async () => {
    ({ createAvatarPage } = await import('../../public/scripts/bulk-combine/wizard/pages/avatarPage.js'));
});

beforeEach(() => {
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
    compositorCalls.length = 0;
    compositorShouldThrow = false;
});

afterEach(() => {
    delete global.document;
    jest.clearAllMocks();
});

/**
 * Renders the page and flushes the async getReview fetch so the payload
 * view is settled. Returns the rendered pieces.
 */
async function renderSettled(snapshot = makeSnapshot(), actions = makeActions()) {
    const page = createAvatarPage();
    const heading = page.render(container, snapshot, actions);
    await flush();
    return { page, heading, root: container.children[0], actions };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('avatarPage', () => {
    test('renders heading, triggers one getReview fetch, and shows loading before settle', () => {
        const actions = makeActions();
        const page = createAvatarPage();
        const heading = page.render(container, makeSnapshot(), actions);

        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Avatar Studio & Create');
        expect(heading.tabIndex).toBe(-1);

        expect(actions.getReview).toHaveBeenCalledTimes(1);

        const loading = findOne(container, hasClass('bc-task-avatar-loading'));
        expect(loading.getAttribute('role')).toBe('status');
        expect(loading.textContent).toContain('Assembling');
    });

    test('after settle, shows the card name, destination, and description the card will get', async () => {
        const { root } = await renderSettled();

        const summary = findOne(root, hasClass('bc-task-avatar-summary'));
        expect(summary).not.toBe(null);
        expect(summary.textContent).toContain('Alice + Bob'); // joined cardBlocks names
        expect(summary.textContent).toContain('Card description');

        const preview = findOne(root, hasClass('bc-task-avatar-description-preview'));
        expect(preview.textContent).toBe('Merged description of both cards.');
    });

    test('task.review edits win over the assembled defaults; lorebook destination lists entry count', async () => {
        const payload = makePayload({
            destination: 'lorebook',
            lorebookData: { entries: { '0': { comment: 'A' }, '1': { comment: 'B' } } },
        });
        const snapshot = makeSnapshot({
            task: {
                settings: { destination: 'lorebook' },
                review: { name: 'My Group', description: 'Edited description.' },
            },
        });
        const { root } = await renderSettled(snapshot, makeActions(payload));

        const summary = findOne(root, hasClass('bc-task-avatar-summary'));
        expect(summary.textContent).toContain('My Group');
        expect(summary.textContent).toContain('Lorebook (2 entries');
        expect(findOne(root, hasClass('bc-task-avatar-description-preview')).textContent).toBe('Edited description.');
    });

    test('hosts the compositor with task sources and persisted offsets; re-renders reuse the instance', async () => {
        const offsets = [{ x: 5, y: -5, scale: 120 }, { x: 0, y: 0, scale: 100 }];
        const snapshot = makeSnapshot({ task: { avatar: { offsets } } });
        const { page, root } = await renderSettled(snapshot, makeActions());

        expect(compositorCalls).toHaveLength(1);
        const [{ options }] = compositorCalls;
        expect(options.sources).toEqual([
            { key: 'alice.png', name: 'Alice', avatar: 'alice.png' },
            { key: 'bob.png', name: 'Bob', avatar: 'bob.png' },
        ]);
        expect(options.initialOffsets).toEqual(offsets);

        const studioHost = findOne(root, hasClass('bc-task-avatar-compositor-host'));
        expect(studioHost).not.toBe(null);

        // Re-render with the same sources: the compositor is NOT rebuilt.
        page.render(container, snapshot, makeActions());
        await flush();
        expect(compositorCalls).toHaveLength(1);
        expect(findOne(container, hasClass('bc-task-avatar-compositor-host'))).not.toBe(null);
    });

    test('compositor onChange persists offsets into task.avatar only when finalized', async () => {
        const actions = makeActions();
        await renderSettled(makeSnapshot(), actions);
        const [{ options }] = compositorCalls;

        const offsets = [{ x: 3, y: 4, scale: 100 }];
        options.onChange(offsets, false); // mid-drag: no PATCH storm
        expect(actions.update).not.toHaveBeenCalled();

        options.onChange(offsets, true); // gesture end: persist
        expect(actions.update).toHaveBeenCalledWith({ avatar: { offsets } });
    });

    test('Create calls the CardCreator wrapper with task + payload + composed avatar, records task.artifacts, and refreshes the roster', async () => {
        const actions = makeActions();
        const snapshot = makeSnapshot();
        const { root } = await renderSettled(snapshot, actions);

        const createButton = findOne(root, hasClass('bc-task-avatar-create-button'));
        expect(createButton.disabled).toBe(false);
        createButton.click();
        await flush();
        await flush();

        expect(mockCreateGroupCardFromTask).toHaveBeenCalledTimes(1);
        const [taskArg, payloadArg, dataUrlArg] = mockCreateGroupCardFromTask.mock.calls[0];
        expect(taskArg).toBe(snapshot.task);
        expect(payloadArg.mergedDescription).toBe('Merged description of both cards.');
        expect(dataUrlArg).toBe('data:image/png;base64,COMPOSED');

        expect(actions.update).toHaveBeenCalledWith({
            artifacts: expect.objectContaining({
                characterName: 'Alice + Bob',
                characterAvatar: 'alice-bob.png',
                lorebookName: '',
            }),
            status: 'completed',
        });
        const completionPatch = actions.update.mock.calls.find((call) => call[0]?.artifacts)?.[0];
        expect(typeof completionPatch.artifacts.createdAt).toBe('string');
        expect(mockGetCharacters).toHaveBeenCalledTimes(1);
    });

    test('after a successful create, the created panel shows and the Create button is gone', async () => {
        const { root } = await renderSettled();
        findOne(root, hasClass('bc-task-avatar-create-button')).click();
        await flush();
        await flush();

        const created = findOne(container, hasClass('bc-task-avatar-created'));
        expect(created).not.toBe(null);
        expect(created.textContent).toContain('Alice + Bob');
        expect(findOne(container, hasClass('bc-task-avatar-create-button'))).toBe(null);
    });

    test('durable task.artifacts render the created state (with lorebook) and no Create button', async () => {
        const snapshot = makeSnapshot({
            task: {
                artifacts: {
                    characterName: 'Group',
                    characterAvatar: 'group.png',
                    lorebookName: 'Group',
                    createdAt: '2026-08-03T12:00:00.000Z',
                },
            },
        });
        const { root } = await renderSettled(snapshot, makeActions(makePayload({ destination: 'lorebook' })));

        const created = findOne(root, hasClass('bc-task-avatar-created'));
        expect(created).not.toBe(null);
        expect(created.textContent).toContain('Group');
        expect(created.textContent).toContain('2026-08-03T12:00:00.000Z');
        expect(findOne(root, hasClass('bc-task-avatar-create-button'))).toBe(null);
        // The page stays inspectable: summary + compositor still render.
        expect(findOne(root, hasClass('bc-task-avatar-summary'))).not.toBe(null);
        expect(findOne(root, hasClass('bc-task-avatar-compositor-host'))).not.toBe(null);
    });

    test('Create failure shows an inline alert and stays retryable', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);

        mockCreateGroupCardFromTask.mockRejectedValueOnce(new Error('server down'));
        findOne(root, hasClass('bc-task-avatar-create-button')).click();
        await flush();
        await flush();

        const errorBox = findOne(container, hasClass('bc-task-avatar-create-error'));
        expect(errorBox.getAttribute('role')).toBe('alert');
        expect(errorBox.textContent).toContain('server down');

        // Retryable: the button is back and enabled.
        const retryButton = findOne(container, hasClass('bc-task-avatar-create-button'));
        expect(retryButton.disabled).toBe(false);
        retryButton.click();
        await flush();
        await flush();
        expect(mockCreateGroupCardFromTask).toHaveBeenCalledTimes(2);
        expect(findOne(container, hasClass('bc-task-avatar-created'))).not.toBe(null);
    });

    test('Create is disabled with an explanation when the assembled name/description is empty', async () => {
        const payload = makePayload({ cardBlocks: [], mergedDescription: '' });
        const { root, actions } = await renderSettled(makeSnapshot(), makeActions(payload));

        const createButton = findOne(root, hasClass('bc-task-avatar-create-button'));
        expect(createButton.disabled).toBe(true);
        expect(createButton.title).toContain('name and a description');
        expect(mockCreateGroupCardFromTask).not.toHaveBeenCalled();
        expect(actions.update).not.toHaveBeenCalled();
    });

    test('Create is disabled when fewer than two sources remain', async () => {
        const snapshot = makeSnapshot({ task: { sources: [makeSources()[0]] } });
        const { root } = await renderSettled(snapshot, makeActions());

        const createButton = findOne(root, hasClass('bc-task-avatar-create-button'));
        expect(createButton.disabled).toBe(true);
        expect(createButton.title).toContain('two source cards');
    });

    test('getReview failure renders an inline error with a Retry that refetches', async () => {
        const actions = {
            ...makeActions(),
            getReview: jest.fn(() => Promise.reject(new Error('server down'))),
        };
        const page = createAvatarPage();
        page.render(container, makeSnapshot(), actions);
        await flush();

        const errorBox = findOne(container, hasClass('bc-task-avatar-error'));
        expect(errorBox.getAttribute('role')).toBe('alert');
        expect(errorBox.textContent).toContain('server down');

        const callsBefore = actions.getReview.mock.calls.length;
        findOne(errorBox, hasClass('bc-task-avatar-retry')).click();
        await flush();
        expect(actions.getReview.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    test('stale upstream renders a warning banner with role=status', async () => {
        const { root } = await renderSettled(
            makeSnapshot({ derivedStaleness: { summary: { stale: true } } }),
        );
        const banner = findOne(root, hasClass('bc-task-avatar-stale'));
        expect(banner.getAttribute('role')).toBe('status');
        expect(banner.textContent).toContain('Upstream results changed');
    });

    test('a compositor that cannot start degrades to a note while Create stays available', async () => {
        compositorShouldThrow = true;
        const page = createAvatarPage();
        const actions = makeActions();

        const heading = page.render(container, makeSnapshot(), actions);
        await flush();
        expect(heading).not.toBe(null);
        expect(container.textContent).toContain('compositor could not start');
        expect(findOne(container, hasClass('bc-task-avatar-create-button')).disabled).toBe(false);
    });

    test('Back to Review navigates to page 7', async () => {
        const { root, actions } = await renderSettled(makeSnapshot());
        findOne(root, hasClass('bc-task-continue')).click();
        expect(actions.goToPage).toHaveBeenCalledWith(7);
    });

    test('dispose tears down the compositor and a later render does not throw', async () => {
        const actions = makeActions();
        const page = createAvatarPage();
        page.render(container, makeSnapshot(), actions);
        await flush();
        const [{ instance }] = compositorCalls;

        page.dispose();
        expect(instance.dispose).toHaveBeenCalledTimes(1);
        expect(() => page.render(container, makeSnapshot(), actions)).not.toThrow();
    });

    test('a revision bump mid-flight refetches for the new revision and discards the stale response', async () => {
        const actions = makeActions();
        let call = 0;
        actions.getReview = jest.fn(() => {
            call++;
            return Promise.resolve(call === 1
                ? makePayload({ mergedDescription: 'STALE PAYLOAD' })
                : makePayload({ mergedDescription: 'FRESH PAYLOAD' }));
        });
        const page = createAvatarPage();
        page.render(container, makeSnapshot({ task: { revision: 1 } }), actions);

        // Before the first fetch settles, advance the revision: a NEW fetch
        // must start even while the old one is in flight (no stuck loading).
        page.render(container, makeSnapshot({ task: { revision: 2 } }), actions);
        expect(actions.getReview).toHaveBeenCalledTimes(2);
        await flush();

        expect(container.textContent).not.toContain('STALE PAYLOAD');
        expect(container.textContent).toContain('FRESH PAYLOAD');
    });

    test('Create is gated until the compositor images settle; onSettle ungates it', async () => {
        /** @type {boolean} */
        let ready = false;
        const actions = makeActions();
        const page = createAvatarPage();
        page.render(container, makeSnapshot(), actions);
        await flush();

        const { options, instance } = compositorCalls.at(-1);
        instance.isReady = jest.fn(() => ready);
        page.render(container, makeSnapshot(), actions);

        let createButton = findOne(container, hasClass('bc-task-avatar-create-button'));
        expect(createButton.disabled).toBe(true);
        expect(createButton.title).toContain('Waiting for avatar images');
        expect(findOne(container, hasClass('bc-task-avatar-waiting'))).not.toBe(null);
        createButton.click();
        await flush();
        expect(mockCreateGroupCardFromTask).not.toHaveBeenCalled();

        // Images settle → the compositor notifies → Create ungates.
        ready = true;
        options.onSettle();
        createButton = findOne(container, hasClass('bc-task-avatar-create-button'));
        expect(createButton.disabled).toBe(false);
        expect(findOne(container, hasClass('bc-task-avatar-waiting'))).toBe(null);
    });

    test('Create re-checks server artifacts first: a recorded create is never redone', async () => {
        const actions = makeActions();
        // The server already recorded artifacts (an earlier create whose
        // PATCH the local snapshot never saw).
        actions.refresh = jest.fn(async () => ({
            ...makeSnapshot().task,
            artifacts: { characterName: 'Alice + Bob', characterAvatar: 'alice-bob.png', createdAt: '2026-01-01T00:00:00.000Z' },
        }));
        const { root } = await renderSettled(makeSnapshot(), actions);

        findOne(root, hasClass('bc-task-avatar-create-button')).click();
        await flush();
        await flush();

        expect(actions.refresh).toHaveBeenCalled();
        expect(mockCreateGroupCardFromTask).not.toHaveBeenCalled();
        expect(actions.update).not.toHaveBeenCalledWith(expect.objectContaining({ artifacts: expect.anything() }));
    });

    test('a failed artifacts patch is retried once so a created card is not silently unrecorded', async () => {
        const actions = makeActions();
        let updateCalls = 0;
        actions.update = jest.fn(async () => {
            updateCalls++;
            if (updateCalls === 1) {
                throw new Error('network gone');
            }
        });
        const { root } = await renderSettled(makeSnapshot(), actions);

        findOne(root, hasClass('bc-task-avatar-create-button')).click();
        await flush();
        await flush();

        expect(mockCreateGroupCardFromTask).toHaveBeenCalledTimes(1);
        const artifactPatches = actions.update.mock.calls
            .map((call) => call[0])
            .filter((patch) => patch?.artifacts);
        expect(artifactPatches).toHaveLength(2);
        expect(artifactPatches[1]).toEqual(artifactPatches[0]);
        expect(findOne(container, hasClass('bc-task-avatar-created'))).not.toBe(null);
    });
});

// ---------------------------------------------------------------------------
// Tiling layout controls
// ---------------------------------------------------------------------------

/** @param {Element} root Root node. @param {string} id Element id. @returns {Element|null} Match. */
function byId(root, id) {
    return findOne(root, (element) => element.id === id);
}

describe('avatarPage tiling controls', () => {
    test('render with defaults: square grid, aspect hidden, compositor default gap, auto columns, ×2 resolution', async () => {
        const { root } = await renderSettled();

        expect(byId(root, 'bc-task-avatar-layout-method').value).toBe('square');
        expect(byId(root, 'bc-task-avatar-layout-aspect').value).toBe('3:4');
        expect(byId(root, 'bc-task-avatar-layout-aspect').parentElement.hidden).toBe(true);
        expect(byId(root, 'bc-task-avatar-layout-gap').value).toBe('8');
        expect(byId(root, 'bc-task-avatar-layout-columns').value).toBe('0');
        expect(byId(root, 'bc-task-avatar-layout-columns').parentElement.hidden).toBeFalsy();
        expect(byId(root, 'bc-task-avatar-layout-resolution').value).toBe('2');

        // The compositor is built with the default layout.
        expect(compositorCalls[0].options.layout).toEqual({ method: 'square', aspect: '3:4', gap: 8, columns: 0, resolution: 2 });
    });

    test('render from the persisted task.avatar.layout (portrait shows the aspect select)', async () => {
        const snapshot = makeSnapshot({ task: { avatar: { layout: { method: 'portrait', aspect: '9:16', gap: 4 } } } });
        const { root } = await renderSettled(snapshot);

        expect(byId(root, 'bc-task-avatar-layout-method').value).toBe('portrait');
        expect(byId(root, 'bc-task-avatar-layout-aspect').value).toBe('9:16');
        expect(byId(root, 'bc-task-avatar-layout-aspect').parentElement.hidden).toBeFalsy();
        expect(byId(root, 'bc-task-avatar-layout-gap').value).toBe('4');

        // The compositor is built with the persisted layout (defaults fill the rest).
        expect(compositorCalls[0].options.layout).toEqual({ method: 'portrait', aspect: '9:16', gap: 4, columns: 0, resolution: 2 });
    });

    test('persisted columns and resolution round-trip into the controls and the compositor', async () => {
        const snapshot = makeSnapshot({ task: { avatar: { layout: { method: 'portrait', aspect: '2:3', gap: 4, columns: 2, resolution: 4 } } } });
        const { root } = await renderSettled(snapshot);

        expect(byId(root, 'bc-task-avatar-layout-columns').value).toBe('2');
        expect(byId(root, 'bc-task-avatar-layout-resolution').value).toBe('4');
        expect(compositorCalls[0].options.layout).toEqual({ method: 'portrait', aspect: '2:3', gap: 4, columns: 2, resolution: 4 });
    });

    test('method change calls setLayout and persists, without rebuilding the compositor', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);
        const [{ instance }] = compositorCalls;

        const methodSelect = byId(root, 'bc-task-avatar-layout-method');
        methodSelect.value = 'portrait';
        methodSelect.fire('change');

        // setLayout gets the cell-relevant subset (NO resolution); the PATCH carries the full record.
        expect(instance.setLayout).toHaveBeenCalledWith({ method: 'portrait', aspect: '3:4', gap: 8, columns: 0 });
        expect(actions.update).toHaveBeenCalledWith({ avatar: { layout: { method: 'portrait', aspect: '3:4', gap: 8, columns: 0, resolution: 2 } } });
        expect(compositorCalls).toHaveLength(1); // no rebuild
        expect(byId(container, 'bc-task-avatar-layout-aspect').parentElement.hidden).toBeFalsy();

        // Switching to best-fit hides the aspect AND columns selects.
        methodSelect.value = 'best-fit';
        methodSelect.fire('change');
        expect(instance.setLayout).toHaveBeenLastCalledWith({ method: 'best-fit', aspect: '3:4', gap: 8, columns: 0 });
        expect(byId(container, 'bc-task-avatar-layout-aspect').parentElement.hidden).toBe(true);
        expect(byId(container, 'bc-task-avatar-layout-columns').parentElement.hidden).toBe(true);
    });

    test('aspect and gap changes commit their own sparse layout patches', async () => {
        const actions = makeActions();
        const snapshot = makeSnapshot({ task: { avatar: { layout: { method: 'portrait', aspect: '3:4', gap: 8 } } } });
        const { root } = await renderSettled(snapshot, actions);
        const [{ instance }] = compositorCalls;

        const aspectSelect = byId(root, 'bc-task-avatar-layout-aspect');
        aspectSelect.value = '2:3';
        aspectSelect.fire('change');
        expect(instance.setLayout).toHaveBeenLastCalledWith({ method: 'portrait', aspect: '2:3', gap: 8, columns: 0 });
        expect(actions.update).toHaveBeenLastCalledWith({ avatar: { layout: { method: 'portrait', aspect: '2:3', gap: 8, columns: 0, resolution: 2 } } });

        const gapInput = byId(root, 'bc-task-avatar-layout-gap');
        gapInput.value = '12';
        gapInput.fire('change');
        expect(instance.setLayout).toHaveBeenLastCalledWith({ method: 'portrait', aspect: '2:3', gap: 12, columns: 0 });
        expect(actions.update).toHaveBeenLastCalledWith({ avatar: { layout: { method: 'portrait', aspect: '2:3', gap: 12, columns: 0, resolution: 2 } } });

        // A garbage gap commits 0 (clamped ≥ 0) and the input reflects it.
        gapInput.value = 'junk';
        gapInput.fire('change');
        expect(instance.setLayout).toHaveBeenLastCalledWith({ method: 'portrait', aspect: '2:3', gap: 0, columns: 0 });
        expect(byId(container, 'bc-task-avatar-layout-gap').value).toBe('0');
    });

    test('columns select offers Auto + 1..sources.length and commits explicit columns', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);
        const [{ instance }] = compositorCalls;

        const columnsSelect = byId(root, 'bc-task-avatar-layout-columns');
        expect(columnsSelect.parentElement.hidden).toBeFalsy(); // square: visible
        expect(columnsSelect.children.map((child) => child.value)).toEqual(['0', '1', '2']);
        expect(columnsSelect.children[0].textContent).toBe('Auto');

        columnsSelect.value = '2';
        columnsSelect.fire('change');
        expect(instance.setLayout).toHaveBeenLastCalledWith({ method: 'square', aspect: '3:4', gap: 8, columns: 2 });
        expect(actions.update).toHaveBeenLastCalledWith({ avatar: { layout: { method: 'square', aspect: '3:4', gap: 8, columns: 2, resolution: 2 } } });

        // Portrait keeps the columns select visible.
        const methodSelect = byId(container, 'bc-task-avatar-layout-method');
        methodSelect.value = 'portrait';
        methodSelect.fire('change');
        expect(byId(container, 'bc-task-avatar-layout-columns').parentElement.hidden).toBeFalsy();
    });

    test('resolution select commits only the patch — setLayout never receives the resolution', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);
        const [{ instance }] = compositorCalls;

        const resolutionSelect = byId(root, 'bc-task-avatar-layout-resolution');
        expect(resolutionSelect.children.map((child) => child.textContent)).toEqual(['512×768', '1024×1536', '2048×3072']);
        expect(resolutionSelect.value).toBe('2');

        instance.setLayout.mockClear();
        resolutionSelect.value = '4';
        resolutionSelect.fire('change');

        expect(actions.update).toHaveBeenLastCalledWith({ avatar: { layout: { method: 'square', aspect: '3:4', gap: 8, columns: 0, resolution: 4 } } });
        expect(instance.setLayout).toHaveBeenCalledTimes(1); // same commit flow…
        const setLayoutArg = instance.setLayout.mock.calls[0][0];
        expect(setLayoutArg).toEqual({ method: 'square', aspect: '3:4', gap: 8, columns: 0 });
        expect('resolution' in setLayoutArg).toBe(false); // …but the preview stays 1024×1536
    });

    test('Create exports the composed avatar at the committed resolution', async () => {
        const actions = makeActions();
        const { root } = await renderSettled(makeSnapshot(), actions);
        const [{ instance }] = compositorCalls;

        const resolutionSelect = byId(root, 'bc-task-avatar-layout-resolution');
        resolutionSelect.value = '4';
        resolutionSelect.fire('change');

        findOne(root, hasClass('bc-task-avatar-create-button')).click();
        await flush();
        await flush();

        expect(instance.getComposedImageDataURL).toHaveBeenCalledWith(4);
        expect(mockCreateGroupCardFromTask).toHaveBeenCalledTimes(1);
    });

    test('the reset buttons call the compositor reset APIs', async () => {
        const { root } = await renderSettled(makeSnapshot());
        const [{ instance }] = compositorCalls;

        const buttons = findAll(root, hasClass('bc-task-avatar-layout-reset'));
        expect(buttons).toHaveLength(2);
        const [resetCurrent, resetAll] = buttons;
        expect(resetCurrent.textContent).toBe('Reset current image');
        expect(resetAll.textContent).toBe('Reset all images');
        expect(resetCurrent.disabled).toBe(false);
        expect(resetAll.disabled).toBe(false);

        resetCurrent.click();
        expect(instance.resetCellOffset).toHaveBeenCalledTimes(1);
        expect(instance.resetAllOffsets).not.toHaveBeenCalled();

        resetAll.click();
        expect(instance.resetAllOffsets).toHaveBeenCalledTimes(1);
        expect(instance.resetCellOffset).toHaveBeenCalledTimes(1);
    });

    test('the reset buttons are disabled when the compositor could not start', async () => {
        compositorShouldThrow = true;
        const { root } = await renderSettled(makeSnapshot());

        expect(compositorCalls).toHaveLength(0); // the factory threw before recording
        const buttons = findAll(root, hasClass('bc-task-avatar-layout-reset'));
        expect(buttons).toHaveLength(2);
        expect(buttons[0].disabled).toBe(true);
        expect(buttons[1].disabled).toBe(true);
    });

    test('a committed layout survives re-renders while the snapshot is still stale', async () => {
        const actions = makeActions();
        const snapshot = makeSnapshot(); // avatar.layout: {}
        const { page, root } = await renderSettled(snapshot, actions);

        const methodSelect = byId(root, 'bc-task-avatar-layout-method');
        methodSelect.value = 'portrait';
        methodSelect.fire('change');

        // Re-render with the SAME (stale) snapshot: the draft wins, the
        // compositor is not rebuilt, and the controls keep the choice.
        page.render(container, snapshot, actions);
        await flush();
        expect(compositorCalls).toHaveLength(1);
        expect(byId(container, 'bc-task-avatar-layout-method').value).toBe('portrait');
        expect(byId(container, 'bc-task-avatar-layout-aspect').parentElement.hidden).toBeFalsy();
    });

    test('the draft clears once the persisted layout catches up', async () => {
        const actions = makeActions();
        const { page, root } = await renderSettled(makeSnapshot(), actions);

        const methodSelect = byId(root, 'bc-task-avatar-layout-method');
        methodSelect.value = 'best-fit';
        methodSelect.fire('change');

        // The server round-tripped: the snapshot now carries the committed layout.
        const updated = makeSnapshot({ task: { avatar: { layout: { method: 'best-fit', aspect: '3:4', gap: 8 } } } });
        page.render(container, updated, actions);
        await flush();
        expect(byId(container, 'bc-task-avatar-layout-method').value).toBe('best-fit');

        // A later render for an unrelated reason does not resurrect the draft.
        page.render(container, updated, actions);
        await flush();
        expect(byId(container, 'bc-task-avatar-layout-method').value).toBe('best-fit');
        expect(compositorCalls).toHaveLength(1);
    });
});
