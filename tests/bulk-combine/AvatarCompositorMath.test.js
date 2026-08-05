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
    computeCellMinScale,
    computeGridCells,
    computeLayoutCells,
    hitTestCell,
    normalizeCompositorLayout,
    normalizeCompositorOffset,
    normalizeCompositorOffsetWithFloor,
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
        // x clamps to +100% of cell.w; scale clamps UP to the contain floor
        // (100 for a matching-aspect image) → dw=100, centered (+0).
        expect(draw.dx).toBe(10 + 0 + COMPOSITOR_OFFSET_LIMIT);
        expect(draw.dw).toBe(100);
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

describe('normalizeCompositorLayout', () => {
    test('defaults junk input to the square grid with the default portrait aspect', () => {
        expect(normalizeCompositorLayout(undefined)).toEqual({ method: 'square', aspect: '3:4' });
        expect(normalizeCompositorLayout(null)).toEqual({ method: 'square', aspect: '3:4' });
        expect(normalizeCompositorLayout({})).toEqual({ method: 'square', aspect: '3:4' });
        expect(normalizeCompositorLayout('portrait')).toEqual({ method: 'square', aspect: '3:4' });
        expect(normalizeCompositorLayout({ method: 'mosaic' })).toEqual({ method: 'square', aspect: '3:4' });
    });

    test('passes through valid methods and aspects', () => {
        expect(normalizeCompositorLayout({ method: 'portrait', aspect: '2:3' })).toEqual({ method: 'portrait', aspect: '2:3' });
        expect(normalizeCompositorLayout({ method: 'best-fit', aspect: '9:16' })).toEqual({ method: 'best-fit', aspect: '9:16' });
    });

    test('unknown aspects fall back to the default (including prototype keys)', () => {
        expect(normalizeCompositorLayout({ method: 'portrait', aspect: '1:1' }).aspect).toBe('3:4');
        expect(normalizeCompositorLayout({ method: 'portrait', aspect: 'constructor' }).aspect).toBe('3:4');
        expect(normalizeCompositorLayout({ method: 'portrait', aspect: 'toString' }).aspect).toBe('3:4');
    });

    test('carries a valid gap, omits invalid ones', () => {
        expect(normalizeCompositorLayout({ gap: 4 })).toEqual({ method: 'square', aspect: '3:4', gap: 4 });
        expect(normalizeCompositorLayout({ gap: 0 })).toEqual({ method: 'square', aspect: '3:4', gap: 0 });
        expect(normalizeCompositorLayout({ gap: -1 })).toEqual({ method: 'square', aspect: '3:4' });
        expect(normalizeCompositorLayout({ gap: 'junk' })).toEqual({ method: 'square', aspect: '3:4' });
    });
});

describe('computeLayoutCells', () => {
    test('returns no cells for degenerate input', () => {
        expect(computeLayoutCells({ method: 'square' }, 0, 100)).toEqual([]);
        expect(computeLayoutCells({ method: 'portrait', aspect: '2:3' }, 2, 0)).toEqual([]);
        expect(computeLayoutCells({ method: 'best-fit' }, -3, 100, 0, [1, 1])).toEqual([]);
    });

    test('square layouts use the classic near-square grid', () => {
        expect(computeLayoutCells({ method: 'square' }, 5, 90, 0)).toEqual(computeGridCells(5, 90, 0));
        expect(computeLayoutCells(undefined, 3, 100, 8)).toEqual(computeGridCells(3, 100, 8));
        expect(computeLayoutCells({ method: 'junk' }, 4, 100, 8)).toEqual(computeGridCells(4, 100, 8));
    });

    test('a layout gap overrides the gap argument', () => {
        const cells = computeLayoutCells({ method: 'square', gap: 0 }, 2, 100, 8);
        expect(cells).toEqual([
            { x: 0, y: 0, w: 50, h: 100 },
            { x: 50, y: 0, w: 50, h: 100 },
        ]);
    });

    test('portrait 2:3: four sources form a 3×2 grid of exact 2:3 cells', () => {
        const cells = computeLayoutCells({ method: 'portrait', aspect: '2:3' }, 4, 120, 0);
        expect(cells).toHaveLength(4);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 40, h: 60 });
        expect(cells[2]).toEqual({ x: 80, y: 0, w: 40, h: 60 });
        expect(cells[3]).toEqual({ x: 0, y: 60, w: 40, h: 60 });
    });

    test('portrait 2:3: five sources still pick the exact 3×2 grid (one empty slot beats a stretched 5×1)', () => {
        const cells = computeLayoutCells({ method: 'portrait', aspect: '2:3' }, 5, 120, 0);
        expect(cells).toHaveLength(5);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 40, h: 60 });
        expect(cells[4]).toEqual({ x: 40, y: 60, w: 40, h: 60 });
    });

    test('portrait 9:16: six sources form a 4×2 grid (closest to 9:16)', () => {
        const cells = computeLayoutCells({ method: 'portrait', aspect: '9:16' }, 6, 120, 0);
        expect(cells).toHaveLength(6);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 30, h: 60 });
        expect(cells[3]).toEqual({ x: 90, y: 0, w: 30, h: 60 });
        expect(cells[5]).toEqual({ x: 30, y: 60, w: 30, h: 60 });
    });

    test('portrait 3:4: two sources form a 2×1 row of tall cells', () => {
        const cells = computeLayoutCells({ method: 'portrait', aspect: '3:4' }, 2, 100, 0);
        expect(cells).toEqual([
            { x: 0, y: 0, w: 50, h: 100 },
            { x: 50, y: 0, w: 50, h: 100 },
        ]);
    });

    test('portrait honors the gap (cells shrink and stay positive)', () => {
        const cells = computeLayoutCells({ method: 'portrait', aspect: '2:3', gap: 8 }, 4, 124);
        expect(cells).toHaveLength(4);
        expect(cells[0]).toEqual({ x: 0, y: 0, w: 36, h: 58 });
        expect(cells[3]).toEqual({ x: 0, y: 66, w: 36, h: 58 });

        const absurd = computeLayoutCells({ method: 'portrait', aspect: '2:3' }, 4, 100, 5000);
        expect(absurd).toHaveLength(4);
        for (const cell of absurd) {
            expect(cell.w).toBeGreaterThan(0);
            expect(cell.h).toBeGreaterThan(0);
        }
    });

    test('best-fit targets the geometric mean of the loaded image aspects', () => {
        // Two landscape (4.0) sources → 1 column × 2 rows of landscape cells.
        const landscape = computeLayoutCells({ method: 'best-fit' }, 2, 100, 0, [4, 4]);
        expect(landscape).toEqual([
            { x: 0, y: 0, w: 100, h: 50 },
            { x: 0, y: 50, w: 100, h: 50 },
        ]);

        // Two portrait (0.5) sources → 2 columns × 1 row of portrait cells.
        const portrait = computeLayoutCells({ method: 'best-fit' }, 2, 100, 0, [0.5, 0.5]);
        expect(portrait).toEqual([
            { x: 0, y: 0, w: 50, h: 100 },
            { x: 50, y: 0, w: 50, h: 100 },
        ]);

        // Mixed aspects averaging to 1 → the square-ish 2×2 grid.
        const mixed = computeLayoutCells({ method: 'best-fit' }, 3, 100, 0, [1, 0.5, 2]);
        expect(mixed).toEqual(computeGridCells(3, 100, 0));
    });

    test('best-fit ignores missing/unloaded entries and falls back to square when none are usable', () => {
        expect(computeLayoutCells({ method: 'best-fit' }, 3, 100, 0)).toEqual(computeGridCells(3, 100, 0));
        expect(computeLayoutCells({ method: 'best-fit' }, 3, 100, 0, [])).toEqual(computeGridCells(3, 100, 0));
        expect(computeLayoutCells({ method: 'best-fit' }, 3, 100, 0, [null, NaN, -5, 0, 'junk'])).toEqual(computeGridCells(3, 100, 0));

        // A single usable aspect still drives the search.
        const cells = computeLayoutCells({ method: 'best-fit' }, 3, 300, 0, [null, 0.5, undefined]);
        expect(cells).toHaveLength(3);
        expect(cells[0].w).toBeCloseTo(100, 5);
        expect(cells[0].h).toBe(300);
    });
});

describe('computeCellMinScale', () => {
    test('a matching-aspect image has a floor of 100 (contain == cover)', () => {
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 200, 200)).toBe(100);
        expect(computeCellMinScale({ x: 0, y: 0, w: 50, h: 100 }, 100, 200)).toBe(100);
    });

    test('a mismatched-aspect image gets the contain-fit percent', () => {
        // Portrait image in a square cell: fits at 50% of the cover scale.
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 100, 200)).toBe(50);
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 200, 100)).toBe(50);
        // Extreme landscape: 10%.
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 1000, 100)).toBe(10);
    });

    test('the floor is rounded UP so integer zoom steps never crop', () => {
        // Contain fit is 100·(1/3) ≈ 33.33 → ceil to 34.
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 300, 100)).toBe(34);
    });

    test('degenerate input falls back to the default floor', () => {
        expect(computeCellMinScale(null, 100, 100)).toBe(COMPOSITOR_SCALE_MIN);
        expect(computeCellMinScale({ x: 0, y: 0, w: 0, h: 100 }, 100, 100)).toBe(COMPOSITOR_SCALE_MIN);
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 0, 100)).toBe(COMPOSITOR_SCALE_MIN);
        expect(computeCellMinScale({ x: 0, y: 0, w: 100, h: 100 }, 'x', 100)).toBe(COMPOSITOR_SCALE_MIN);
    });
});

describe('computeCellCoverDraw with the per-cell contain floor', () => {
    const cell = { x: 10, y: 20, w: 100, h: 100 };

    test('an extreme-aspect image can zoom out to full containment (letterboxed)', () => {
        // 1000×100 in a 100×100 cell: floor = 10 → scale 10 exactly contains
        // the image: dw=100, dh=10, vertically centered.
        expect(computeCellCoverDraw(cell, 1000, 100, { x: 0, y: 0, scale: 10 })).toEqual({
            dx: 10,
            dy: 65,
            dw: 100,
            dh: 10,
        });
    });

    test('a scale below the floor clamps UP to it', () => {
        const atFloor = computeCellCoverDraw(cell, 1000, 100, { x: 0, y: 0, scale: 10 });
        expect(computeCellCoverDraw(cell, 1000, 100, { x: 0, y: 0, scale: 1 })).toEqual(atFloor);
    });

    test('a matching-aspect image can no longer zoom below its (100) floor', () => {
        const atFloor = computeCellCoverDraw(cell, 200, 200, { x: 0, y: 0, scale: 100 });
        expect(computeCellCoverDraw(cell, 200, 200, { x: 0, y: 0, scale: 50 })).toEqual(atFloor);
    });
});

describe('normalizeCompositorOffsetWithFloor', () => {
    test('defaults to the fixed minimum (matches normalizeCompositorOffset)', () => {
        expect(normalizeCompositorOffsetWithFloor({ x: 5, y: -5, scale: 10 })).toEqual({ x: 5, y: -5, scale: COMPOSITOR_SCALE_MIN });
        expect(normalizeCompositorOffsetWithFloor({ x: 5, y: -5, scale: 10 }, 'junk')).toEqual({ x: 5, y: -5, scale: COMPOSITOR_SCALE_MIN });
        expect(normalizeCompositorOffsetWithFloor({ x: 5, y: -5, scale: 10 }, -3)).toEqual({ x: 5, y: -5, scale: COMPOSITOR_SCALE_MIN });
    });

    test('clamps to the given per-cell floor', () => {
        expect(normalizeCompositorOffsetWithFloor({ x: 0, y: 0, scale: 5 }, 20)).toEqual({ x: 0, y: 0, scale: 20 });
        expect(normalizeCompositorOffsetWithFloor({ x: 0, y: 0, scale: 150 }, 20)).toEqual({ x: 0, y: 0, scale: 150 });
        expect(normalizeCompositorOffsetWithFloor({ x: 0, y: 0, scale: 500 }, 20)).toEqual({ x: 0, y: 0, scale: COMPOSITOR_SCALE_MAX });
        expect(normalizeCompositorOffsetWithFloor(null, 20)).toEqual({ x: 0, y: 0, scale: 100 });
    });
});

describe('offset round-trip (sub-50 scales survive construction)', () => {
    test('normalizeCompositorOffsets preserves a persisted zoomed-out scale below 50', () => {
        expect(normalizeCompositorOffsets([{ x: 3, y: -4, scale: 12 }], 1)).toEqual([{ x: 3, y: -4, scale: 12 }]);
    });

    test('construction still sanitizes garbage scales (without clamping to 50)', () => {
        expect(normalizeCompositorOffsets([{ scale: 500 }], 1)[0].scale).toBe(COMPOSITOR_SCALE_MAX);
        expect(normalizeCompositorOffsets([{ scale: 'junk' }], 1)[0].scale).toBe(100);
        expect(normalizeCompositorOffsets([{ scale: 0 }], 1)[0].scale).toBe(1);
        expect(normalizeCompositorOffsets([{ scale: -9 }], 1)[0].scale).toBe(1);
    });
});

describe('floor-aware pan/zoom/pinch', () => {
    test('zoom reaches the per-cell floor and no further', () => {
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 100 }, -95, 10)).toEqual({ x: 0, y: 0, scale: 10 });
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 30 }, -50, 25)).toEqual({ x: 0, y: 0, scale: 25 });
    });

    test('zoom without a floor keeps the fixed minimum', () => {
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 100 }, -95)).toEqual({ x: 0, y: 0, scale: COMPOSITOR_SCALE_MIN });
        expect(zoomCompositorOffset({ x: 0, y: 0, scale: 100 }, -95, 'junk')).toEqual({ x: 0, y: 0, scale: COMPOSITOR_SCALE_MIN });
    });

    test('pinch clamps to the per-cell floor', () => {
        expect(pinchCompositorScale(80, 400, 50, 20)).toBe(20);
        expect(pinchCompositorScale(80, 400, 50)).toBe(COMPOSITOR_SCALE_MIN);
        expect(pinchCompositorScale(80, 400, 50, 'junk')).toBe(COMPOSITOR_SCALE_MIN);
    });

    test('pan preserves the scale but re-clamps it against the floor', () => {
        // A persisted sub-floor scale is lifted on the next interaction.
        expect(panCompositorOffset({ x: 0, y: 0, scale: 12 }, 5, -5, 30)).toEqual({ x: 5, y: -5, scale: 30 });
        expect(panCompositorOffset({ x: 0, y: 0, scale: 40 }, 1, 1, 30)).toEqual({ x: 1, y: 1, scale: 40 });
    });
});
