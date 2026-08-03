const MULTIPLIER_STEP = 0.05;
const SEARCH_ITERATIONS = 24;
const EPSILON = 1e-9;

/**
 * Pack rectangles into a bin using MaxRects-BSSF.
 * @param {Array<{w:number,h:number}>} items - native sizes
 * @param {number} binWidth - canvas width
 * @param {number} binHeight - canvas height
 * @param {number} gap - pixels between cells
 * @param {{min:number,max:number}} scaleRange - per-item multiplier range
 * @returns {Array<{x:number,y:number,w:number,h:number,index:number,scale:number}>|null} placements or null if impossible
 */
export function packRectangles(items, binWidth, binHeight, gap, scaleRange) {
    if (!Array.isArray(items)) {
        return null;
    }

    if (items.length === 0) {
        return [];
    }

    const normalizedBinWidth = normalizeBinDimension(binWidth);
    const normalizedBinHeight = normalizeBinDimension(binHeight);

    if (normalizedBinWidth <= 0 || normalizedBinHeight <= 0) {
        return null;
    }

    const normalizedGap = normalizeGap(gap);
    const normalizedScaleRange = normalizeScaleRange(scaleRange);

    if (!normalizedScaleRange) {
        return null;
    }

    const normalizedItems = items.map((item, index) => {
        const w = normalizeItemDimension(item?.w);
        const h = normalizeItemDimension(item?.h);

        return {
            w,
            h,
            area: w * h,
            index,
        };
    });

    const sortedItems = normalizedItems
        .slice()
        .sort((a, b) => b.area - a.area || a.index - b.index);
    const averageArea = normalizedItems.reduce((sum, item) => sum + item.area, 0) / normalizedItems.length;
    const estimate = Math.sqrt((normalizedBinWidth * normalizedBinHeight) / (normalizedItems.length * averageArea));
    const low = estimate * 0.1;
    let min = low;
    let max = estimate * 3;
    let bestPlacements = null;
    const multipliers = buildMultipliers(normalizedScaleRange.min, normalizedScaleRange.max);

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
        const baseScale = (min + max) / 2;
        const placements = tryPack(sortedItems, normalizedBinWidth, normalizedBinHeight, normalizedGap, baseScale, multipliers);

        if (placements) {
            bestPlacements = placements;
            min = baseScale;
        } else {
            max = baseScale;
        }
    }

    if (bestPlacements) {
        return bestPlacements;
    }

    return tryPack(sortedItems, normalizedBinWidth, normalizedBinHeight, normalizedGap, low, [normalizedScaleRange.min]);
}

function tryPack(items, binWidth, binHeight, gap, baseScale, multipliers) {
    const freeRects = [{ x: 0, y: 0, w: binWidth + gap, h: binHeight + gap }];
    const placements = [];

    for (const item of items) {
        const placement = findPlacement(item, freeRects, gap, baseScale, multipliers);

        if (!placement) {
            return null;
        }

        placements.push({
            x: placement.x,
            y: placement.y,
            w: placement.contentW,
            h: placement.contentH,
            index: item.index,
            scale: placement.multiplier,
        });

        splitFreeRects(freeRects, {
            x: placement.x,
            y: placement.y,
            w: placement.packW,
            h: placement.packH,
        });
    }

    return placements.sort((a, b) => a.index - b.index);
}

function findPlacement(item, freeRects, gap, baseScale, multipliers) {
    for (const multiplier of multipliers) {
        const contentW = Math.max(1, Math.round(item.w * baseScale * multiplier));
        const contentH = Math.max(1, Math.round(item.h * baseScale * multiplier));
        const packW = contentW + gap;
        const packH = contentH + gap;
        let best = null;

        for (const freeRect of freeRects) {
            if (packW > freeRect.w || packH > freeRect.h) {
                continue;
            }

            const leftoverW = freeRect.w - packW;
            const leftoverH = freeRect.h - packH;
            const shortSideFit = Math.min(leftoverW, leftoverH);
            const areaFit = freeRect.w * freeRect.h - packW * packH;

            if (
                !best
                || shortSideFit < best.shortSideFit
                || (shortSideFit === best.shortSideFit && areaFit < best.areaFit)
            ) {
                best = {
                    x: freeRect.x,
                    y: freeRect.y,
                    contentW,
                    contentH,
                    packW,
                    packH,
                    multiplier,
                    shortSideFit,
                    areaFit,
                };
            }
        }

        if (best) {
            return best;
        }
    }

    return null;
}

function splitFreeRects(freeRects, usedRect) {
    for (let i = 0; i < freeRects.length; i++) {
        const freeRect = freeRects[i];

        if (!intersects(freeRect, usedRect)) {
            continue;
        }

        const splitRects = [];

        if (usedRect.x < freeRect.x + freeRect.w && usedRect.x + usedRect.w > freeRect.x) {
            if (usedRect.y > freeRect.y && usedRect.y < freeRect.y + freeRect.h) {
                splitRects.push({
                    x: freeRect.x,
                    y: freeRect.y,
                    w: freeRect.w,
                    h: usedRect.y - freeRect.y,
                });
            }

            if (usedRect.y + usedRect.h < freeRect.y + freeRect.h) {
                splitRects.push({
                    x: freeRect.x,
                    y: usedRect.y + usedRect.h,
                    w: freeRect.w,
                    h: freeRect.y + freeRect.h - (usedRect.y + usedRect.h),
                });
            }
        }

        if (usedRect.y < freeRect.y + freeRect.h && usedRect.y + usedRect.h > freeRect.y) {
            if (usedRect.x > freeRect.x && usedRect.x < freeRect.x + freeRect.w) {
                splitRects.push({
                    x: freeRect.x,
                    y: freeRect.y,
                    w: usedRect.x - freeRect.x,
                    h: freeRect.h,
                });
            }

            if (usedRect.x + usedRect.w < freeRect.x + freeRect.w) {
                splitRects.push({
                    x: usedRect.x + usedRect.w,
                    y: freeRect.y,
                    w: freeRect.x + freeRect.w - (usedRect.x + usedRect.w),
                    h: freeRect.h,
                });
            }
        }

        freeRects.splice(i, 1, ...splitRects.filter((rect) => rect.w > 0 && rect.h > 0));
        i += splitRects.length - 1;
    }

    pruneFreeRects(freeRects);
}

function pruneFreeRects(freeRects) {
    for (let i = 0; i < freeRects.length; i++) {
        for (let j = i + 1; j < freeRects.length; j++) {
            if (contains(freeRects[i], freeRects[j])) {
                freeRects.splice(j, 1);
                j--;
            } else if (contains(freeRects[j], freeRects[i])) {
                freeRects.splice(i, 1);
                i--;
                break;
            }
        }
    }
}

function intersects(a, b) {
    return a.x < b.x + b.w
        && a.x + a.w > b.x
        && a.y < b.y + b.h
        && a.y + a.h > b.y;
}

function contains(a, b) {
    return b.x >= a.x
        && b.y >= a.y
        && b.x + b.w <= a.x + a.w
        && b.y + b.h <= a.y + a.h;
}

function buildMultipliers(min, max) {
    const multipliers = [];

    for (let value = max; value >= min - EPSILON; value -= MULTIPLIER_STEP) {
        multipliers.push(roundMultiplier(Math.max(value, min)));
    }

    const normalizedMin = roundMultiplier(min);

    if (multipliers[multipliers.length - 1] !== normalizedMin) {
        multipliers.push(normalizedMin);
    }

    return [...new Set(multipliers)];
}

function roundMultiplier(value) {
    return Number(value.toFixed(6));
}

function normalizeBinDimension(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeGap(value) {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function normalizeItemDimension(value) {
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function normalizeScaleRange(scaleRange) {
    if (!scaleRange || !Number.isFinite(scaleRange.min) || !Number.isFinite(scaleRange.max)) {
        return null;
    }

    const min = Math.max(0, scaleRange.min);
    const max = Math.max(0, scaleRange.max);

    if (min <= 0 || max < min) {
        return null;
    }

    return { min, max };
}
