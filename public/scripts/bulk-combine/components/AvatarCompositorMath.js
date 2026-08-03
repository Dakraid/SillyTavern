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
 *   [{@link COMPOSITOR_SCALE_MIN}, {@link COMPOSITOR_SCALE_MAX}]. 100 means
 *   "exactly cover the cell"; below 100 the image may leave gaps.
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
 * Default square output size, in pixels.
 *
 * @type {number}
 */
export const COMPOSITOR_DEFAULT_OUTPUT_SIZE = 1024;

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
 * Normalizes a raw offset into a clamped `{ x, y, scale }` record.
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
 * Normalizes an offset list to exactly `count` entries, filling missing or
 * malformed entries with defaults.
 *
 * @param {unknown} offsets Raw offset list.
 * @param {number} count Required entry count.
 * @returns {Array<{x: number, y: number, scale: number}>} Normalized offsets.
 */
export function normalizeCompositorOffsets(offsets, count) {
    const list = Array.isArray(offsets) ? offsets : [];
    return Array.from({ length: Math.max(0, count) }, (_, index) => normalizeCompositorOffset(list[index]));
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

    // Keep the gap from swallowing the canvas: fall back towards 0 until
    // the cells stay positive-sized.
    let effectiveGap = Number.isFinite(Number(gap)) ? Math.max(0, Number(gap)) : 0;
    const maxGap = (canvasSize - cols) / Math.max(0, cols - 1 || 1);
    if (cols > 1 && effectiveGap > maxGap) {
        effectiveGap = Math.max(0, Math.floor(maxGap));
    }

    const cellW = (canvasSize - effectiveGap * (cols - 1)) / cols;
    const cellH = (canvasSize - effectiveGap * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) {
        return [];
    }

    return Array.from({ length: n }, (_, index) => {
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
 * Computes the cover-fit draw rectangle for an image inside a cell, with the
 * cell offset applied: the image is scaled to cover the cell (`max` fit),
 * multiplied by `offset.scale / 100`, centered, then panned by
 * `offset.x/y` percent of the cell dimensions.
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

    const o = normalizeCompositorOffset(offset);
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
 *
 * @param {unknown} offset Current offset.
 * @param {number} deltaXPercent Pan delta in percent of the cell width.
 * @param {number} deltaYPercent Pan delta in percent of the cell height.
 * @returns {{x: number, y: number, scale: number}} New offset.
 */
export function panCompositorOffset(offset, deltaXPercent, deltaYPercent) {
    const o = normalizeCompositorOffset(offset);
    return normalizeCompositorOffset({
        x: o.x + (Number.isFinite(Number(deltaXPercent)) ? Number(deltaXPercent) : 0),
        y: o.y + (Number.isFinite(Number(deltaYPercent)) ? Number(deltaYPercent) : 0),
        scale: o.scale,
    });
}

/**
 * Returns a new offset zoomed by the given scale-point delta, clamped.
 *
 * @param {unknown} offset Current offset.
 * @param {number} scaleDelta Zoom delta in scale points (e.g. ±5).
 * @returns {{x: number, y: number, scale: number}} New offset.
 */
export function zoomCompositorOffset(offset, scaleDelta) {
    const o = normalizeCompositorOffset(offset);
    return normalizeCompositorOffset({
        x: o.x,
        y: o.y,
        scale: o.scale + (Number.isFinite(Number(scaleDelta)) ? Number(scaleDelta) : 0),
    });
}

/**
 * Computes a pinch-zoom scale: proportional to the finger-distance ratio,
 * clamped to the scale range. Degenerate distances keep the start scale.
 *
 * @param {number} startScale Scale when the pinch started.
 * @param {number} startDistance Finger distance when the pinch started.
 * @param {number} currentDistance Current finger distance.
 * @returns {number} New scale.
 */
export function pinchCompositorScale(startScale, startDistance, currentDistance) {
    const start = clampNumber(startScale, COMPOSITOR_SCALE_MIN, COMPOSITOR_SCALE_MAX, 100);
    const from = Number(startDistance);
    const to = Number(currentDistance);
    if (!(from > 0) || !(to > 0)) {
        return start;
    }
    return clampNumber(start * (to / from), COMPOSITOR_SCALE_MIN, COMPOSITOR_SCALE_MAX, start);
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
