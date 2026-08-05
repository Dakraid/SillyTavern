'use strict';

/**
 * @file Native plain-DOM avatar compositor for the guided task wizard.
 *
 * Composes the task's source avatars into a single 2:3 portrait group
 * avatar (the character-card shape), entirely client-side on a `<canvas>`:
 * grid layout ({@link computeLayoutCells}), cover-fit per cell, per-cell
 * drag (pan), wheel/pinch (zoom), and keyboard pan/zoom/reset for
 * accessibility. All geometry lives in the pure, Node-testable
 * `AvatarCompositorMath.js`; this module keeps only the canvas and pointer
 * wiring.
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
 *       outputWidth, outputHeight, // output px (defaults 1024×1536, a 2:3
 *                                  // portrait canvas)
 *       outputSize,                // legacy square output px — sets BOTH
 *                                  // dims when outputWidth/Height are absent
 *       gap,                       // cell gap px at output resolution
 *                                  // (fallback; a valid layout.gap wins)
 *       layout,                    // optional { method, gap, aspect,
 *                                  // columns, resolution } — 'square'
 *                                  // (default) | 'portrait' | 'best-fit';
 *                                  // aspect is the portrait cell ratio
 *                                  // ('2:3'|'3:4'|'9:16'); columns 0 = auto;
 *                                  // resolution (1|2|4) is the default
 *                                  // export scale
 *       resolveSourceUrl,          // (source) => image URL; defaults to the
 *                                  // full `/characters/<avatar>` image
 *       onChange,                  // (offsets, finalized) => void — fired on
 *                                  // every mutation; `finalized` is true on
 *                                  // gesture end / discrete changes only
 *       onSettle,                  // () => void — fired once when every
 *                                  // source image has settled (load|error)
 *   }) → {
 *       root,                      // the mounted root element
 *       getOffsets(),              // normalized per-source offsets (copies)
 *       setLayout(layout),         // swap the tiling layout: recomputes the
 *                                  // cells, redraws, re-hit-tests; offsets
 *                                  // are kept by index, images are NOT
 *                                  // reloaded
 *       getLayoutCells(),          // current cell rectangles (copies)
 *       getComposedImageDataURL(scale?),
 *                                  // PNG data URL composed with the CURRENT
 *                                  // layout at (outputWidth/2)·scale ×
 *                                  // (outputHeight/2)·scale px (default
 *                                  // scale: layout.resolution, i.e. ×2 →
 *                                  // the output dims), or null when no
 *                                  // source image is available / canvas is
 *                                  // unsupported
 *       resetCellOffset(),         // reset the ACTIVE cell to
 *                                  // {x:0,y:0,scale:100}, redraw, fire
 *                                  // onChange(offsets, true)
 *       resetAllOffsets(),         // reset EVERY cell likewise (one
 *                                  // finalized onChange)
 *       isReady(),                 // every source image settled (load|error)
 *       dispose(),                 // idempotent teardown
 *   }
 *
 * Images load asynchronously; the preview redraws as each arrives. Cells
 * whose image failed (or has no avatar ref) render as an empty themed cell.
 * The themed placeholder fill is painted behind EVERY cell, so letterboxed
 * areas (zoomed out to the contain fit) are never transparent.
 *
 * Zoom floor: the per-cell contain-fit scale (computeCellMinScale), not
 * the fixed COMPOSITOR_SCALE_MIN — extreme-aspect images can always be
 * zoomed out until fully visible. Persisted offsets are normalized lazily
 * per cell at draw/interaction time, so a persisted sub-50 scale survives
 * the round-trip through construction.
 *
 * 'best-fit' layouts resolve from the LOADED image aspects: before every
 * image settles the cells fall back to the square grid; once settled they
 * recompute (a later setLayout with the same method re-resolves against
 * the current aspects).
 *
 * Accessibility: the canvas is an interactive editor (`role="application"`)
 * with full keyboard control — Tab / Shift+Tab switch the edited cell,
 * arrow keys pan it, +/- zoom it, 0 resets it, Escape leaves the editor.
 * The active cell is announced via a visually-hidden live region.
 */

import {
    COMPOSITOR_DEFAULT_GAP,
    COMPOSITOR_DEFAULT_OUTPUT_HEIGHT,
    COMPOSITOR_DEFAULT_OUTPUT_WIDTH,
    COMPOSITOR_DEFAULT_RESOLUTION,
    COMPOSITOR_SCALE_MIN,
    COMPOSITOR_WHEEL_ZOOM_STEP,
    computeCellCoverDraw,
    computeCellMinScale,
    computeLayoutCells,
    hitTestCell,
    normalizeCompositorLayout,
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
 * @returns {{root: Element, getOffsets: () => Array<object>, setLayout: (layout: object) => void, getLayoutCells: () => Array<object>, getComposedImageDataURL: (scale?: number) => string|null, resetCellOffset: () => void, resetAllOffsets: () => void, isReady: () => boolean, dispose: () => void}} Compositor instance.
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
    const onSettle = typeof options.onSettle === 'function' ? options.onSettle : null;
    // Output dims: explicit outputWidth/outputHeight win per axis; the
    // legacy square `outputSize` fills any axis they leave unset.
    const explicitWidth = Number(options.outputWidth);
    const explicitHeight = Number(options.outputHeight);
    const legacySize = Number(options.outputSize);
    const hasLegacySize = Number.isFinite(legacySize) && legacySize > 0;
    const outputWidth = Number.isFinite(explicitWidth) && explicitWidth > 0
        ? Math.round(explicitWidth)
        : hasLegacySize ? Math.round(legacySize) : COMPOSITOR_DEFAULT_OUTPUT_WIDTH;
    const outputHeight = Number.isFinite(explicitHeight) && explicitHeight > 0
        ? Math.round(explicitHeight)
        : hasLegacySize ? Math.round(legacySize) : COMPOSITOR_DEFAULT_OUTPUT_HEIGHT;
    /** @type {{method: string, aspect: string, columns: number, resolution: number, gap?: number}} Current tiling layout. */
    let layout = normalizeCompositorLayout(options.layout);
    /** @type {number} Current cell gap (layout.gap wins over the legacy gap option). */
    let gap = Number.isFinite(Number(layout.gap)) && Number(layout.gap) >= 0
        ? Number(layout.gap)
        : Number.isFinite(Number(options.gap)) && Number(options.gap) >= 0
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
    canvasWrap.style.aspectRatio = `${outputWidth} / ${outputHeight}`;

    const canvas = document.createElement('canvas');
    canvas.className = 'bc-compositor-canvas';
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('aria-roledescription', 'avatar editor');

    const hint = document.createElement('p');
    hint.className = 'bc-compositor-hint';
    hint.textContent = 'Drag a cell to pan · scroll or pinch to zoom · Tab switches cell · arrow keys / + − adjust the current cell · 0 resets it · Escape leaves the editor.';

    // Visually-hidden live region announcing the active cell.
    const status = document.createElement('p');
    status.className = 'bc-compositor-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    canvasWrap.append(canvas);
    root.append(canvasWrap, hint, status);
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
            refreshSettledLayout();
            redraw();
            notifySettleIfReady();
        };
        image.onerror = () => {
            if (disposed) {
                return;
            }
            entry.failed = true;
            refreshSettledLayout();
            redraw();
            notifySettleIfReady();
        };
        image.src = entry.url;
        return entry;
    });

    /** @type {boolean} Whether onSettle already fired (fires exactly once). */
    let settleNotified = false;

    /**
     * Fires `onSettle` once every source image has settled (load|error) —
     * the page uses it to ungate image-dependent actions.
     *
     * @returns {void}
     */
    function notifySettleIfReady() {
        if (!settleNotified && !disposed && isReady()) {
            settleNotified = true;
            try {
                onSettle?.();
            } catch (error) {
                console.error('AvatarCompositor: onSettle callback failed.', error);
            }
        }
    }

    // Everything settled synchronously (no URLs / no Image constructor):
    // notify on a microtask so callers finish wiring first.
    Promise.resolve().then(notifySettleIfReady);

    // --- Accessibility ------------------------------------------------------------

    /**
     * Human description of the active cell (`cell 2 of 4: Bob`).
     *
     * @returns {string} Description.
     */
    function describeActiveCell() {
        const total = sources.length;
        if (activeCellIndex < 0 || total === 0) {
            return 'no cells';
        }
        const name = String(sources[activeCellIndex]?.name ?? '').trim() || `cell ${activeCellIndex + 1}`;
        return `cell ${activeCellIndex + 1} of ${total}: ${name}`;
    }

    /**
     * Syncs the canvas accessible name and the live region with the active
     * cell (keyboard users need to know which cell arrow keys will move).
     *
     * @returns {void}
     */
    function updateAria() {
        canvas.setAttribute(
            'aria-label',
            `Group avatar editor, ${describeActiveCell()}. Drag to pan; scroll or pinch to zoom. Arrow keys pan the current cell; plus and minus zoom it; 0 resets it; Tab and Shift Tab switch cells; Escape leaves the editor.`,
        );
        status.textContent = `Editing ${describeActiveCell()}.`;
    }

    /**
     * Selects the active cell (pointer/keyboard), keeping the highlight and
     * the accessible description in sync.
     *
     * @param {number} index Cell index.
     * @returns {void}
     */
    function setActiveCell(index) {
        if (index < 0 || index >= sources.length || index === activeCellIndex) {
            return;
        }
        activeCellIndex = index;
        updateAria();
    }

    updateAria();

    // --- Painting ------------------------------------------------------------

    /**
     * Computes the cell rectangles for the current layout. 'best-fit'
     * resolves against the LOADED image aspects (square fallback until
     * usable aspects exist).
     *
     * @returns {Array<{x: number, y: number, w: number, h: number}>} Cell rects.
     */
    function computeCells() {
        const aspects = layout.method === 'best-fit'
            ? cells.map((entry) => entry.loaded && entry.image
                ? entry.image.naturalWidth / entry.image.naturalHeight
                : null)
            : undefined;
        return computeLayoutCells(layout, sources.length, outputWidth, outputHeight, gap, aspects);
    }

    /** @type {Array<{x: number, y: number, w: number, h: number}>} Current cell rects. */
    let gridCells = computeCells();

    /**
     * Recomputes the cells once every image has settled when the layout
     * resolves from image aspects ('best-fit'). Before settle the square
     * fallback stays active.
     *
     * @returns {void}
     */
    function refreshSettledLayout() {
        if (disposed || layout.method !== 'best-fit' || !isReady()) {
            return;
        }
        gridCells = computeCells();
    }

    /**
     * Returns the per-cell zoom floor (contain-fit scale) once the image
     * dimensions are known, the default floor before.
     *
     * @param {number} index Cell index.
     * @returns {number} Minimum zoom percent.
     */
    function cellMinScale(index) {
        const entry = cells[index];
        const cell = gridCells[index];
        if (entry?.loaded && entry.image && cell) {
            return computeCellMinScale(cell, entry.image.naturalWidth, entry.image.naturalHeight);
        }
        return COMPOSITOR_SCALE_MIN;
    }

    /**
     * Paints one cell onto a 2D context at the given geometry scale. The
     * themed placeholder fill goes behind EVERY cell, so letterboxed areas
     * (zoomed out towards the contain fit) are never transparent.
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

        ctx.fillStyle = themePaint(canvas, '--SmartThemeBlurTintColor', 'rgba(128, 128, 128, 0.25)');
        ctx.fillRect(cell.x, cell.y, cell.w, cell.h);

        const draw = entry?.loaded && entry.image
            ? computeCellCoverDraw(cell, entry.image.naturalWidth, entry.image.naturalHeight, offsets[index])
            : null;
        if (draw) {
            ctx.drawImage(entry.image, draw.dx, draw.dy, draw.dw, draw.dh);
        } else {
            // Empty / failed cell: initial letter over the placeholder fill.
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
            ctx.lineWidth = Math.max(2, Math.round(outputWidth / 256));
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
        ctx.clearRect(0, 0, outputWidth, outputHeight);
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
        const rect = canvas.getBoundingClientRect?.() ?? { left: 0, top: 0, width: outputWidth, height: outputHeight };
        const scaleX = rect.width > 0 ? outputWidth / rect.width : 1;
        const scaleY = rect.height > 0 ? outputHeight / rect.height : 1;
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
                setActiveCell(pinchIndex);
                dragState = null;
                pinchState = {
                    index: pinchIndex,
                    startDistance: currentPinchDistance(),
                    startScale: offsets[pinchIndex].scale,
                };
            }
        } else if (index >= 0) {
            setActiveCell(index);
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
            const scale = pinchCompositorScale(pinchState.startScale, pinchState.startDistance, currentPinchDistance(), cellMinScale(pinchState.index));
            setCellOffset(pinchState.index, { ...offsets[pinchState.index], scale }, false);
            event.preventDefault?.();
            return;
        }
        if (dragState) {
            const cell = gridCells[dragState.index];
            if (cell) {
                const deltaXPercent = ((point.x - dragState.startX) / cell.w) * 100;
                const deltaYPercent = ((point.y - dragState.startY) / cell.h) * 100;
                setCellOffset(dragState.index, panCompositorOffset(dragState.startOffset, deltaXPercent, deltaYPercent, cellMinScale(dragState.index)), false);
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
        setActiveCell(index);
        const delta = Number(event.deltaY) > 0 ? -COMPOSITOR_WHEEL_ZOOM_STEP : COMPOSITOR_WHEEL_ZOOM_STEP;
        setCellOffset(index, zoomCompositorOffset(offsets[index], delta, cellMinScale(index)), true);
    }, { passive: false, signal });

    canvas.addEventListener('keydown', (event) => {
        if (disposed) {
            return;
        }
        const key = String(event.key ?? '');

        // Cell selection: Tab / Shift+Tab cycle through the cells (the
        // editor is a self-contained widget — Escape hands focus back).
        if (key === 'Tab') {
            if (offsets.length > 1 && activeCellIndex >= 0) {
                event.preventDefault?.();
                const delta = event.shiftKey ? -1 : 1;
                setActiveCell((activeCellIndex + delta + offsets.length) % offsets.length);
                redraw();
            }
            // Single-cell (or empty) editors let Tab move focus out naturally.
            return;
        }
        if (key === 'Escape') {
            canvas.blur?.();
            return;
        }

        if (activeCellIndex < 0 || activeCellIndex >= offsets.length) {
            return;
        }
        const panDeltas = {
            ArrowLeft: [-KEYBOARD_PAN_STEP, 0],
            ArrowRight: [KEYBOARD_PAN_STEP, 0],
            ArrowUp: [0, -KEYBOARD_PAN_STEP],
            ArrowDown: [0, KEYBOARD_PAN_STEP],
        };
        if (key in panDeltas) {
            event.preventDefault?.();
            const [dx, dy] = panDeltas[key];
            setCellOffset(activeCellIndex, panCompositorOffset(offsets[activeCellIndex], dx, dy, cellMinScale(activeCellIndex)), true);
            return;
        }
        if (key === '+' || key === '=' || key === '-' || key === '_') {
            event.preventDefault?.();
            const delta = (key === '+' || key === '=') ? COMPOSITOR_WHEEL_ZOOM_STEP : -COMPOSITOR_WHEEL_ZOOM_STEP;
            setCellOffset(activeCellIndex, zoomCompositorOffset(offsets[activeCellIndex], delta, cellMinScale(activeCellIndex)), true);
            return;
        }
        if (key === '0') {
            event.preventDefault?.();
            resetCellOffset();
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
     * Resets the ACTIVE cell (pointer/keyboard-selected) to the identity
     * transform `{x: 0, y: 0, scale: 100}`, redraws, and fires a finalized
     * change so the page persists it.
     *
     * @returns {void}
     */
    function resetCellOffset() {
        if (disposed || activeCellIndex < 0 || activeCellIndex >= offsets.length) {
            return;
        }
        setCellOffset(activeCellIndex, { x: 0, y: 0, scale: 100 }, true);
    }

    /**
     * Resets EVERY cell to the identity transform, redraws, and fires one
     * finalized change so the page persists it.
     *
     * @returns {void}
     */
    function resetAllOffsets() {
        if (disposed || offsets.length === 0) {
            return;
        }
        offsets = offsets.map(() => ({ x: 0, y: 0, scale: 100 }));
        redraw();
        onChange?.(getOffsets(), true);
    }

    /**
     * Swaps the tiling layout: recomputes the cells, redraws, and keeps
     * hit-testing correct (pointer handlers always read the current cell
     * rects). Offsets are kept by index; images are NOT reloaded. A
     * 'best-fit' layout re-resolves against the currently loaded image
     * aspects (square fallback before they settle).
     *
     * @param {object} nextLayout Layout record (`{ method, gap, aspect, columns, resolution }`).
     * @returns {void}
     */
    function setLayout(nextLayout) {
        if (disposed) {
            return;
        }
        layout = normalizeCompositorLayout(nextLayout);
        if (Number.isFinite(Number(layout.gap)) && Number(layout.gap) >= 0) {
            gap = Number(layout.gap);
        }
        gridCells = computeCells();
        redraw();
    }

    /**
     * Returns a copy of the current cell rectangles (canvas coordinates at
     * output resolution).
     *
     * @returns {Array<{x: number, y: number, w: number, h: number}>} Cell rects.
     */
    function getLayoutCells() {
        return gridCells.map((cell) => ({ x: cell.x, y: cell.y, w: cell.w, h: cell.h }));
    }

    /**
     * Composes the current offsets into a PNG data URL with the CURRENT
     * layout. Resolution-independent: the cells and offsets are recomputed
     * at the export dims, `(outputWidth / 2)·scale × (outputHeight /
     * 2)·scale` px — with the default 1024×1536 canvas, scale 1|2|4 exports
     * 512×768 / 1024×1536 / 2048×3072. The scale defaults to the layout's
     * `resolution` ({@link COMPOSITOR_DEFAULT_RESOLUTION} when absent), so
     * a default call exports at the internal output dims. Returns null when
     * no source image is available, when the canvas is unsupported, or when
     * encoding fails (e.g. a tainted canvas).
     *
     * @param {number} [scale] Export scale (defaults to the layout resolution).
     * @returns {string|null} PNG data URL, or null.
     */
    function getComposedImageDataURL(scale) {
        if (disposed || !cells.some((entry) => entry.loaded)) {
            return null;
        }
        const explicitScale = Number(scale);
        const layoutScale = Number(layout.resolution);
        const exportScale = Number.isFinite(explicitScale) && explicitScale > 0
            ? explicitScale
            : Number.isFinite(layoutScale) && layoutScale > 0
                ? layoutScale
                : COMPOSITOR_DEFAULT_RESOLUTION;
        const targetWidth = Math.max(1, Math.round((outputWidth / 2) * exportScale));
        const targetHeight = Math.max(1, Math.round((outputHeight / 2) * exportScale));
        try {
            const offscreen = document.createElement('canvas');
            offscreen.width = targetWidth;
            offscreen.height = targetHeight;
            const ctx = offscreen.getContext?.('2d');
            if (!ctx) {
                return null;
            }
            const scaledGap = gap * (targetWidth / outputWidth);
            const aspects = layout.method === 'best-fit'
                ? cells.map((entry) => entry.loaded && entry.image
                    ? entry.image.naturalWidth / entry.image.naturalHeight
                    : null)
                : undefined;
            paintComposite(ctx, computeLayoutCells(layout, sources.length, targetWidth, targetHeight, scaledGap, aspects), false);
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

    return { root, getOffsets, setLayout, getLayoutCells, getComposedImageDataURL, resetCellOffset, resetAllOffsets, isReady, dispose };
}
