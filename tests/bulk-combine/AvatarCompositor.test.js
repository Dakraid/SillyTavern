'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/components/AvatarCompositor.js`.
 *
 * The compositor is plain DOM (canvas + pointer/keyboard wiring); its
 * geometry lives in the separately tested AvatarCompositorMath.js. The Node
 * test environment has no DOM, so a minimal fake `document`/element tree
 * backs the component (canvas 2D contexts are absent — the compositor
 * guards every painting call). `Image` is faked so load/error timing is
 * test-controlled.
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
        this.width = 0;
        this.height = 0;
        this._text = '';
        this._listeners = new Map();
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

    blur() {
        this.blurred = true;
    }
}

const fakeDocument = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
};

class FakeImage {
    /** @type {FakeImage[]} */
    static instances = [];

    constructor() {
        this.onload = null;
        this.onerror = null;
        this.naturalWidth = 200;
        this.naturalHeight = 300;
        this._src = '';
        FakeImage.instances.push(this);
    }

    set src(value) {
        this._src = value;
    }

    get src() {
        return this._src;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * @param {object} node Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object[]} Matching elements in document order.
 */
function findAll(node, predicate) {
    const matches = [node].filter(predicate);
    for (const child of node.children ?? []) {
        matches.push(...findAll(child, predicate));
    }
    return matches;
}

const hasClass = (className) => (element) => String(element.className ?? '').split(/\s+/).includes(className);

let createAvatarCompositor;
let container;

const originalImage = global.Image;

beforeAll(async () => {
    ({ createAvatarCompositor } = await import('../../public/scripts/bulk-combine/components/AvatarCompositor.js'));
});

beforeEach(() => {
    FakeImage.instances = [];
    fakeDocument.activeElement = null;
    global.document = fakeDocument;
    global.Image = FakeImage;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    global.Image = originalImage;
    jest.restoreAllMocks();
});

/**
 * Builds a two-source compositor and returns the pieces under test.
 *
 * @param {object} [options] Extra factory options.
 * @returns {{compositor: object, canvas: object, status: object, options: object}} Compositor pieces.
 */
function renderCompositor(options = {}) {
    const compositor = createAvatarCompositor({
        container,
        sources: [
            { key: 'a.png', name: 'Alice', avatar: 'a.png' },
            { key: 'b.png', name: 'Bob', avatar: 'b.png' },
        ],
        ...options,
    });
    const canvas = findAll(compositor.root, hasClass('bc-compositor-canvas'))[0];
    const status = findAll(compositor.root, hasClass('bc-compositor-status'))[0];
    return { compositor, canvas, status };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AvatarCompositor', () => {
    test('the canvas is an interactive application with a per-cell accessible name and live region', () => {
        const { canvas, status } = renderCompositor();

        expect(canvas.getAttribute('role')).toBe('application');
        expect(canvas.getAttribute('aria-roledescription')).toBe('avatar editor');
        expect(canvas.tabIndex).toBe(0);
        expect(canvas.getAttribute('aria-label')).toContain('cell 1 of 2: Alice');
        expect(status.getAttribute('aria-live')).toBe('polite');
        expect(status.textContent).toContain('cell 1 of 2: Alice');
    });

    test('Tab / Shift+Tab switch the keyboard-edited cell and announce it', () => {
        const { compositor, canvas, status } = renderCompositor();

        canvas.fire('keydown', { key: 'Tab' });
        expect(canvas.getAttribute('aria-label')).toContain('cell 2 of 2: Bob');
        expect(status.textContent).toContain('cell 2 of 2: Bob');

        // Arrow keys now pan Bob's cell, not Alice's.
        const before = compositor.getOffsets();
        expect(before[1].x).toBe(0);
        canvas.fire('keydown', { key: 'ArrowRight' });
        const after = compositor.getOffsets();
        expect(after[1].x).toBeGreaterThan(before[1].x);
        expect(after[0].x).toBe(before[0].x);

        // Shift+Tab cycles back to Alice (wraps).
        canvas.fire('keydown', { key: 'Tab', shiftKey: true });
        expect(canvas.getAttribute('aria-label')).toContain('cell 1 of 2: Alice');
        canvas.fire('keydown', { key: 'Tab', shiftKey: true });
        expect(canvas.getAttribute('aria-label')).toContain('cell 2 of 2: Bob');
    });

    test('Escape leaves the editor (blur)', () => {
        const { canvas } = renderCompositor();
        canvas.fire('keydown', { key: 'Escape' });
        expect(canvas.blurred).toBe(true);
    });

    test('isReady is false until every image settles; onSettle fires exactly once', async () => {
        const onSettle = jest.fn();
        const { compositor } = renderCompositor({ onSettle });

        expect(FakeImage.instances).toHaveLength(2);
        expect(compositor.isReady()).toBe(false);

        // Microtask settle check: images still pending → not ready.
        await Promise.resolve();
        expect(onSettle).not.toHaveBeenCalled();

        FakeImage.instances[0].onload();
        expect(compositor.isReady()).toBe(false);
        expect(onSettle).not.toHaveBeenCalled();

        FakeImage.instances[1].onerror();
        expect(compositor.isReady()).toBe(true);
        expect(onSettle).toHaveBeenCalledTimes(1);

        // No repeat notifications.
        await Promise.resolve();
        expect(onSettle).toHaveBeenCalledTimes(1);
    });

    test('sources without URLs settle immediately and notify on a microtask', async () => {
        const onSettle = jest.fn();
        createAvatarCompositor({
            container,
            sources: [{ key: 'a.png', name: 'Alice', avatar: '' }],
            onSettle,
        });
        expect(FakeImage.instances).toHaveLength(0);
        await Promise.resolve();
        expect(onSettle).toHaveBeenCalledTimes(1);
    });
});
