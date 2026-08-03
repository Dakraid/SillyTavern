'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/components/AvatarCompositorMath.js`.
 *
 * The module is pure (no imports, no DOM), so these tests exercise the
 * composition geometry directly: grid layout for several source counts,
 * cover-fit draw math, offset normalization, and pan/zoom/pinch clamping.
 */

import { describe, expect, test } from '@jest/globals';

import {
    COMPOSITOR_OFFSET_LIMIT,
    COMPOSITOR_SCALE_MAX,
    COMPOSITOR_SCALE_MIN,
    clampNumber,
    computeCellCoverDraw,
    computeGridCells,
    hitTestCell,
    normalizeCompositorOffset,
    normalizeCompositorOffsets,
    panCompositorOffset,
    pinchCompositorScale,
    zoomCompositorOffset,
} from '../../public/scripts/bulk-combine/components/AvatarCompositorMath.js';

describe('clampNumber', () => {
    test('clamps and rounds finite values', () => {
        expect(clampNumber(5.6, 0, 10, 0)).toBe(6);
        expect(clampNumber(-3, 0, 10, 0)).toBe(0);
        expect(clampNumber(99, 0, 10, 0)).toBe(10);
    });

    test('returns the fallback for non-finite input', () => {
        expect(clampNumber('nope', 0, 10, 4)).toBe(4);
        expect(clampNumber(NaN, 0, 10, 4)).toBe(4);
        expect(clampNumber(Infinity, 0, 10, 4)).toBe(4);
        expect(clampNumber(undefined, 0, 10, 4)).toBe(4);
        // Number(null) === 0, which is finite — not a fallback case.
        expect(clampNumber(null, 0, 10, 4)).toBe(0);
    });
});

describe('normalizeCompositorOffset', () => {
    test('defaults a missing offset to the identity transform', () => {
        expect(normalizeCompositorOffset(undefined)).toEqual({ x: 0, y: 0, scale: 100 });
        expect(normalizeCompositorOffset(null)).toEqual({ x: 0, y: 0, scale: 100 });
        expect(normalizeCompositorOffset({})).toEqual({ x: 0, y: 0, scale: 100 });
        expect(normalizeCompositorOffset('junk')).toEqual({ x: 0, y: 0, scale: 100 });
    });

    test('clamps x/y to ±LIMIT and scale to [MIN, MAX]', () => {
        expect(normalizeCompositorOffset({ x: 500, y: -500, scale: 1000 })).toEqual({
            x: COMPOSITOR_OFFSET_LIMIT,
            y: -COMPOSITOR_OFFSET_LIMIT,
            scale: COMPOSITOR_SCALE_MAX,
        });
        expect(normalizeCompositorOffset({ x: 10, y: -20, scale: 1 })).toEqual({
            x: 10,
            y: -20,
            scale: COMPOSITOR_SCALE_MIN,
        });
    });
});

describe('normalizeCompositorOffsets', () => {
    test('pads to the requested count with defaults', () => {
        const result = normalizeCompositorOffsets([{ x: 5, y: 6, scale: 110 }], 3);
        expect(result).toEqual([
            { x: 5, y: 6, scale: 110 },
            { x: 0, y: 0, scale: 100 },
            { x: 0, y: 0, scale: 100 },
        ]);
    });

    test('handles non-array input and zero count', () => {
        expect(normalizeCompositorOffsets(null, 2)).toEqual([
            { x: 0, y: 0, scale: 100 },
            { x: 0, y: 0, scale: 100 },
        ]);
        expect(normalizeCompositorOffsets([], 0)).toEqual([]);
    });
});

describe('computeGridCells', () => {
    test('returns no cells for degenerate input', () => {
        expect(computeGridCells(0, 100)).toEqual([]);
        expect(computeGridCells(-2, 100)).toEqual([]);
        expect(computeGridCells(2, 0)).toEqual([]);
        expect(computeGridCells(2, -100)).toEqual([]);
        expect(computeGridCells('x', 100)).toEqual([]);
    });

    test('one source fills the whole canvas', () => {
        expect(computeGridCells(1, 100, 8)).toEqual([{ x: 0, y: 0, w: 100, h: 100 }]);
    });

    test('two sources form a 2×1 grid with one gap', () => {
        const cells = computeGridCells(2, 108, 8);
        expect(cells).toEqual([
            { x: 0, y: 0, w: 50, h: 108 },
            { x: 58, y: 0, w: 50, h: 108 },
        ]);
    });

    test('three sources form a 2×2 grid (trailing slot skipped)', () => {
        const cells = computeGridCells(3, 108, 8);
        expect(cells).toHaveLength(3);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 50, h: 50 });
        expect(cells[1]).toEqual({ x: 58, y: 0, w: 50, h: 50 });
        expect(cells[2]).toEqual({ x: 0, y: 58, w: 50, h: 50 });
    });

    test('four sources form a full 2×2 grid', () => {
        const cells = computeGridCells(4, 100, 0);
        expect(cells).toEqual([
            { x: 0, y: 0, w: 50, h: 50 },
            { x: 50, y: 0, w: 50, h: 50 },
            { x: 0, y: 50, w: 50, h: 50 },
            { x: 50, y: 50, w: 50, h: 50 },
        ]);
    });

    test('five sources form a 3×2 grid', () => {
        const cells = computeGridCells(5, 90, 0);
        expect(cells).toHaveLength(5);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 30, h: 45 });
        expect(cells[3]).toEqual({ x: 0, y: 45, w: 30, h: 45 });
        expect(cells[4]).toEqual({ x: 30, y: 45, w: 30, h: 45 });
    });

    test('an absurd gap falls back so cells stay positive', () => {
        const cells = computeGridCells(2, 100, 5000);
        expect(cells).toHaveLength(2);
        for (const cell of cells) {
            expect(cell.w).toBeGreaterThan(0);
            expect(cell.h).toBeGreaterThan(0);
        }
    });
});

describe('computeCellCoverDraw', () => {
    const cell = { x: 10, y: 20, w: 100, h: 100 };

    test('returns null for degenerate input', () => {
        expect(computeCellCoverDraw(null, 100, 100, null)).toBe(null);
        expect(computeCellCoverDraw(cell, 0, 100, null)).toBe(null);
        expect(computeCellCoverDraw(cell, 100, -5, null)).toBe(null);
        expect(computeCellCoverDraw({ x: 0, y: 0, w: 0, h: 10 }, 100, 100, null)).toBe(null);
    });

    test('a square image in a square cell at defaults exactly fills the cell', () => {
        expect(computeCellCoverDraw(cell, 200, 200, null)).toEqual({ dx: 10, dy: 20, dw: 100, dh: 100 });
    });

    test('a portrait image covers by overflowing horizontally, centered', () => {
        // 100×200 image in a 100×100 cell: cover scale = 1 → dw=100, dh=200, dy centered at -50.
        expect(computeCellCoverDraw(cell, 100, 200, null)).toEqual({ dx: 10, dy: -30, dw: 100, dh: 200 });
    });

    test('a landscape image covers by overflowing vertically, centered', () => {
        // 200×100 image in a 100×100 cell: cover scale = 1 → dw=200, dh=100, dx centered at -50.
        expect(computeCellCoverDraw(cell, 200, 100, null)).toEqual({ dx: -40, dy: 20, dw: 200, dh: 100 });
    });

    test('scale multiplies the cover fit', () => {
        const draw = computeCellCoverDraw(cell, 200, 200, { x: 0, y: 0, scale: 200 });
        expect(draw.dw).toBe(200);
        expect(draw.dh).toBe(200);
        expect(draw.dx).toBe(10 - 50);
        expect(draw.dy).toBe(20 - 50);
    });

    test('x/y offsets pan by a percent of the cell dimensions', () => {
        const draw = computeCellCoverDraw(cell, 200, 200, { x: 10, y: -25, scale: 100 });
        expect(draw.dx).toBe(10 + 10); // +10% of cell.w
        expect(draw.dy).toBe(20 - 25); // -25% of cell.h
        expect(draw.dw).toBe(100);
        expect(draw.dh).toBe(100);
    });

    test('raw offsets are normalized (extreme input clamps)', () => {
        const draw = computeCellCoverDraw(cell, 200, 200, { x: 9999, y: 0, scale: 1 });
        // x clamps to +100% of cell.w; scale clamps to 50 → dw=50, centered (+25).
        expect(draw.dx).toBe(10 + 25 + COMPOSITOR_OFFSET_LIMIT);
        expect(draw.dw).toBe(100 * (COMPOSITOR_SCALE_MIN / 100));
    });
});

describe('panCompositorOffset', () => {
    test('adds percent deltas and clamps to the limit', () => {
        expect(panCompositorOffset({ x: 10, y: 10, scale: 120 }, 5, -20)).toEqual({ x: 15, y: -10, scale: 120 });
        expect(panCompositorOffset({ x: 95, y: -95, scale: 100 }, 50, -50)).toEqual({
            x: COMPOSITOR_OFFSET_LIMIT,
            y: -COMPOSITOR_OFFSET_LIMIT,
            scale: 100,
        });
    });

    test('tolerates non-finite deltas and raw offsets', () => {
        expect(panCompositorOffset(null, 'junk', 5)).toEqual({ x: 0, y: 5, scale: 100 });
    });
});

describe('zoomCompositorOffset', () => {
    test('adds scale-point deltas and clamps', () => {
        expect(zoomCompositorOffset({ x: 3, y: 4, scale: 100 }, 5)).toEqual({ x: 3, y: 4, scale: 105 });
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 195 }, 20)).toEqual({ x: 0, y: 0, scale: COMPOSITOR_SCALE_MAX });
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 55 }, -20)).toEqual({ x: 0, y: 0, scale: COMPOSITOR_SCALE_MIN });
    });
});

describe('pinchCompositorScale', () => {
    test('scales proportionally to the distance ratio', () => {
        expect(pinchCompositorScale(100, 100, 150)).toBe(150);
        expect(pinchCompositorScale(120, 200, 100)).toBe(60);
    });

    test('clamps to the scale range', () => {
        expect(pinchCompositorScale(150, 100, 400)).toBe(COMPOSITOR_SCALE_MAX);
        expect(pinchCompositorScale(80, 400, 50)).toBe(COMPOSITOR_SCALE_MIN);
    });

    test('degenerate distances keep the start scale', () => {
        expect(pinchCompositorScale(130, 0, 100)).toBe(130);
        expect(pinchCompositorScale(130, 100, 0)).toBe(130);
        expect(pinchCompositorScale(999, 0, 0)).toBe(COMPOSITOR_SCALE_MAX); // start clamped
    });
});

describe('hitTestCell', () => {
    const cells = [
        { x: 0, y: 0, w: 50, h: 50 },
        { x: 58, y: 0, w: 50, h: 50 },
        { x: 0, y: 58, w: 50, h: 50 },
    ];

    test('returns the index of the containing cell', () => {
        expect(hitTestCell(cells, 10, 10)).toBe(0);
        expect(hitTestCell(cells, 60, 10)).toBe(1);
        expect(hitTestCell(cells, 10, 60)).toBe(2);
    });

    test('returns -1 for gaps, outside points, and junk input', () => {
        expect(hitTestCell(cells, 54, 10)).toBe(-1); // in the 8px gap
        expect(hitTestCell(cells, 200, 10)).toBe(-1);
        expect(hitTestCell(cells, -5, 10)).toBe(-1);
        expect(hitTestCell(null, 10, 10)).toBe(-1);
        expect(hitTestCell(cells, 'x', 10)).toBe(-1);
    });

    test('cell edges: inclusive origin, exclusive far edge', () => {
        expect(hitTestCell(cells, 0, 0)).toBe(0);
        expect(hitTestCell(cells, 50, 0)).toBe(-1); // far edge of cell 0, gap before cell 1
    });
});
