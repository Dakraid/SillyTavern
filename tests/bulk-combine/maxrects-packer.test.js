'use strict';

import { describe, expect, it } from '@jest/globals';

import { packRectangles } from '../../src/util/maxrects-packer.js';

const DEFAULT_SCALE_RANGE = { min: 0.8, max: 1.2 };
const EPSILON = 1e-9;

function expectPlacementShape(placement) {
    expect(placement).toEqual(expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        w: expect.any(Number),
        h: expect.any(Number),
        index: expect.any(Number),
        scale: expect.any(Number),
    }));
}

function expectWithinBounds(placements, binWidth, binHeight) {
    for (const placement of placements) {
        expect(placement.x).toBeGreaterThanOrEqual(0);
        expect(placement.y).toBeGreaterThanOrEqual(0);
        expect(placement.w).toBeGreaterThan(0);
        expect(placement.h).toBeGreaterThan(0);
        expect(placement.x + placement.w).toBeLessThanOrEqual(binWidth);
        expect(placement.y + placement.h).toBeLessThanOrEqual(binHeight);
    }
}

function hasRequiredGap(a, b, gap) {
    return a.x + a.w + gap <= b.x + EPSILON
        || b.x + b.w + gap <= a.x + EPSILON
        || a.y + a.h + gap <= b.y + EPSILON
        || b.y + b.h + gap <= a.y + EPSILON;
}

function expectNoOverlapWithGap(placements, gap) {
    for (let i = 0; i < placements.length; i++) {
        for (let j = i + 1; j < placements.length; j++) {
            expect(hasRequiredGap(placements[i], placements[j], gap)).toBe(true);
        }
    }
}

describe('packRectangles', () => {
    it('packs a single item within bounds with all required fields', () => {
        const placements = packRectangles(
            [{ w: 120, h: 80 }],
            500,
            400,
            4,
            DEFAULT_SCALE_RANGE,
        );

        expect(placements).toHaveLength(1);
        expectPlacementShape(placements[0]);
        expect(placements[0].index).toBe(0);
        expectWithinBounds(placements, 500, 400);
    });

    it('packs multiple varying items with no overlap accounting for gap', () => {
        const gap = 8;
        const placements = packRectangles(
            [
                { w: 100, h: 80 },
                { w: 90, h: 110 },
                { w: 160, h: 60 },
                { w: 70, h: 140 },
                { w: 120, h: 120 },
                { w: 180, h: 90 },
            ],
            900,
            650,
            gap,
            DEFAULT_SCALE_RANGE,
        );

        expect(placements).toHaveLength(6);
        expectWithinBounds(placements, 900, 650);
        expectNoOverlapWithGap(placements, gap);
    });

    it('enforces each item scale and max scale delta within the scale range', () => {
        const scaleRange = { min: 0.8, max: 1.2 };
        const placements = packRectangles(
            [
                { w: 100, h: 80 },
                { w: 90, h: 110 },
                { w: 160, h: 60 },
                { w: 70, h: 140 },
                { w: 120, h: 120 },
            ],
            800,
            600,
            8,
            scaleRange,
        );

        expect(placements).toHaveLength(5);

        const scales = placements.map((placement) => placement.scale);
        for (const scale of scales) {
            expect(scale).toBeGreaterThanOrEqual(scaleRange.min);
            expect(scale).toBeLessThanOrEqual(scaleRange.max);
        }

        expect(Math.max(...scales) - Math.min(...scales)).toBeLessThanOrEqual(0.4);
    });

    it('returns null when items cannot fit the canvas', () => {
        const placements = packRectangles(
            [
                { w: 10000, h: 1 },
                { w: 10000, h: 1 },
            ],
            100,
            100,
            0,
            DEFAULT_SCALE_RANGE,
        );

        expect(placements).toBeNull();
    });

    it('keeps all items within canvas bounds', () => {
        const placements = packRectangles(
            [
                { w: 160, h: 90 },
                { w: 90, h: 160 },
                { w: 120, h: 120 },
                { w: 200, h: 100 },
                { w: 100, h: 200 },
            ],
            900,
            650,
            6,
            DEFAULT_SCALE_RANGE,
        );

        expect(placements).toHaveLength(5);
        expectWithinBounds(placements, 900, 650);
    });

    it('returns an empty array for empty items', () => {
        expect(packRectangles([], 500, 500, 2, DEFAULT_SCALE_RANGE)).toEqual([]);
    });

    it('respects the configured gap between packed cells', () => {
        const gap = 20;
        const placements = packRectangles(
            [
                { w: 100, h: 100 },
                { w: 100, h: 100 },
                { w: 100, h: 100 },
            ],
            760,
            260,
            gap,
            { min: 1, max: 1 },
        );

        expect(placements).toHaveLength(3);
        expectNoOverlapWithGap(placements, gap);
    });

    it('preserves each item aspect ratio within integer rounding tolerance', () => {
        const items = [
            { w: 160, h: 90 },
            { w: 90, h: 160 },
            { w: 120, h: 120 },
            { w: 200, h: 100 },
            { w: 100, h: 200 },
        ];
        const placements = packRectangles(items, 900, 650, 6, DEFAULT_SCALE_RANGE);

        expect(placements).toHaveLength(items.length);

        for (const placement of placements) {
            const item = items[placement.index];
            const widthScale = placement.w / item.w;
            const heightScale = placement.h / item.h;
            const roundingTolerance = (0.5 / item.w) + (0.5 / item.h) + EPSILON;

            expect(Math.abs(widthScale - heightScale)).toBeLessThanOrEqual(roundingTolerance);
        }
    });

    it('packs portrait, landscape, and square items together', () => {
        const gap = 6;
        const placements = packRectangles(
            [
                { w: 90, h: 180 },
                { w: 220, h: 90 },
                { w: 140, h: 140 },
                { w: 80, h: 200 },
                { w: 260, h: 100 },
                { w: 120, h: 120 },
            ],
            900,
            650,
            gap,
            DEFAULT_SCALE_RANGE,
        );

        expect(placements).toHaveLength(6);
        expectWithinBounds(placements, 900, 650);
        expectNoOverlapWithGap(placements, gap);
    });

    it('returns placements sorted by original item index', () => {
        const items = [
            { w: 60, h: 200 },
            { w: 220, h: 80 },
            { w: 100, h: 100 },
            { w: 80, h: 160 },
        ];
        const placements = packRectangles(items, 700, 500, 4, DEFAULT_SCALE_RANGE);

        expect(placements).toHaveLength(items.length);
        for (let i = 0; i < placements.length; i++) {
            expect(placements[i].index).toBe(i);
        }
    });
});
