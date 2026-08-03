'use strict';

/**
 * @file Native plain-DOM avatar compositor for the guided task wizard.
 *
 * Composes the task's source avatars into a single square group avatar,
 * entirely client-side on a `<canvas>`: near-square grid layout
 * ({@link computeGridCells}), cover-fit per cell, per-cell drag (pan),
 * wheel/pinch (zoom), and keyboard pan/zoom for accessibility. All geometry
 * lives in the pure, Node-testable `AvatarCompositorMath.js`; this module
 * keeps only the canvas and pointer wiring.
 *
 * No jQuery, no legacy `WizardState`, no legacy `AvatarEditor` lineage.
 * Plain DOM only: `container.replaceChildren`, `el.addEventListener`.
 *
 * Factory API:
 *
 *   createAvatarCompositor({
 *       container,                 // Element to mount into (required)
 *       sources,                   // [{ key?, name?, avatar? }] — avatar is
 *                                  // the character avatar file reference
 *       initialOffsets,            // optional [{ x, y, scale }] (normalized)
 *       outputSize,                // square output px (default 1024)
 *       gap,                       // cell gap px at output resolution
 *       resolveSourceUrl,          // (source) => image URL; defaults to the
 *                                  // full `/characters/<avatar>` image
 *       onChange,                  // (offsets, finalized) => void — fired on
 *                                  // every mutation; `finalized` is true on
 *                                  // gesture end / discrete changes only
 *   }) → {
 *       root,                      // the mounted root element
 *       getOffsets(),              // normalized per-source offsets (copies)
 *       getComposedImageDataURL(size?),
 *                                  // square PNG data URL, or null when no
 *                                  // source image is available / canvas is
 *                                  // unsupported
 *       isReady(),                 // every source image settled (load|error)
 *       dispose(),                 // idempotent teardown
 *   }
 *
 * Images load asynchronously; the preview redraws as each arrives. Cells
 * whose image failed (or has no avatar ref) render as an empty themed cell.
 */

import {
    COMPOSITOR_DEFAULT_GAP,
    COMPOSITOR_DEFAULT_OUTPUT_SIZE,
    COMPOSITOR_WHEEL_ZOOM_STEP,
    computeCellCoverDraw,
    computeGridCells,
    hitTestCell,
    normalizeCompositorOffsets,
    panCompositorOffset,
    pinchCompositorScale,
    zoomCompositorOffset,
} from './AvatarCompositorMath.js';

/**
 * Keyboard pan step, in percent of the cell dimension per key press.
 *
 * @type {number}
 */
const KEYBOARD_PAN_STEP = 2;

/**
 * Default image URL resolver: the full character avatar image (same-origin,
 * so the canvas stays untainted and `toDataURL` keeps working).
 *
 * @param {object} source Source record (`{ avatar }`).
 * @returns {string} Image URL, or empty when the source has no avatar.
 */
function defaultResolveSourceUrl(source) {
    const avatar = String(source?.avatar ?? '').trim();
    return avatar ? `/characters/${encodeURIComponent(avatar)}` : '';
}

/**
 * Reads a SmartTheme CSS variable for canvas painting (canvas cannot use
 * CSS variables directly), with a fallback when the value is unavailable
 * (non-browser environment, empty variable).
 *
 * @param {Element} element Element whose computed style carries the variable.
 * @param {string} variable CSS custom property name.
 * @param {string} fallback Fallback color.
 * @returns {string} Resolved color.
 */
function themePaint(element, variable, fallback) {
    try {
        const value = globalThis.getComputedStyle?.(element)?.getPropertyValue?.(variable)?.trim();
        return value || fallback;
    } catch {
        return fallback;
    }
}

/**
 * Creates the native avatar compositor. See the file header for the full
 * factory contract.
 *
 * @param {object} options Factory options.
 * @returns {{root: Element, getOffsets: () => Array<object>, getComposedImageDataURL: (size?: number) => string|null, isReady: () => boolean, dispose: () => void}} Compositor instance.
 */
export function createAvatarCompositor(options = {}) {
    const container = options.container;
    if (!container || typeof container.replaceChildren !== 'function') {
        throw new Error('createAvatarCompositor requires a container element.');
    }

    const sources = (Array.isArray(options.sources) ? options.sources : [])
        .map((source) => ({
            key: String(source?.key ?? ''),
            name: String(source?.name ?? ''),
            avatar: String(source?.avatar ?? ''),
        }));
    const resolveSourceUrl = typeof options.resolveSourceUrl === 'function'
        ? options.resolveSourceUrl
        : defaultResolveSourceUrl;
    const onChange = typeof options.onChange === 'function' ? options.onChange : null;
    const outputSize = Number.isFinite(Number(options.outputSize)) && Number(options.outputSize) > 0
        ? Math.round(Number(options.outputSize))
        : COMPOSITOR_DEFAULT_OUTPUT_SIZE;
    const gap = Number.isFinite(Number(options.gap)) && Number(options.gap) >= 0
        ? Number(options.gap)
        : COMPOSITOR_DEFAULT_GAP;

    /** @type {Array<{x: number, y: number, scale: number}>} Working offsets. */
    let offsets = normalizeCompositorOffsets(options.initialOffsets, sources.length);
    /** @type {boolean} Whether dispose() ran (idempotent; kills all work). */
    let disposed = false;
    /** @type {number} Keyboard-focused cell index. */
    let activeCellIndex = sources.length > 0 ? 0 : -1;
    /** @type {Map<number, {x: number, y: number}>} Active pointer positions (canvas coords). */
    const pointers = new Map();
    /** @type {{index: number, startX: number, startY: number, startOffset: object}|null} Drag state. */
    let dragState = null;
    /** @type {{index: number, startDistance: number, startScale: number}|null} Pinch state. */
    let pinchState = null;

    const abort = new AbortController();
    const { signal } = abort;

    // --- DOM ---------------------------------------------------------------

    const root = document.createElement('div');
    root.className = 'bc-compositor';

    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'bc-compositor-canvas-wrap';

    const canvas = document.createElement('canvas');
    canvas.className = 'bc-compositor-canvas';
    canvas.width = outputSize;
    canvas.height = outputSize;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
        'aria-label',
        'Group avatar preview. Click a cell, then drag to pan or scroll to zoom. Arrow keys pan the focused cell; plus and minus zoom it.',
    );

    const hint = document.createElement('p');
    hint.className = 'bc-compositor-hint';
    hint.textContent = 'Drag a cell to pan · scroll or pinch to zoom · arrow keys / + − adjust the focused cell.';

    canvasWrap.append(canvas);
    root.append(canvasWrap, hint);
    container.replaceChildren(root);

    // --- Images --------------------------------------------------------------

    /** @type {Array<{source: object, url: string, image: object|null, loaded: boolean, failed: boolean}>} */
    const cells = sources.map((source) => {
        const entry = { source, url: '', image: null, loaded: false, failed: false };
        try {
            entry.url = String(resolveSourceUrl(source) ?? '');
        } catch (error) {
            console.warn('AvatarCompositor: source URL resolution failed.', error);
            entry.url = '';
        }
        if (!entry.url || typeof Image !== 'function') {
            entry.failed = entry.url !== '';
            return entry;
        }
        const image = new Image();
        entry.image = image;
        image.onload = () => {
            if (disposed) {
                return;
            }
            entry.loaded = true;
            redraw();
        };
        image.onerror = () => {
            if (disposed) {
                return;
            }
            entry.failed = true;
            redraw();
        };
        image.src = entry.url;
        return entry;
    });

    // --- Painting ------------------------------------------------------------

    const gridCells = computeGridCells(sources.length, outputSize, gap);

    /**
     * Paints one cell onto a 2D context at the given geometry scale.
     *
     * @param {CanvasRenderingContext2D} ctx Target context.
     * @param {number} index Cell index.
     * @param {{x: number, y: number, w: number, h: number}} cell Cell rect.
     * @returns {void}
     */
    function paintCell(ctx, index, cell) {
        const entry = cells[index];
        ctx.save();
        ctx.beginPath();
        ctx.rect(cell.x, cell.y, cell.w, cell.h);
        ctx.clip();

        const draw = entry?.loaded && entry.image
            ? computeCellCoverDraw(cell, entry.image.naturalWidth, entry.image.naturalHeight, offsets[index])
            : null;
        if (draw) {
            ctx.drawImage(entry.image, draw.dx, draw.dy, draw.dw, draw.dh);
        } else {
            // Empty / failed cell: themed placeholder fill.
            ctx.fillStyle = themePaint(canvas, '--SmartThemeBlurTintColor', 'rgba(128, 128, 128, 0.25)');
            ctx.fillRect(cell.x, cell.y, cell.w, cell.h);
            const initial = String(entry?.source?.name ?? '').trim().charAt(0);
            if (initial && typeof ctx.fillText === 'function') {
                ctx.fillStyle = themePaint(canvas, '--SmartThemeBodyColor', 'rgba(128, 128, 128, 0.8)');
                ctx.font = `${Math.round(cell.h / 3)}px sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(initial, cell.x + cell.w / 2, cell.y + cell.h / 2);
            }
        }
        ctx.restore();
    }

    /**
     * Paints the full composite onto a 2D context for the given cell layout.
     *
     * @param {CanvasRenderingContext2D} ctx Target context.
     * @param {Array<{x: number, y: number, w: number, h: number}>} layout Cell rects.
     * @param {boolean} highlightActive Whether to outline the active cell.
     * @returns {void}
     */
    function paintComposite(ctx, layout, highlightActive) {
        for (const [index, cell] of layout.entries()) {
            paintCell(ctx, index, cell);
        }
        if (highlightActive && activeCellIndex >= 0 && layout[activeCellIndex]) {
            const cell = layout[activeCellIndex];
            ctx.save();
            ctx.strokeStyle = themePaint(canvas, '--SmartThemeQuoteColor', '#6aa9ff');
            ctx.lineWidth = Math.max(2, Math.round(outputSize / 256));
            ctx.strokeRect(cell.x + 1, cell.y + 1, cell.w - 2, cell.h - 2);
            ctx.restore();
        }
    }

    /**
     * Redraws the live preview canvas. No-op when the 2D context is
     * unavailable (e.g. light DOM fakes in tests).
     *
     * @returns {void}
     */
    function redraw() {
        const ctx = getContext();
        if (!ctx) {
            return;
        }
        ctx.clearRect(0, 0, outputSize, outputSize);
        paintComposite(ctx, gridCells, true);
    }

    /**
     * Returns the preview canvas 2D context, or null when unsupported.
     *
     * @returns {CanvasRenderingContext2D|null} 2D context.
     */
    function getContext() {
        try {
            return canvas.getContext?.('2d') ?? null;
        } catch {
            return null;
        }
    }

    // --- Interaction -----------------------------------------------------------

    /**
     * Converts a client-space event position to canvas coordinates.
     *
     * @param {number} clientX Client X.
     * @param {number} clientY Client Y.
     * @returns {{x: number, y: number}} Canvas coordinates.
     */
    function toCanvasCoords(clientX, clientY) {
        const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: outputSize, height: outputSize };
        const scaleX = rect.width > 0 ? outputSize / rect.width : 1;
        const scaleY = rect.height > 0 ? outputSize / rect.height : 1;
        return {
            x: (Number(clientX) - rect.left) * scaleX,
            y: (Number(clientY) - rect.top) * scaleY,
        };
    }

    /**
     * Sets a cell's offset, repaints, and notifies.
     *
     * @param {number} index Cell index.
     * @param {object} offset New offset.
     * @param {boolean} finalized Whether the gesture is complete.
     * @returns {void}
     */
    function setCellOffset(index, offset, finalized) {
        if (disposed || index < 0 || index >= offsets.length) {
            return;
        }
        offsets[index] = { x: offset.x, y: offset.y, scale: offset.scale };
        redraw();
        onChange?.(getOffsets(), finalized);
    }

    /**
     * Returns the current pinch distance between the two active pointers.
     *
     * @returns {number} Distance in canvas coordinates (0 when unavailable).
     */
    function currentPinchDistance() {
        const points = [...pointers.values()];
        if (points.length < 2) {
            return 0;
        }
        return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
    }

    canvas.addEventListener('pointerdown', (event) => {
        if (disposed) {
            return;
        }
        const point = toCanvasCoords(event.clientX, event.clientY);
        pointers.set(event.pointerId ?? 0, point);
        const index = hitTestCell(gridCells, point.x, point.y);

        if (pointers.size === 2) {
            // Second finger: switch the drag into a pinch on the active cell.
            const pinchIndex = index >= 0 ? index : activeCellIndex;
            if (pinchIndex >= 0) {
                activeCellIndex = pinchIndex;
                dragState = null;
                pinchState = {
                    index: pinchIndex,
                    startDistance: currentPinchDistance(),
                    startScale: offsets[pinchIndex].scale,
                };
            }
        } else if (index >= 0) {
            activeCellIndex = index;
            dragState = {
                index,
                startX: point.x,
                startY: point.y,
                startOffset: { ...offsets[index] },
            };
        }
        redraw();
        try {
            canvas.setPointerCapture?.(event.pointerId);
        } catch {
            // Capture is best-effort (unsupported in test DOMs).
        }
        event.preventDefault?.();
    }, { signal });

    canvas.addEventListener('pointermove', (event) => {
        if (disposed || !pointers.has(event.pointerId ?? 0)) {
            return;
        }
        const point = toCanvasCoords(event.clientX, event.clientY);
        pointers.set(event.pointerId ?? 0, point);

        if (pinchState && pointers.size >= 2) {
            const scale = pinchCompositorScale(pinchState.startScale, pinchState.startDistance, currentPinchDistance());
            setCellOffset(pinchState.index, { ...offsets[pinchState.index], scale }, false);
            event.preventDefault?.();
            return;
        }
        if (dragState) {
            const cell = gridCells[dragState.index];
            if (cell) {
                const deltaXPercent = ((point.x - dragState.startX) / cell.w) * 100;
                const deltaYPercent = ((point.y - dragState.startY) / cell.h) * 100;
                setCellOffset(dragState.index, panCompositorOffset(dragState.startOffset, deltaXPercent, deltaYPercent), false);
            }
            event.preventDefault?.();
        }
    }, { signal });

    /**
     * Ends a pointer's participation: finishes the drag/pinch gesture when
     * no pointers remain, or demotes a pinch back to a drag for the
     * remaining pointer.
     *
     * @param {Event} event Pointer event.
     * @returns {void}
     */
    function endPointer(event) {
        const id = event.pointerId ?? 0;
        const wasTracked = pointers.delete(id);
        if (!wasTracked) {
            return;
        }
        if (pointers.size === 0) {
            const finalized = dragState !== null || pinchState !== null;
            dragState = null;
            pinchState = null;
            if (finalized) {
                redraw();
                onChange?.(getOffsets(), true);
            }
        } else if (pointers.size === 1 && pinchState) {
            // One finger lifted mid-pinch: keep panning with the other.
            const [remaining] = pointers.values();
            const index = pinchState.index;
            pinchState = null;
            dragState = {
                index,
                startX: remaining.x,
                startY: remaining.y,
                startOffset: { ...offsets[index] },
            };
        }
    }

    canvas.addEventListener('pointerup', endPointer, { signal });
    canvas.addEventListener('pointercancel', endPointer, { signal });

    canvas.addEventListener('wheel', (event) => {
        if (disposed) {
            return;
        }
        event.preventDefault?.();
        const point = toCanvasCoords(event.clientX, event.clientY);
        const index = hitTestCell(gridCells, point.x, point.y);
        if (index < 0) {
            return;
        }
        activeCellIndex = index;
        const delta = Number(event.deltaY) > 0 ? -COMPOSITOR_WHEEL_ZOOM_STEP : COMPOSITOR_WHEEL_ZOOM_STEP;
        setCellOffset(index, zoomCompositorOffset(offsets[index], delta), true);
    }, { passive: false, signal });

    canvas.addEventListener('keydown', (event) => {
        if (disposed || activeCellIndex < 0 || activeCellIndex >= offsets.length) {
            return;
        }
        const key = String(event.key ?? '');
        const panDeltas = {
            ArrowLeft: [-KEYBOARD_PAN_STEP, 0],
            ArrowRight: [KEYBOARD_PAN_STEP, 0],
            ArrowUp: [0, -KEYBOARD_PAN_STEP],
            ArrowDown: [0, KEYBOARD_PAN_STEP],
        };
        if (key in panDeltas) {
            event.preventDefault?.();
            const [dx, dy] = panDeltas[key];
            setCellOffset(activeCellIndex, panCompositorOffset(offsets[activeCellIndex], dx, dy), true);
            return;
        }
        if (key === '+' || key === '=' || key === '-' || key === '_') {
            event.preventDefault?.();
            const delta = (key === '+' || key === '=') ? COMPOSITOR_WHEEL_ZOOM_STEP : -COMPOSITOR_WHEEL_ZOOM_STEP;
            setCellOffset(activeCellIndex, zoomCompositorOffset(offsets[activeCellIndex], delta), true);
        }
    }, { signal });

    // --- Instance --------------------------------------------------------------

    /**
     * Returns a copy of the current per-source offsets.
     *
     * @returns {Array<{x: number, y: number, scale: number}>} Offsets.
     */
    function getOffsets() {
        return offsets.map((offset) => ({ x: offset.x, y: offset.y, scale: offset.scale }));
    }

    /**
     * Composes the current offsets into a square PNG data URL. Resolution-
     * independent: the grid and offsets are recomputed at the requested
     * size. Returns null when no source image is available, when the canvas
     * is unsupported, or when encoding fails (e.g. a tainted canvas).
     *
     * @param {number} [size] Square output size (defaults to outputSize).
     * @returns {string|null} PNG data URL, or null.
     */
    function getComposedImageDataURL(size) {
        if (disposed || !cells.some((entry) => entry.loaded)) {
            return null;
        }
        const targetSize = Number.isFinite(Number(size)) && Number(size) > 0
            ? Math.round(Number(size))
            : outputSize;
        try {
            const offscreen = document.createElement('canvas');
            offscreen.width = targetSize;
            offscreen.height = targetSize;
            const ctx = offscreen.getContext?.('2d');
            if (!ctx) {
                return null;
            }
            const scaledGap = gap * (targetSize / outputSize);
            paintComposite(ctx, computeGridCells(sources.length, targetSize, scaledGap), false);
            return offscreen.toDataURL('image/png');
        } catch (error) {
            console.error('AvatarCompositor: failed to compose the avatar image.', error);
            return null;
        }
    }

    /**
     * Whether every source image has settled (loaded or failed).
     *
     * @returns {boolean} True when no image load is pending.
     */
    function isReady() {
        return cells.every((entry) => entry.loaded || entry.failed || !entry.url);
    }

    /**
     * Tears down listeners and releases references. Idempotent.
     *
     * @returns {void}
     */
    function dispose() {
        if (disposed) {
            return;
        }
        disposed = true;
        abort.abort();
        pointers.clear();
        dragState = null;
        pinchState = null;
        for (const entry of cells) {
            if (entry.image) {
                entry.image.onload = null;
                entry.image.onerror = null;
            }
            entry.image = null;
        }
        offsets = [];
    }

    redraw();

    return { root, getOffsets, getComposedImageDataURL, isReady, dispose };
}
