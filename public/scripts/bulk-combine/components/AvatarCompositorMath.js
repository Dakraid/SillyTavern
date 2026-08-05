'use strict';

/**
 * @file Pure geometry math for the native AvatarCompositor.
 *
 * Every function in this module is pure and DOM-free so the composition
 * geometry is unit-testable in Node without a canvas. The component
 * (`AvatarCompositor.js`) keeps only thin canvas/pointer wiring on top of
 * these functions.
 *
 * Offset model (mirrors the legacy composite semantics):
 * - `x`, `y`: pan as a PERCENT of the cell's width/height, clamped to
 *   ±{@link COMPOSITOR_OFFSET_LIMIT}. Resolution-independent: the same
 *   offsets compose identically at any output size.
 * - `scale`: zoom as a PERCENT on top of the cover fit, clamped to
 *   [per-cell floor, {@link COMPOSITOR_SCALE_MAX}]. 100 means "exactly
 *   cover the cell"; at the per-cell floor the WHOLE image is exactly
 *   contained (letterboxed) inside the cell. The floor is the contain-fit
 *   scale {@link computeCellMinScale}, applied lazily at draw/interaction
 *   time once the image dimensions are known; {@link COMPOSITOR_SCALE_MIN}
 *   is only the pre-load/default floor. Persisted sub-50 scales therefore
 *   round-trip: construction normalizes scale to [1, MAX] only.
 *
 * Layout model: {@link computeLayoutCells} resolves a `{ method, gap,
 * aspect, columns, resolution }` layout record into cell rectangles on a
 * (possibly non-square) `width × height` canvas — a grid of square-ish
 * cells (`'square'`), a portrait cell-aspect grid (`'portrait'`), or a grid
 * fitted to the loaded source image aspects (`'best-fit'`). All three go
 * through the unified shape search {@link resolveAspectGridShape}; an
 * explicit `columns` (≥ 1) skips the search. `resolution` (1|2|4) is the
 * export scale — it never affects the cells.
 */

/**
 * Pan limit for a cell offset, in percent of the cell dimension.
 *
 * @type {number}
 */
export const COMPOSITOR_OFFSET_LIMIT = 100;

/**
 * Minimum zoom percent (relative to the cover fit).
 *
 * @type {number}
 */
export const COMPOSITOR_SCALE_MIN = 50;

/**
 * Maximum zoom percent (relative to the cover fit).
 *
 * @type {number}
 */
export const COMPOSITOR_SCALE_MAX = 200;

/**
 * Default square output size, in pixels (legacy `outputSize` fallback).
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_OUTPUT_SIZE = 1024;

/**
 * Default output width, in pixels (2:3 portrait canvas).
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_OUTPUT_WIDTH = 1024;

/**
 * Default output height, in pixels (2:3 portrait canvas).
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_OUTPUT_HEIGHT = 1536;

/**
 * Default gap between grid cells, in pixels (at output resolution).
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_GAP = 8;

/**
 * Wheel zoom step, in scale points.
 *
 * @type {number}
 */
export const COMPOSITOR_WHEEL_ZOOM_STEP = 5;

/**
 * Tiling methods understood by {@link computeLayoutCells}.
 *
 * @type {ReadonlyArray<string>}
 */
export const COMPOSITOR_LAYOUT_METHODS = Object.freeze(['square', 'portrait', 'best-fit']);

/**
 * Selectable portrait cell aspects (`width:height` → `width / height`).
 *
 * @type {Readonly<object>}
 */
export const COMPOSITOR_PORTRAIT_ASPECTS = Object.freeze({
    '2:3': 2 / 3,
    '3:4': 3 / 4,
    '9:16': 9 / 16,
});

/**
 * Default portrait aspect key (the avatar page's persisted default).
 *
 * @type {string}
 */
export const COMPOSITOR_DEFAULT_PORTRAIT_ASPECT = '3:4';

/**
 * Selectable export resolutions (scale factors on the 512×768 base: ×1 →
 * 512×768, ×2 → 1024×1536, ×4 → 2048×3072).
 *
 * @type {ReadonlyArray<number>}
 */
export const COMPOSITOR_LAYOUT_RESOLUTIONS = Object.freeze([1, 2, 4]);

/**
 * Default export resolution (×2 → 1024×1536, the internal output dims).
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_RESOLUTION = 2;

/**
 * Clamps a numeric value to a range with a fallback for non-finite input.
 *
 * @param {unknown} value Input value.
 * @param {number} min Minimum.
 * @param {number} max Maximum.
 * @param {number} fallback Fallback when the value is not finite.
 * @returns {number} Clamped, rounded number.
 */
export function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalizes a raw offset into a clamped `{ x, y, scale }` record, using
 * the fixed {@link COMPOSITOR_SCALE_MIN} floor. Back-compat normalizer for
 * callers that predate the per-cell contain floor; internally the floor-
 * aware {@link normalizeCompositorOffsetWithFloor} is used instead.
 *
 * @param {unknown} offset Raw offset candidate.
 * @returns {{x: number, y: number, scale: number}} Normalized offset.
 */
export function normalizeCompositorOffset(offset) {
    return {
        x: clampNumber(offset?.x, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
        y: clampNumber(offset?.y, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
        scale: clampNumber(offset?.scale, COMPOSITOR_SCALE_MIN, COMPOSITOR_SCALE_MAX, 100),
    };
}

/**
 * Normalizes a raw offset against a per-cell zoom floor (the contain-fit
 * scale from {@link computeCellMinScale}). A non-finite or non-positive
 * `minScale` falls back to {@link COMPOSITOR_SCALE_MIN}.
 *
 * @param {unknown} offset Raw offset candidate.
 * @param {number} [minScale] Per-cell minimum zoom percent.
 * @returns {{x: number, y: number, scale: number}} Normalized offset.
 */
export function normalizeCompositorOffsetWithFloor(offset, minScale = COMPOSITOR_SCALE_MIN) {
    const floor = Number.isFinite(Number(minScale)) && Number(minScale) > 0
        ? Number(minScale)
        : COMPOSITOR_SCALE_MIN;
    return {
        x: clampNumber(offset?.x, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
        y: clampNumber(offset?.y, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
        scale: clampNumber(offset?.scale, floor, COMPOSITOR_SCALE_MAX, 100),
    };
}

/**
 * Normalizes an offset list to exactly `count` entries, filling missing or
 * malformed entries with defaults.
 *
 * Scale is normalized to `[1, COMPOSITOR_SCALE_MAX]` — deliberately NOT to
 * the fixed {@link COMPOSITOR_SCALE_MIN}: the effective zoom floor is the
 * per-cell contain fit, which is only known once the cell and the image
 * dimensions are. A persisted zoomed-out scale below 50 must survive the
 * round-trip through construction; it is clamped against the per-cell
 * floor lazily at draw/interaction time instead.
 *
 * @param {unknown} offsets Raw offset list.
 * @param {number} count Required entry count.
 * @returns {Array<{x: number, y: number, scale: number}>} Normalized offsets.
 */
export function normalizeCompositorOffsets(offsets, count) {
    const list = Array.isArray(offsets) ? offsets : [];
    return Array.from({ length: Math.max(0, count) }, (_, index) => {
        const offset = list[index];
        return {
            x: clampNumber(offset?.x, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
            y: clampNumber(offset?.y, -COMPOSITOR_OFFSET_LIMIT, COMPOSITOR_OFFSET_LIMIT, 0),
            scale: clampNumber(offset?.scale, 1, COMPOSITOR_SCALE_MAX, 100),
        };
    });
}

/**
 * Computes the cell rectangles for an explicit `cols × rows` grid shape on
 * a `width × height` canvas. Cells are emitted row-major; empty trailing
 * slots are skipped, so the result always has `count` cells.
 *
 * @param {number} count Number of source cells.
 * @param {number} width Canvas width in pixels.
 * @param {number} height Canvas height in pixels.
 * @param {number} gap Gap between cells in pixels.
 * @param {number} cols Column count.
 * @param {number} rows Row count.
 * @returns {Array<{x: number, y: number, w: number, h: number}>} Cell rectangles in canvas coordinates.
 */
function computeShapedCells(count, width, height, gap, cols, rows) {
    // Keep the gap from swallowing the canvas in either dimension: fall
    // back towards 0 until the cells stay positive-sized (≥ 1 px).
    let effectiveGap = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 0;
    const maxGapCols = cols > 1 ? (width - cols) / (cols - 1) : effectiveGap;
    const maxGapRows = rows > 1 ? (height - rows) / (rows - 1) : effectiveGap;
    effectiveGap = Math.min(effectiveGap, Math.max(0, Math.floor(Math.min(maxGapCols, maxGapRows))));

    const cellW = (width - effectiveGap * (cols - 1)) / cols;
    const cellH = (height - effectiveGap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) {
        return [];
    }

    return Array.from({ length: count }, (_, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
            x: col * (cellW + effectiveGap),
            y: row * (cellH + effectiveGap),
            w: cellW,
            h: cellH,
        };
    });
}

/**
 * Computes a near-square grid of cell rectangles for `count` sources on a
 * square canvas: `cols = ceil(sqrt(count))`, `rows = ceil(count / cols)`
 * (1→1×1, 2→2×1, 3–4→2×2, 5–6→3×2, …). Cells are emitted row-major; empty
 * trailing slots are skipped, so the result always has `count` cells.
 *
 * @param {number} count Number of source cells.
 * @param {number} size Square canvas size in pixels.
 * @param {number} [gap] Gap between cells in pixels.
 * @returns {Array<{x: number, y: number, w: number, h: number}>} Cell rectangles in canvas coordinates.
 */
export function computeGridCells(count, size, gap = COMPOSITOR_DEFAULT_GAP) {
    const n = Math.floor(Number(count));
    const canvasSize = Number(size);
    if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(canvasSize) || canvasSize <= 0) {
        return [];
    }

    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    return computeShapedCells(n, canvasSize, canvasSize, gap, cols, rows);
}

/**
 * Normalizes a persisted layout record. Unknown/missing methods fall back
 * to `'square'`, unknown/missing portrait aspects to
 * {@link COMPOSITOR_DEFAULT_PORTRAIT_ASPECT}. `columns` is an integer ≥ 0
 * (0 = auto, the shape search decides); `resolution` is one of
 * {@link COMPOSITOR_LAYOUT_RESOLUTIONS} (default
 * {@link COMPOSITOR_DEFAULT_RESOLUTION}). A finite, non-negative `gap` is
 * carried through; any other gap is omitted (callers fall back to their
 * own default).
 *
 * @param {unknown} layout Raw layout record (`{ method, gap, aspect, columns, resolution }`).
 * @returns {{method: string, aspect: string, columns: number, resolution: number, gap?: number}} Normalized layout.
 */
export function normalizeCompositorLayout(layout) {
    const method = COMPOSITOR_LAYOUT_METHODS.includes(layout?.method) ? layout.method : 'square';
    const aspect = typeof COMPOSITOR_PORTRAIT_ASPECTS[layout?.aspect] === 'number'
        ? layout.aspect
        : COMPOSITOR_DEFAULT_PORTRAIT_ASPECT;
    const columns = Number.isSafeInteger(Number(layout?.columns)) && Number(layout.columns) >= 0
        ? Number(layout.columns)
        : 0;
    const resolution = COMPOSITOR_LAYOUT_RESOLUTIONS.includes(Number(layout?.resolution))
        ? Number(layout.resolution)
        : COMPOSITOR_DEFAULT_RESOLUTION;
    /** @type {{method: string, aspect: string, columns: number, resolution: number, gap?: number}} */
    const normalized = { method, aspect, columns, resolution };
    const gap = Number(layout?.gap);
    if (Number.isFinite(gap) && gap >= 0) {
        normalized.gap = gap;
    }
    return normalized;
}

/**
 * Geometric mean of the finite, positive entries of `values`, or null when
 * no usable entry exists.
 *
 * @param {unknown} values Raw aspect list (entries may be null/garbage).
 * @returns {number|null} Geometric mean aspect (width / height).
 */
function geometricMeanAspect(values) {
    const list = (Array.isArray(values) ? values : [])
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (list.length === 0) {
        return null;
    }
    return Math.exp(list.reduce((sum, value) => sum + Math.log(value), 0) / list.length);
}

/**
 * Picks the `cols × rows` grid shape (cols·rows ≥ count) whose cell aspect
 * — `rows / cols · (canvas width / canvas height)` — best approximates the
 * target. The search is unified over the shape ratio `k = rows / cols`:
 * callers fold the canvas and cell/image aspects into `k` (see
 * {@link computeLayoutCells}).
 *
 * For each column count the row count is `ceil(count / cols)`, i.e. the
 * empty-slot-minimizing grid for that many columns; the aspect match picks
 * between those candidates (mirrors the legacy server-side `calculateGrid`
 * search). Ties keep the fewest columns.
 *
 * @param {number} count Number of source cells.
 * @param {number} k Target shape ratio (`rows / cols`); non-finite or
 * non-positive input falls back to 1 (balanced grid).
 * @returns {{cols: number, rows: number}} Grid shape.
 */
export function resolveAspectGridShape(count, k) {
    const n = Math.floor(Number(count));
    if (!Number.isFinite(n) || n <= 0) {
        return { cols: 1, rows: 1 };
    }
    const target = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : 1;
    let best = { cols: 1, rows: n };
    let bestDiff = Infinity;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const diff = Math.abs(rows / cols - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = { cols, rows };
        }
    }
    return best;
}

/**
 * Resolves a tiling layout into cell rectangles on a `width × height`
 * canvas.
 *
 * - `'square'` (default): a grid of square-ish cells — on a square canvas
 *   exactly the classic near-square {@link computeGridCells} grid.
 * - `'portrait'`: the canvas-filling grid whose cell aspect best
 *   approximates the selected portrait ratio (`layout.aspect`, one of
 *   {@link COMPOSITOR_PORTRAIT_ASPECTS}).
 * - `'best-fit'`: the same search with the target aspect set to the
 *   geometric mean of `imageAspects` (the LOADED source image aspects,
 *   `width / height`); no usable aspect → the square target.
 *
 * All three go through the unified shape search
 * {@link resolveAspectGridShape} over `k = rows / cols`: the canvas folds
 * in as `H / W`, so `k` is `H / W` (square), `r · H / W` (portrait, `r` the
 * cell aspect), or `g · H / W` (best-fit, `g` the geomean image aspect).
 * An explicit `layout.columns` (≥ 1) skips the search for every method:
 * `cols = min(columns, count)`, `rows = ceil(count / cols)`.
 * `layout.resolution` never affects the cells (export scale only).
 *
 * @param {unknown} layout Layout record (`{ method, gap, aspect, columns, resolution }`).
 * @param {number} count Number of source cells.
 * @param {number} width Canvas width in pixels.
 * @param {number} height Canvas height in pixels.
 * @param {number} [gap] Gap between cells in pixels (overridden by a valid `layout.gap`).
 * @param {Array<number|null>} [imageAspects] Loaded source image aspects (best-fit only).
 * @returns {Array<{x: number, y: number, w: number, h: number}>} Cell rectangles in canvas coordinates.
 */
export function computeLayoutCells(layout, count, width, height, gap = COMPOSITOR_DEFAULT_GAP, imageAspects) {
    const n = Math.floor(Number(count));
    const canvasWidth = Number(width);
    const canvasHeight = Number(height);
    if (!Number.isFinite(n) || n <= 0
        || !Number.isFinite(canvasWidth) || canvasWidth <= 0
        || !Number.isFinite(canvasHeight) || canvasHeight <= 0) {
        return [];
    }

    const normalized = normalizeCompositorLayout(layout);
    const effectiveGap = normalized.gap ?? gap;

    // Explicit columns skip the shape search for every method.
    if (normalized.columns >= 1) {
        const cols = Math.min(normalized.columns, n);
        const rows = Math.ceil(n / cols);
        return computeShapedCells(n, canvasWidth, canvasHeight, effectiveGap, cols, rows);
    }

    const canvasRatio = canvasHeight / canvasWidth;
    let k = canvasRatio;
    if (normalized.method === 'portrait') {
        k = COMPOSITOR_PORTRAIT_ASPECTS[normalized.aspect] * canvasRatio;
    } else if (normalized.method === 'best-fit') {
        const mean = geometricMeanAspect(imageAspects);
        k = Number.isFinite(mean) && mean > 0 ? mean * canvasRatio : canvasRatio;
    }

    const { cols, rows } = resolveAspectGridShape(n, k);
    return computeShapedCells(n, canvasWidth, canvasHeight, effectiveGap, cols, rows);
}

/**
 * Computes the per-cell minimum zoom percent: the contain-fit scale at
 * which the WHOLE image is exactly visible (letterboxed) inside the cell.
 * Zooming out beyond it cannot reveal more of the image, so it is the
 * effective zoom floor — the fixed {@link COMPOSITOR_SCALE_MIN} used to
 * keep extreme-aspect images cropped forever.
 *
 * The result is rounded UP so integer zoom steps never crop, and never
 * exceeds 100 (contain fit of a matching-aspect image). Degenerate input
 * falls back to {@link COMPOSITOR_SCALE_MIN} (the pre-load default floor).
 *
 * @param {{x: number, y: number, w: number, h: number}} cell Cell rectangle.
 * @param {number} imageWidth Natural image width.
 * @param {number} imageHeight Natural image height.
 * @returns {number} Minimum zoom percent.
 */
export function computeCellMinScale(cell, imageWidth, imageHeight) {
    const iw = Number(imageWidth);
    const ih = Number(imageHeight);
    if (!cell || !(iw > 0) || !(ih > 0) || !(Number(cell.w) > 0) || !(Number(cell.h) > 0)) {
        return COMPOSITOR_SCALE_MIN;
    }
    const wideFit = Number(cell.w) / iw;
    const highFit = Number(cell.h) / ih;
    return Math.ceil(100 * Math.min(wideFit, highFit) / Math.max(wideFit, highFit));
}

/**
 * Computes the cover-fit draw rectangle for an image inside a cell, with the
 * cell offset applied: the image is scaled to cover the cell (`max` fit),
 * multiplied by `offset.scale / 100`, centered, then panned by
 * `offset.x/y` percent of the cell dimensions. The scale is clamped to the
 * per-cell contain-fit floor ({@link computeCellMinScale}) so extreme-aspect
 * images can always be zoomed out until fully visible (letterboxed).
 *
 * @param {{x: number, y: number, w: number, h: number}} cell Cell rectangle.
 * @param {number} imageWidth Natural image width.
 * @param {number} imageHeight Natural image height.
 * @param {unknown} offset Raw offset (normalized internally).
 * @returns {{dx: number, dy: number, dw: number, dh: number}|null} Draw rectangle in canvas coordinates, or null for degenerate input.
 */
export function computeCellCoverDraw(cell, imageWidth, imageHeight, offset) {
    const iw = Number(imageWidth);
    const ih = Number(imageHeight);
    if (!cell || !(iw > 0) || !(ih > 0) || !(Number(cell.w) > 0) || !(Number(cell.h) > 0)) {
        return null;
    }

    const o = normalizeCompositorOffsetWithFloor(offset, computeCellMinScale(cell, iw, ih));
    const coverScale = Math.max(cell.w / iw, cell.h / ih);
    const totalScale = coverScale * (o.scale / 100);
    const dw = iw * totalScale;
    const dh = ih * totalScale;
    const dx = Number(cell.x) + (cell.w - dw) / 2 + (o.x / 100) * cell.w;
    const dy = Number(cell.y) + (cell.h - dh) / 2 + (o.y / 100) * cell.h;
    return { dx, dy, dw, dh };
}

/**
 * Returns a new offset panned by the given percent-of-cell deltas, clamped.
 * The scale is preserved but re-clamped against the per-cell floor.
 *
 * @param {unknown} offset Current offset.
 * @param {number} deltaXPercent Pan delta in percent of the cell width.
 * @param {number} deltaYPercent Pan delta in percent of the cell height.
 * @param {number} [minScale] Per-cell zoom floor (default {@link COMPOSITOR_SCALE_MIN}).
 * @returns {{x: number, y: number, scale: number}} New offset.
 */
export function panCompositorOffset(offset, deltaXPercent, deltaYPercent, minScale = COMPOSITOR_SCALE_MIN) {
    const o = normalizeCompositorOffsetWithFloor(offset, minScale);
    return normalizeCompositorOffsetWithFloor({
        x: o.x + (Number.isFinite(Number(deltaXPercent)) ? Number(deltaXPercent) : 0),
        y: o.y + (Number.isFinite(Number(deltaYPercent)) ? Number(deltaYPercent) : 0),
        scale: o.scale,
    }, minScale);
}

/**
 * Returns a new offset zoomed by the given scale-point delta, clamped.
 *
 * @param {unknown} offset Current offset.
 * @param {number} scaleDelta Zoom delta in scale points (e.g. ±5).
 * @param {number} [minScale] Per-cell zoom floor (default {@link COMPOSITOR_SCALE_MIN}).
 * @returns {{x: number, y: number, scale: number}} New offset.
 */
export function zoomCompositorOffset(offset, scaleDelta, minScale = COMPOSITOR_SCALE_MIN) {
    const o = normalizeCompositorOffsetWithFloor(offset, minScale);
    return normalizeCompositorOffsetWithFloor({
        x: o.x,
        y: o.y,
        scale: o.scale + (Number.isFinite(Number(scaleDelta)) ? Number(scaleDelta) : 0),
    }, minScale);
}

/**
 * Computes a pinch-zoom scale: proportional to the finger-distance ratio,
 * clamped to [floor, {@link COMPOSITOR_SCALE_MAX}]. Degenerate distances
 * keep the start scale.
 *
 * @param {number} startScale Scale when the pinch started.
 * @param {number} startDistance Finger distance when the pinch started.
 * @param {number} currentDistance Current finger distance.
 * @param {number} [minScale] Per-cell zoom floor (default {@link COMPOSITOR_SCALE_MIN}).
 * @returns {number} New scale.
 */
export function pinchCompositorScale(startScale, startDistance, currentDistance, minScale = COMPOSITOR_SCALE_MIN) {
    const floor = Number.isFinite(Number(minScale)) && Number(minScale) > 0
        ? Number(minScale)
        : COMPOSITOR_SCALE_MIN;
    const start = clampNumber(startScale, floor, COMPOSITOR_SCALE_MAX, 100);
    const from = Number(startDistance);
    const to = Number(currentDistance);
    if (!(from > 0) || !(to > 0)) {
        return start;
    }
    return clampNumber(start * (to / from), floor, COMPOSITOR_SCALE_MAX, start);
}

/**
 * Returns the index of the cell containing a canvas-space point, or -1.
 *
 * @param {Array<{x: number, y: number, w: number, h: number}>} cells Cell rectangles.
 * @param {number} x Canvas X coordinate.
 * @param {number} y Canvas Y coordinate.
 * @returns {number} Cell index, or -1 when the point hits no cell.
 */
export function hitTestCell(cells, x, y) {
    const list = Array.isArray(cells) ? cells : [];
    const px = Number(x);
    const py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
        return -1;
    }
    return list.findIndex((cell) => cell
        && px >= Number(cell.x) && px < Number(cell.x) + Number(cell.w)
        && py >= Number(cell.y) && py < Number(cell.y) + Number(cell.h));
}
