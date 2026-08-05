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

class FakeCanvasContext {
    constructor() {
        this.fillStyle = '';
        this.strokeStyle = '';
        this.lineWidth = 0;
        this.font = '';
        this.textAlign = '';
        this.textBaseline = '';
    }

    clearRect() { /* no-op */ }
    save() { /* no-op */ }
    restore() { /* no-op */ }
    beginPath() { /* no-op */ }
    rect() { /* no-op */ }
    clip() { /* no-op */ }
    fillRect() { /* no-op */ }
    strokeRect() { /* no-op */ }
    fillText() { /* no-op */ }
    drawImage() { /* no-op */ }
}

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
        this.style = {};
        this._text = '';
        this._listeners = new Map();
        this._context = null;
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

    /**
     * Returns a fake 2D context (the compositor guards non-canvas
     * environments, so tests can exercise painting too).
     *
     * @param {string} kind Context kind.
     * @returns {FakeCanvasContext|null} Fake context.
     */
    getContext(kind) {
        if (kind !== '2d') {
            return null;
        }
        if (!this._context) {
            this._context = new FakeCanvasContext();
        }
        return this._context;
    }

    /**
     * @returns {string} Fake PNG data URL.
     */
    toDataURL() {
        return 'data:image/png;base64,FAKE';
    }
}

const fakeDocument = {
    activeElement: null,
    /** @type {FakeElement[]} Every element created (for offscreen-canvas assertions). */
    createdElements: [],
    createElement: (tag) => {
        const element = new FakeElement(tag);
        fakeDocument.createdElements.push(element);
        return element;
    },
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
    fakeDocument.createdElements = [];
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
    test('the default layout is a square-ish grid on the 1024×1536 portrait canvas', () => {
        const { compositor } = renderMany(4);
        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(4);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 508, h: 764 }); // 2×2, gap 8
    });

    test('a layout gap wins over the legacy gap option', () => {
        // 2 sources stack full-width (1×2): the gap only splits the height.
        expect(renderMany(2, { gap: 20 }).compositor.getLayoutCells()[0].h).toBe(758);
        expect(renderMany(2, { layout: { method: 'square', gap: 20 } }).compositor.getLayoutCells()[0].h).toBe(758);
        expect(renderMany(2, { gap: 20, layout: { method: 'square', gap: 4 } }).compositor.getLayoutCells()[0].h).toBe(766);
    });

    test('setLayout recomputes the cells, keeps offsets by index, and does not reload images', () => {
        const { compositor } = renderMany(4, { initialOffsets: [{ x: 5, y: -5, scale: 120 }] });
        expect(compositor.getLayoutCells()[0].w).toBe(508); // square-ish 2×2
        const offsetsBefore = compositor.getOffsets();
        const imagesBefore = FakeImage.instances.length;

        compositor.setLayout({ method: 'portrait', aspect: '2:3' });

        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(4);
        expect(cells[0].w).toBe(508); // 2 columns: (1024 − 8) / 2
        expect(cells[0].h).toBe(764); // 2 rows: (1536 − 8) / 2 — exact 2:3 cells
        expect(compositor.getOffsets()).toEqual(offsetsBefore);
        expect(FakeImage.instances.length).toBe(imagesBefore); // no reload
    });

    test('setLayout updates hit-testing to the new cells', () => {
        const { compositor, canvas } = renderMany(4);
        compositor.setLayout({ method: 'portrait', aspect: '2:3' });

        // (700, 10) is inside cell 1 (top-right of the 2×2 grid).
        canvas.fire('pointerdown', { clientX: 700, clientY: 10, pointerId: 1 });
        canvas.fire('pointermove', { clientX: 710, clientY: 10, pointerId: 1 });
        const offsets = compositor.getOffsets();
        expect(offsets[1].x).not.toBe(0);
        expect(offsets[0].x).toBe(0);
        expect(offsets[2].x).toBe(0);
        canvas.fire('pointerup', { pointerId: 1 });
    });

    test('best-fit falls back to the square target before settle and recomputes from loaded aspects after', () => {
        const { compositor } = renderMany(2, { layout: { method: 'best-fit' } });
        expect(compositor.getLayoutCells()[0]).toEqual({ x: 0, y: 0, w: 1024, h: 764 }); // square-target 1×2 fallback

        for (const image of FakeImage.instances) {
            image.naturalWidth = 400; // landscape aspect 4.0
            image.naturalHeight = 100;
            image.onload();
        }

        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(2);
        expect(cells[0].w).toBe(1024); // 1 column × 2 rows of landscape-ish cells
        expect(cells[0].h).toBe(764);

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

    test('explicit columns skip the shape search', () => {
        const { compositor } = renderMany(4, { layout: { method: 'square', columns: 4 } });
        const cells = compositor.getLayoutCells();
        expect(cells).toHaveLength(4);
        expect(cells[0].w).toBe(250); // 4 columns: (1024 − 3·8) / 4
        expect(cells[0].h).toBe(1536); // 1 row

        compositor.setLayout({ method: 'square', columns: 1 });
        expect(compositor.getLayoutCells()[0].w).toBe(1024);
        expect(compositor.getLayoutCells()[0].h).toBe(378); // 4 rows: (1536 − 3·8) / 4
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

        // Cell 0: 1024×764 (1×2 stack). Contain floor = ceil(100 · (1024/2000) / (764/100)) = 7.
        wheelZoomOut(canvas, 10, 10, 25);
        expect(compositor.getOffsets()[0].scale).toBe(7);
        expect(compositor.getOffsets()[1].scale).toBe(100); // other cell untouched
    });

    test('an image matching the 2:3 cell aspect keeps a floor of 100', () => {
        const { compositor, canvas } = renderMany(1);
        const image = FakeImage.instances[0];
        image.naturalWidth = 200; // 2:3 — matches the 1024×1536 single cell
        image.naturalHeight = 300;
        image.onload();

        canvas.fire('keydown', { key: 'Tab' }); // single-cell editor lets Tab through
        wheelZoomOut(canvas, 10, 10, 15);
        expect(compositor.getOffsets()[0].scale).toBe(100); // contain == cover
    });

    test('a square image in the 2:3 cell zooms out to its 67% contain fit', () => {
        const { compositor, canvas } = renderMany(1);
        const image = FakeImage.instances[0];
        image.naturalWidth = 300;
        image.naturalHeight = 300;
        image.onload();

        // Cell: 1024×1536. Contain floor = ceil(100 · (1024/300) / (1536/300)) = 67.
        canvas.fire('keydown', { key: 'Tab' }); // single-cell editor lets Tab through
        wheelZoomOut(canvas, 10, 10, 15);
        expect(compositor.getOffsets()[0].scale).toBe(67);
    });
});

// ---------------------------------------------------------------------------
// Output dimensions (2:3 portrait canvas)
// ---------------------------------------------------------------------------

describe('AvatarCompositor output dimensions', () => {
    test('defaults to the 1024×1536 portrait canvas with a matching wrap aspect', () => {
        const { compositor, canvas } = renderMany(2);
        expect(canvas.width).toBe(1024);
        expect(canvas.height).toBe(1536);
        const wrap = findAll(compositor.root, hasClass('bc-compositor-canvas-wrap'))[0];
        expect(wrap.style.aspectRatio).toBe('1024 / 1536');
    });

    test('explicit outputWidth/outputHeight set the canvas dims per axis', () => {
        const { compositor, canvas } = renderMany(2, { outputWidth: 800, outputHeight: 1200 });
        expect(canvas.width).toBe(800);
        expect(canvas.height).toBe(1200);
        const wrap = findAll(compositor.root, hasClass('bc-compositor-canvas-wrap'))[0];
        expect(wrap.style.aspectRatio).toBe('800 / 1200');
    });

    test('the legacy outputSize fills any axis outputWidth/Height leave unset (square back-compat)', () => {
        const { canvas: square } = renderMany(2, { outputSize: 640 });
        expect(square.width).toBe(640);
        expect(square.height).toBe(640);

        const { canvas: mixed } = renderMany(2, { outputWidth: 800, outputSize: 640 });
        expect(mixed.width).toBe(800);
        expect(mixed.height).toBe(640);
    });
});

// ---------------------------------------------------------------------------
// Export resolution
// ---------------------------------------------------------------------------

describe('AvatarCompositor export resolution', () => {
    /** Loads every faked source image. */
    function loadAll() {
        for (const image of FakeImage.instances) {
            image.onload();
        }
    }

    /** @returns {object} The most recently created canvas element (the offscreen export canvas). */
    function lastCanvas() {
        return fakeDocument.createdElements.filter((element) => element.tagName === 'CANVAS').at(-1);
    }

    /** @returns {number[]} `[width, height]` of the last export canvas. */
    function lastExportDims() {
        const canvas = lastCanvas();
        return [canvas.width, canvas.height];
    }

    test('the default export is ×2 — the internal 1024×1536', () => {
        const { compositor } = renderMany(2);
        loadAll();
        expect(compositor.getComposedImageDataURL()).toBe('data:image/png;base64,FAKE');
        expect(lastExportDims()).toEqual([1024, 1536]);
    });

    test('explicit scales export 512×768 (×1) and 2048×3072 (×4)', () => {
        const { compositor } = renderMany(2);
        loadAll();
        compositor.getComposedImageDataURL(1);
        expect(lastExportDims()).toEqual([512, 768]);
        compositor.getComposedImageDataURL(4);
        expect(lastExportDims()).toEqual([2048, 3072]);
    });

    test('the layout resolution supplies the default export scale', () => {
        const { compositor } = renderMany(2, { layout: { method: 'square', resolution: 4 } });
        loadAll();
        compositor.getComposedImageDataURL();
        expect(lastExportDims()).toEqual([2048, 3072]);

        const one = renderMany(2, { layout: { method: 'square', resolution: 1 } });
        for (const image of FakeImage.instances.slice(2)) {
            image.onload();
        }
        one.compositor.getComposedImageDataURL();
        expect(lastExportDims()).toEqual([512, 768]);
    });

    test('a legacy square compositor exports at its output size by default (back-compat)', () => {
        const { compositor } = renderMany(2, { outputSize: 640 });
        loadAll();
        compositor.getComposedImageDataURL();
        expect(lastExportDims()).toEqual([640, 640]);
    });

    test('returns null before any source image has loaded', () => {
        const { compositor } = renderMany(2);
        expect(compositor.getComposedImageDataURL()).toBe(null);
    });
});

// ---------------------------------------------------------------------------
// Resets
// ---------------------------------------------------------------------------

describe('AvatarCompositor resets', () => {
    test('resetCellOffset resets the ACTIVE cell only and fires one finalized change', () => {
        const onChange = jest.fn();
        const { compositor, canvas } = renderMany(2, { onChange });

        canvas.fire('keydown', { key: 'ArrowRight' }); // cell 0 (initially active)
        canvas.fire('keydown', { key: 'Tab' }); // → cell 1
        canvas.fire('keydown', { key: 'ArrowDown' });
        expect(compositor.getOffsets()[0].x).toBeGreaterThan(0);
        expect(compositor.getOffsets()[1].y).toBeGreaterThan(0);
        onChange.mockClear();

        compositor.resetCellOffset();
        const offsets = compositor.getOffsets();
        expect(offsets[1]).toEqual({ x: 0, y: 0, scale: 100 });
        expect(offsets[0].x).toBeGreaterThan(0); // other cell untouched
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0][1]).toEqual({ x: 0, y: 0, scale: 100 });
        expect(onChange.mock.calls[0][1]).toBe(true);
    });

    test('resetAllOffsets resets every cell and fires one finalized change', () => {
        const onChange = jest.fn();
        const { compositor, canvas } = renderMany(2, { onChange });

        canvas.fire('keydown', { key: 'ArrowRight' });
        canvas.fire('keydown', { key: 'Tab' });
        canvas.fire('keydown', { key: 'ArrowDown' });
        onChange.mockClear();

        compositor.resetAllOffsets();
        expect(compositor.getOffsets()).toEqual([
            { x: 0, y: 0, scale: 100 },
            { x: 0, y: 0, scale: 100 },
        ]);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][0]).toEqual([
            { x: 0, y: 0, scale: 100 },
            { x: 0, y: 0, scale: 100 },
        ]);
        expect(onChange.mock.calls[0][1]).toBe(true);
    });

    test('keyboard 0 resets the active cell (finalized)', () => {
        const onChange = jest.fn();
        const { compositor, canvas } = renderMany(2, { onChange });

        canvas.fire('keydown', { key: 'Tab' }); // → cell 1
        canvas.fire('keydown', { key: 'ArrowRight' });
        expect(compositor.getOffsets()[1].x).toBeGreaterThan(0);
        onChange.mockClear();

        canvas.fire('keydown', { key: '0' });
        expect(compositor.getOffsets()[1]).toEqual({ x: 0, y: 0, scale: 100 });
        expect(compositor.getOffsets()[0]).toEqual({ x: 0, y: 0, scale: 100 }); // was never moved
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange.mock.calls[0][1]).toBe(true);
    });

    test('resets are no-ops after dispose', () => {
        const onChange = jest.fn();
        const { compositor, canvas } = renderMany(2, { onChange });
        canvas.fire('keydown', { key: 'ArrowRight' });
        compositor.dispose();
        onChange.mockClear();
        compositor.resetCellOffset();
        compositor.resetAllOffsets();
        expect(onChange).not.toHaveBeenCalled();
    });

    test('the hint and the accessible name mention the reset shortcut', () => {
        const { compositor, canvas } = renderMany(2);
        const hint = findAll(compositor.root, hasClass('bc-compositor-hint'))[0];
        expect(hint.textContent).toContain('0 resets');
        expect(canvas.getAttribute('aria-label')).toContain('0 resets');
    });
});
