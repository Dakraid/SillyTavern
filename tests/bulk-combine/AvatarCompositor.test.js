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

// ---------------------------------------------------------------------------
// Tiling layouts (setLayout)
// ---------------------------------------------------------------------------

/**
 * Builds a compositor over N named sources and returns the pieces under test.
 *
 * @param {number} count Source count.
 * @param {object} [options] Extra factory options.
 * @returns {{compositor: object, canvas: object}} Compositor pieces.
 */
function renderMany(count, options = {}) {
    const sources = Array.from({ length: count }, (_, index) => ({
        key: `${index}.png`,
        name: `Char${index}`,
        avatar: `${index}.png`,
    }));
    const compositor = createAvatarCompositor({ container, sources, ...options });
    const canvas = findAll(compositor.root, hasClass('bc-compositor-canvas'))[0];
    return { compositor, canvas };
}

describe('AvatarCompositor layouts', () => {
    test('the default layout is the classic near-square grid', () => {
        const { compositor } = renderMany(4);
        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(4);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 508, h: 508 }); // 2×2, gap 8
    });

    test('a layout gap wins over the legacy gap option', () => {
        expect(renderMany(2, { gap: 20 }).compositor.getLayoutCells()[0].w).toBe(502);
        expect(renderMany(2, { layout: { method: 'square', gap: 20 } }).compositor.getLayoutCells()[0].w).toBe(502);
        expect(renderMany(2, { gap: 20, layout: { method: 'square', gap: 4 } }).compositor.getLayoutCells()[0].w).toBe(510);
    });

    test('setLayout recomputes the cells, keeps offsets by index, and does not reload images', () => {
        const { compositor } = renderMany(4, { initialOffsets: [{ x: 5, y: -5, scale: 120 }] });
        expect(compositor.getLayoutCells()[0].w).toBe(508); // square 2×2
        const offsetsBefore = compositor.getOffsets();
        const imagesBefore = FakeImage.instances.length;

        compositor.setLayout({ method: 'portrait', aspect: '2:3' });

        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(4);
        expect(cells[0].w).toBe(336); // 3 columns: (1024 − 2·8) / 3
        expect(cells[0].h).toBe(508); // 2 rows: (1024 − 8) / 2
        expect(compositor.getOffsets()).toEqual(offsetsBefore);
        expect(FakeImage.instances.length).toBe(imagesBefore); // no reload
    });

    test('setLayout updates hit-testing to the new cells', () => {
        const { compositor, canvas } = renderMany(4);
        compositor.setLayout({ method: 'portrait', aspect: '2:3' });

        // (700, 10) is inside cell 2 of the 3×2 grid (was cell 1 in 2×2).
        canvas.fire('pointerdown', { clientX: 700, clientY: 10, pointerId: 1 });
        canvas.fire('pointermove', { clientX: 710, clientY: 10, pointerId: 1 });
        const offsets = compositor.getOffsets();
        expect(offsets[2].x).not.toBe(0);
        expect(offsets[1].x).toBe(0);
        canvas.fire('pointerup', { pointerId: 1 });
    });

    test('best-fit falls back to square before settle and recomputes from loaded aspects after', () => {
        const { compositor } = renderMany(2, { layout: { method: 'best-fit' } });
        expect(compositor.getLayoutCells()[0].w).toBe(508); // square 2×1 fallback

        for (const image of FakeImage.instances) {
            image.naturalWidth = 400; // landscape aspect 4.0
            image.naturalHeight = 100;
            image.onload();
        }

        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(2);
        expect(cells[0].w).toBe(1024); // 1 column × 2 rows of landscape cells
        expect(cells[0].h).toBe(508);

        // Re-resolving the same method keeps the fitted cells (no throw, no reload).
        const imagesBefore = FakeImage.instances.length;
        compositor.setLayout({ method: 'best-fit' });
        expect(compositor.getLayoutCells()[0].w).toBe(1024);
        expect(FakeImage.instances.length).toBe(imagesBefore);
    });

    test('best-fit ignores images that failed to load', () => {
        const { compositor } = renderMany(2, { layout: { method: 'best-fit' } });
        FakeImage.instances[0].naturalWidth = 400;
        FakeImage.instances[0].naturalHeight = 100;
        FakeImage.instances[0].onload();
        FakeImage.instances[1].onerror();

        expect(compositor.isReady()).toBe(true);
        expect(compositor.getLayoutCells()[0].w).toBe(1024); // fitted to the one loaded aspect
    });
});

// ---------------------------------------------------------------------------
// Zoom floor (cutoff fix)
// ---------------------------------------------------------------------------

describe('AvatarCompositor zoom floor', () => {
    /**
     * Fires `count` wheel zoom-out steps at the given canvas point.
     *
     * @param {object} canvas Fake canvas element.
     * @param {number} x Canvas X.
     * @param {number} y Canvas Y.
     * @param {number} count Step count.
     */
    function wheelZoomOut(canvas, x, y, count) {
        for (let step = 0; step < count; step++) {
            canvas.fire('wheel', { clientX: x, clientY: y, deltaY: 120 });
        }
    }

    test('a persisted sub-50 scale survives construction (lazy floor normalization)', () => {
        const { compositor } = renderMany(2, { initialOffsets: [{ x: 0, y: 0, scale: 12 }] });
        expect(compositor.getOffsets()[0].scale).toBe(12);
    });

    test('zoom-out stops at the default floor (50) while the image is unloaded', () => {
        const { compositor, canvas } = renderMany(2);
        wheelZoomOut(canvas, 10, 10, 15);
        expect(compositor.getOffsets()[0].scale).toBe(50);
    });

    test('an extreme-aspect image zooms out to its contain fit once loaded', () => {
        const { compositor, canvas } = renderMany(2);
        const image = FakeImage.instances[0];
        image.naturalWidth = 2000; // extreme landscape
        image.naturalHeight = 100;
        image.onload();

        // Cell 0: 508×1024. Contain floor = ceil(100 · (508/2000) / (1024/100)) = 3.
        wheelZoomOut(canvas, 10, 10, 25);
        expect(compositor.getOffsets()[0].scale).toBe(3);
        expect(compositor.getOffsets()[1].scale).toBe(100); // other cell untouched
    });

    test('a square-ish image keeps a floor of 100 for its cell', () => {
        const { compositor, canvas } = renderMany(1);
        const image = FakeImage.instances[0];
        image.naturalWidth = 300;
        image.naturalHeight = 300;
        image.onload();

        canvas.fire('keydown', { key: 'Tab' }); // single-cell editor lets Tab through
        wheelZoomOut(canvas, 10, 10, 15);
        expect(compositor.getOffsets()[0].scale).toBe(100); // contain == cover
    });
});
