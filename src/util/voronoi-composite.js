import { Delaunay } from 'd3-delaunay';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import { packRectangles } from './maxrects-packer.js';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1536;
const DEFAULT_CROP_STRATEGY = 'attention';
const DEFAULT_CROP_PADDING = 15;
const MAX_CROP_PADDING = 50;
const CROP_STRATEGIES = new Set([
    'attention',
    'entropy',
    'center',
    'top',
    'face',
]);
const GRID_ALIGNS = new Set([
    'center',
    'start',
    'end',
    'space-between',
    'space-around',
    'space-evenly',
]);
const GRID_VALIGNS = new Set(['center', 'start', 'end']);
const GRID_DIRECTIONS = new Set([
    'row',
    'column',
    'row-reverse',
    'column-reverse',
]);
const CELL_FITS = new Set(['cover', 'contain']);
const SEED_CANDIDATES = 10;
const BORDER_COLOR = { r: 20, g: 20, b: 20, a: 255 };
const BORDER_RADIUS = 1;

/**
 * Generate a Voronoi mosaic composite from character avatar images.
 * @param {string[]} avatarPaths Absolute paths to character avatar PNGs.
 * @param {string} outputPath Where to write the composite PNG.
 * @param {{width?: number, height?: number, cropStrategy?: string, cropPadding?: number, offsets?: Array<{x?: number, y?: number, scale?: number}>, seed?: number}} options Output dimensions, crop options, per-avatar offsets, and optional seed.
 * @returns {Promise<{path: string, cells: Array<{type: string, points: Array<[number, number]>}>}>} The output path and Voronoi cells.
 */
export async function generateVoronoiComposite(
    avatarPaths,
    outputPath,
    options = {},
) {
    if (!Array.isArray(avatarPaths)) {
        throw new TypeError('avatarPaths must be an array');
    }

    if (!avatarPaths.length) {
        throw new Error('At least one avatar path is required');
    }

    if (!outputPath || typeof outputPath !== 'string') {
        throw new TypeError('outputPath must be a string');
    }

    const width =
        typeof options.width === 'number' &&
        Number.isFinite(options.width) &&
        options.width > 0
            ? Math.round(options.width)
            : DEFAULT_WIDTH;
    const height =
        typeof options.height === 'number' &&
        Number.isFinite(options.height) &&
        options.height > 0
            ? Math.round(options.height)
            : DEFAULT_HEIGHT;
    const cropOptions = normalizeCropOptions(options);
    const offsets = normalizeOffsets(options.offsets, avatarPaths.length);
    const seed =
        typeof options.seed === 'number' && Number.isFinite(options.seed)
            ? Math.round(options.seed)
            : null;

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (avatarPaths.length === 1) {
        const buffer = await readAvatarBuffer(
            avatarPaths[0],
            width,
            height,
            cropOptions,
        );
        const offsetBuffer = await applyAvatarOffset(
            buffer,
            width,
            height,
            offsets[0],
        );
        await sharp(offsetBuffer).png().toFile(outputPath);
        return {
            path: outputPath,
            cells: [
                {
                    type: 'polygon',
                    points: [
                        [0, 0],
                        [width, 0],
                        [width, height],
                        [0, height],
                    ],
                },
            ],
        };
    }

    const points = generateSeedPoints(avatarPaths.length, width, height, seed);
    const delaunay = Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, width, height]);
    /** @type {Array<Array<[number, number]>>} */
    const polygons = [];
    /** @type {Array<{type: string, points: Array<[number, number]>}>} */
    const cells = [];
    /** @type {Array<{ input: Buffer, blend: 'over' }>} */
    const composites = [];

    for (let i = 0; i < avatarPaths.length; i++) {
        const polygon = voronoi.cellPolygon(i);
        if (!polygon || polygon.length < 3) {
            continue;
        }

        /** @type {Array<[number, number]>} */
        const normalizedPolygon = polygon.map((point) => [point[0], point[1]]);
        polygons.push(normalizedPolygon);
        cells.push({ type: 'polygon', points: normalizedPolygon });

        const imageBuffer = await readAvatarBuffer(
            avatarPaths[i],
            width,
            height,
            cropOptions,
        );
        const offsetImageBuffer = await applyAvatarOffset(
            imageBuffer,
            width,
            height,
            offsets[i],
        );
        const maskBuffer = Buffer.from(
            createSvgPolygonMask(width, height, normalizedPolygon),
        );
        const maskedCell = await sharp(offsetImageBuffer)
            .composite([{ input: maskBuffer, blend: 'dest-in' }])
            .png()
            .toBuffer();

        composites.push({ input: maskedCell, blend: 'over' });
    }

    if (polygons.length) {
        composites.push({
            input: Buffer.from(
                createBordersSvg(
                    width,
                    height,
                    polygons,
                    BORDER_COLOR,
                    BORDER_RADIUS * 2,
                ),
            ),
            blend: 'over',
        });
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
        },
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return { path: outputPath, cells };
}

/**
 * Generate a grid-based composite from character avatar images.
 * @param {string[]} avatarPaths Absolute paths to character avatar PNGs.
 * @param {string} outputPath Where to write the composite PNG.
 * @param {{width?: number, height?: number, cellAspect?: number|string, gap?: number, maxCols?: number, cropStrategy?: string, cropPadding?: number, offsets?: Array<{x?: number, y?: number, scale?: number}>, gridAlign?: string, gridVAlign?: string, gridDirection?: string, cellFit?: string}} options
 * @returns {Promise<{path: string, cells: Array<{type: string, x: number, y: number, w: number, h: number}>}>}
 */
export async function generateGridComposite(
    avatarPaths,
    outputPath,
    options = {},
) {
    if (!Array.isArray(avatarPaths)) {
        throw new TypeError('avatarPaths must be an array');
    }

    if (!avatarPaths.length) {
        throw new Error('At least one avatar path is required');
    }

    if (!outputPath || typeof outputPath !== 'string') {
        throw new TypeError('outputPath must be a string');
    }

    const width =
        typeof options.width === 'number' &&
        Number.isFinite(options.width) &&
        options.width > 0
            ? Math.round(options.width)
            : DEFAULT_WIDTH;
    const height =
        typeof options.height === 'number' &&
        Number.isFinite(options.height) &&
        options.height > 0
            ? Math.round(options.height)
            : DEFAULT_HEIGHT;
    const cropOptions = normalizeCropOptions(options);
    const offsets = normalizeOffsets(options.offsets, avatarPaths.length);
    const cellAspect = normalizeCellAspect(options.cellAspect);
    const gap = normalizeGap(options.gap);
    const maxCols = typeof options.maxCols === 'number' &&
        Number.isFinite(options.maxCols) &&
        options.maxCols > 0
        ? Math.round(options.maxCols)
        : 0;
    const minCols = typeof options.minCols === 'number' &&
        Number.isFinite(options.minCols) &&
        options.minCols > 0
        ? Math.round(options.minCols)
        : 0;
    const colsMaxBound = typeof options.colsMaxBound === 'number' &&
        Number.isFinite(options.colsMaxBound) &&
        options.colsMaxBound > 0
        ? Math.round(options.colsMaxBound)
        : 0;
    const gridAlign = GRID_ALIGNS.has(options.gridAlign)
        ? options.gridAlign
        : 'center';
    const gridVAlign = GRID_VALIGNS.has(options.gridVAlign)
        ? options.gridVAlign
        : 'center';
    const gridDirection = GRID_DIRECTIONS.has(options.gridDirection)
        ? options.gridDirection
        : 'row';
    const cellFit = CELL_FITS.has(options.cellFit) ? options.cellFit : 'cover';
    const grid = calculateGrid(
        avatarPaths.length,
        width / height / cellAspect,
        maxCols,
        minCols,
        colsMaxBound,
    );
    const availableWidth = width - gap * (grid.cols - 1);
    const availableHeight = height - gap * (grid.rows - 1);
    const slotWidth = availableWidth / grid.cols;
    const slotHeight = availableHeight / grid.rows;
    let cellWidth;
    let cellHeight;

    if (slotWidth / slotHeight > cellAspect) {
        cellHeight = Math.max(1, Math.floor(slotHeight));
        cellWidth = Math.max(1, Math.floor(cellHeight * cellAspect));
    } else {
        cellWidth = Math.max(1, Math.floor(slotWidth));
        cellHeight = Math.max(1, Math.floor(cellWidth / cellAspect));
    }

    let actualGap = gap;
    let startX;
    const totalGridWidth = cellWidth * grid.cols + gap * (grid.cols - 1);
    const totalGridHeight = cellHeight * grid.rows + gap * (grid.rows - 1);

    if (gridAlign === 'space-between' && grid.cols > 1) {
        actualGap = (width - cellWidth * grid.cols) / (grid.cols - 1);
        startX = 0;
    } else if (gridAlign === 'space-around' && grid.cols > 0) {
        actualGap = (width - cellWidth * grid.cols) / grid.cols;
        startX = actualGap / 2;
    } else if (gridAlign === 'space-evenly' && grid.cols > 0) {
        actualGap = (width - cellWidth * grid.cols) / (grid.cols + 1);
        startX = actualGap;
    } else if (gridAlign === 'start') {
        startX = 0;
    } else if (gridAlign === 'end') {
        startX = width - totalGridWidth;
    } else {
        startX = Math.floor((width - totalGridWidth) / 2);
    }

    let startY;
    if (gridVAlign === 'start') {
        startY = 0;
    } else if (gridVAlign === 'end') {
        startY = height - totalGridHeight;
    } else {
        startY = Math.floor((height - totalGridHeight) / 2);
    }

    const gridCropOptions = { ...cropOptions, cellFit };
    /** @type {Array<{ input: Buffer, left: number, top: number, blend: 'over' }>} */
    const composites = [];
    /** @type {Array<{type: string, x: number, y: number, w: number, h: number}>} */
    const cells = [];

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    for (let i = 0; i < avatarPaths.length; i++) {
        let col;
        let row;
        if (gridDirection === 'column') {
            col = Math.floor(i / grid.rows);
            row = i % grid.rows;
        } else if (gridDirection === 'row-reverse') {
            col = grid.cols - 1 - (i % grid.cols);
            row = Math.floor(i / grid.cols);
        } else if (gridDirection === 'column-reverse') {
            col = Math.floor(i / grid.rows);
            row = grid.rows - 1 - (i % grid.rows);
        } else {
            col = i % grid.cols;
            row = Math.floor(i / grid.cols);
        }

        const x = Math.round(startX + col * (cellWidth + actualGap));
        const y = Math.round(startY + row * (cellHeight + gap));
        const imageBuffer = await readAvatarBuffer(
            avatarPaths[i],
            cellWidth,
            cellHeight,
            gridCropOptions,
        );
        const offsetImageBuffer = await applyAvatarOffset(
            imageBuffer,
            cellWidth,
            cellHeight,
            offsets[i],
        );

        composites.push({
            input: offsetImageBuffer,
            left: x,
            top: y,
            blend: 'over',
        });
        cells.push({ type: 'rect', x, y, w: cellWidth, h: cellHeight });
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
        },
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return { path: outputPath, cells };
}

/**
 * Generate a best-fit mosaic composite from character avatar images.
 * @param {string[]} avatarPaths Absolute paths to character avatar PNGs.
 * @param {string} outputPath Where to write the composite PNG.
 * @param {{width?: number, height?: number, gap?: number, cropStrategy?: string, cropPadding?: number, offsets?: Array<{x?: number, y?: number, scale?: number}>, scaleMin?: number, scaleMax?: number}} options
 * @returns {Promise<{path: string, cells: Array<{type: string, x: number, y: number, w: number, h: number}>}>}
 */
export async function generateMosaicComposite(
    avatarPaths,
    outputPath,
    options = {},
) {
    if (!Array.isArray(avatarPaths)) {
        throw new TypeError('avatarPaths must be an array');
    }

    if (!avatarPaths.length) {
        throw new Error('At least one avatar path is required');
    }

    if (!outputPath || typeof outputPath !== 'string') {
        throw new TypeError('outputPath must be a string');
    }

    const width =
        typeof options.width === 'number' &&
        Number.isFinite(options.width) &&
        options.width > 0
            ? Math.round(options.width)
            : DEFAULT_WIDTH;
    const height =
        typeof options.height === 'number' &&
        Number.isFinite(options.height) &&
        options.height > 0
            ? Math.round(options.height)
            : DEFAULT_HEIGHT;
    const cropOptions = normalizeCropOptions(options);
    const offsets = normalizeOffsets(options.offsets, avatarPaths.length);
    const gap = normalizeGap(options.gap);
    const scaleMin = normalizeScale(options.scaleMin, 0.8);
    const scaleMax = Math.max(scaleMin, normalizeScale(options.scaleMax, 1.2));

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (avatarPaths.length === 1) {
        const imageBuffer = await readAvatarBuffer(
            avatarPaths[0],
            width,
            height,
            cropOptions,
        );
        const offsetImageBuffer = await applyAvatarOffset(
            imageBuffer,
            width,
            height,
            offsets[0],
        );
        await sharp(offsetImageBuffer).png().toFile(outputPath);
        return {
            path: outputPath,
            cells: [{ type: 'rect', x: 0, y: 0, w: width, h: height }],
        };
    }

    const REFERENCE_SIZE = 256;
    const nativeDims = avatarPaths.map(() => ({ w: REFERENCE_SIZE, h: REFERENCE_SIZE }));
    const placements = packRectangles(nativeDims, width, height, gap, {
        min: scaleMin,
        max: scaleMax,
    });

    if (!placements) {
        throw new Error('Cannot fit avatars into canvas');
    }

    /** @type {Array<{ input: Buffer, left: number, top: number, blend: 'over' }>} */
    const composites = [];
    /** @type {Array<{type: string, x: number, y: number, w: number, h: number}>} */
    const cells = [];

    for (const placement of placements) {
        const imageBuffer = await readAvatarBuffer(
            avatarPaths[placement.index],
            placement.w,
            placement.h,
            cropOptions,
        );
        const offsetImageBuffer = await applyAvatarOffset(
            imageBuffer,
            placement.w,
            placement.h,
            offsets[placement.index],
        );

        composites.push({
            input: offsetImageBuffer,
            left: placement.x,
            top: placement.y,
            blend: 'over',
        });
        cells.push({
            type: 'rect',
            x: placement.x,
            y: placement.y,
            w: placement.w,
            h: placement.h,
        });
    }

    await sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 1 },
        },
    })
        .composite(composites)
        .png()
        .toFile(outputPath);

    return { path: outputPath, cells };
}

async function readAvatarBuffer(avatarPath, width, height, cropOptions = {}) {
    try {
        return await createAvatarBuffer(avatarPath, width, height, cropOptions);
    } catch {
        const fallbackPath = path.isAbsolute(DEFAULT_AVATAR_PATH)
            ? DEFAULT_AVATAR_PATH
            : path.resolve(DEFAULT_AVATAR_PATH);
        return await createAvatarBuffer(fallbackPath, width, height, cropOptions);
    }
}

async function createAvatarBuffer(avatarPath, width, height, cropOptions = {}) {
    const { cropStrategy, cropPadding, cellFit } = normalizeCropOptions(cropOptions);

    if (cropStrategy === 'face' && cellFit !== 'contain') {
        return createHeuristicFaceCropBuffer(
            avatarPath,
            width,
            height,
            cropPadding,
        );
    }

    return sharp(avatarPath)
        .resize(width, height, {
            fit: cellFit === 'contain' ? 'contain' : 'cover',
            position: getSharpCropPosition(cropStrategy),
            background: { r: 0, g: 0, b: 0, alpha: 1 },
        })
        .png()
        .toBuffer();
}

function normalizeCropOptions(options = {}) {
    const cropStrategy = CROP_STRATEGIES.has(options.cropStrategy)
        ? options.cropStrategy
        : DEFAULT_CROP_STRATEGY;
    const cropPadding =
        typeof options.cropPadding === 'number' &&
        Number.isFinite(options.cropPadding) &&
        options.cropPadding >= 0 &&
        options.cropPadding <= MAX_CROP_PADDING
            ? options.cropPadding
            : DEFAULT_CROP_PADDING;

    const cellFit = CELL_FITS.has(options.cellFit) ? options.cellFit : 'cover';

    return { cropStrategy, cropPadding, cellFit };
}

function normalizeOffsets(offsets, count) {
    return Array.from({ length: count }, (_, index) =>
        normalizeOffset(Array.isArray(offsets) ? offsets[index] : null),
    );
}

function normalizeOffset(offset) {
    const x = Number(offset?.x);
    const y = Number(offset?.y);
    const scale = Number(offset?.scale);

    return {
        x: Number.isFinite(x) ? clamp(Math.round(x), -1000, 1000) : 0,
        y: Number.isFinite(y) ? clamp(Math.round(y), -1000, 1000) : 0,
        scale: Number.isFinite(scale) ? clamp(Math.round(scale), 50, 200) : 100,
    };
}

function normalizeCellAspect(cellAspect) {
    if (cellAspect === 'grid-square') {
        return 1;
    }

    if (cellAspect === 'grid-portrait') {
        return 9 / 16;
    }

    return typeof cellAspect === 'number' &&
        Number.isFinite(cellAspect) &&
        cellAspect > 0
        ? cellAspect
        : 9 / 16;
}

function normalizeGap(gap) {
    const value = typeof gap === 'number' ? gap : Number(gap);

    return Number.isFinite(value) ? clamp(Math.round(value), 0, 10) : 2;
}

function normalizeScale(value, fallback) {
    const number = typeof value === 'number' ? value : Number(value);

    return Number.isFinite(number) ? clamp(number, 0.1, 3) : fallback;
}

function calculateGrid(count, canvasAspect, maxCols = 0, minCols = 0, colsMaxBound = 0) {
    let bestCols = 1;
    // Exact mode: maxCols > 0 means user wants exactly that many columns
    if (maxCols > 0) {
        const exactCols = Math.min(count, maxCols);
        return { cols: exactCols, rows: Math.ceil(count / exactCols) };
    }
    let bestRows = count;
    let bestDiff = Infinity;
    const lowerBound = maxCols > 0 ? 1 : Math.max(1, minCols);
    const colLimit = maxCols > 0
        ? Math.min(count, maxCols)
        : Math.min(count, colsMaxBound > 0 ? colsMaxBound : count);

    for (let cols = lowerBound; cols <= colLimit; cols++) {
        const rows = Math.ceil(count / cols);
        const gridAspect = cols / rows;
        const diff = Math.abs(gridAspect - canvasAspect);

        if (diff < bestDiff) {
            bestDiff = diff;
            bestCols = cols;
            bestRows = rows;
        }
    }

    return { cols: bestCols, rows: bestRows };
}

async function applyAvatarOffset(imageBuffer, width, height, offset) {
    const { x, y, scale } = normalizeOffset(offset);

    if (x === 0 && y === 0 && scale === 100) {
        return imageBuffer;
    }

    let transformedBuffer = imageBuffer;
    let transformedWidth = width;
    let transformedHeight = height;

    if (scale !== 100) {
        const scaleFactor = scale / 100;
        transformedWidth = Math.round(width * scaleFactor);
        transformedHeight = Math.round(height * scaleFactor);
        transformedBuffer = await sharp(imageBuffer)
            .resize(transformedWidth, transformedHeight, {
                fit: 'cover',
            })
            .png()
            .toBuffer();
    }

    const canvasLeft = Math.max(0, x);
    const canvasTop = Math.max(0, y);
    const canvasRight = Math.min(width, x + transformedWidth);
    const canvasBottom = Math.min(height, y + transformedHeight);
    const visibleWidth = canvasRight - canvasLeft;
    const visibleHeight = canvasBottom - canvasTop;

    if (visibleWidth <= 0 || visibleHeight <= 0) {
        return createTransparentCanvas(width, height);
    }

    const extractLeft = Math.max(0, -x);
    const extractTop = Math.max(0, -y);
    const visibleBuffer = await sharp(transformedBuffer)
        .extract({
            left: extractLeft,
            top: extractTop,
            width: visibleWidth,
            height: visibleHeight,
        })
        .png()
        .toBuffer();

    return sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .composite([{ input: visibleBuffer, left: canvasLeft, top: canvasTop }])
        .png()
        .toBuffer();
}

async function createTransparentCanvas(width, height) {
    return sharp({
        create: {
            width,
            height,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .png()
        .toBuffer();
}

function getSharpCropPosition(cropStrategy) {
    switch (cropStrategy) {
        case 'entropy':
            return sharp.strategy.entropy;
        case 'center':
            return 'center';
        case 'top':
            return 'north';
        case 'attention':
        default:
            return sharp.strategy.attention;
    }
}

/**
 * Creates a face-biased crop without a heavy face detection dependency.
 * Most character avatars place the face in the upper center, so this uses an
 * upper-center focus point and expands the crop by the configured padding.
 * A dedicated face detector can replace this heuristic later.
 * @param {string} avatarPath Source avatar path.
 * @param {number} width Output width.
 * @param {number} height Output height.
 * @param {number} cropPadding Padding percentage.
 * @returns {Promise<Buffer>} Cropped PNG buffer.
 */
async function createHeuristicFaceCropBuffer(
    avatarPath,
    width,
    height,
    cropPadding,
) {
    const image = sharp(avatarPath);
    const metadata = await image.metadata();
    const sourceWidth = metadata.width;
    const sourceHeight = metadata.height;

    if (!sourceWidth || !sourceHeight) {
        return sharp(avatarPath)
            .resize(width, height, {
                fit: 'cover',
                position: sharp.strategy.attention,
            })
            .png()
            .toBuffer();
    }

    const targetAspect = width / height;
    const sourceAspect = sourceWidth / sourceHeight;
    let cropWidth = sourceWidth;
    let cropHeight = sourceHeight;

    if (sourceAspect > targetAspect) {
        cropWidth = Math.round(sourceHeight * targetAspect);
    } else {
        cropHeight = Math.round(sourceWidth / targetAspect);
    }

    const paddingScale = 1 + cropPadding / 100;
    cropWidth = Math.min(sourceWidth, Math.round(cropWidth * paddingScale));
    cropHeight = Math.min(sourceHeight, Math.round(cropHeight * paddingScale));

    const focusX = sourceWidth / 2;
    const focusY = sourceHeight * 0.35;
    const left = clamp(
        Math.round(focusX - cropWidth / 2),
        0,
        sourceWidth - cropWidth,
    );
    const top = clamp(
        Math.round(focusY - cropHeight / 2),
        0,
        sourceHeight - cropHeight,
    );

    return sharp(avatarPath)
        .extract({ left, top, width: cropWidth, height: cropHeight })
        .resize(width, height, { fit: 'cover', position: 'center' })
        .png()
        .toBuffer();
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function createSvgPolygonMask(width, height, polygon) {
    const points = polygon.map(([x, y]) => `${x},${y}`).join(' ');

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <polygon points="${points}" fill="white" />
</svg>`;
}

function createBordersSvg(width, height, polygons, color, strokeWidth) {
    const stroke = `rgb(${color.r},${color.g},${color.b})`;
    const polylines = polygons
        .map((polygon) => {
            const closedPolygon = [...polygon, polygon[0]];
            const points = closedPolygon.map(([x, y]) => `${x},${y}`).join(' ');
            return `  <polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round" stroke-linecap="round" />`;
        })
        .join('\n');

    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
${polylines}
</svg>`;
}

function mulberry32(seed) {
    return function () {
        seed |= 0;
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * @param {number} count
 * @param {number} width
 * @param {number} height
 * @param {?number} seed
 * @returns {Array<[number, number]>}
 */
function generateSeedPoints(count, width, height, seed) {
    const rng =
        seed !== null && seed !== undefined ? mulberry32(seed) : Math.random;
    const minDist = Math.sqrt((width * height) / (count * Math.PI)) * 0.5;
    const padding = minDist * 0.3;
    /** @type {Array<[number, number]>} */
    const points = [];

    for (let i = 0; i < count; i++) {
        /** @type {[number, number]} */
        let bestPoint = [padding, padding];
        let bestDistance = -Infinity;

        for (
            let candidateIndex = 0;
            candidateIndex < SEED_CANDIDATES;
            candidateIndex++
        ) {
            /** @type {[number, number]} */
            const candidate = [
                randomInRange(padding, width - padding, rng),
                randomInRange(padding, height - padding, rng),
            ];
            const distance = nearestDistance(candidate, points, width, height);

            if (distance > bestDistance) {
                bestDistance = distance;
                bestPoint = candidate;
            }
        }

        points.push(bestPoint);
    }

    return points;
}

function randomInRange(min, max, rng = Math.random) {
    if (max <= min) {
        return (min + max) / 2;
    }

    return min + rng() * (max - min);
}

function nearestDistance(point, points, width, height) {
    const [x, y] = point;
    let distance = Math.min(x, y, width - x, height - y);

    for (const existingPoint of points) {
        const dx = x - existingPoint[0];
        const dy = y - existingPoint[1];
        distance = Math.min(distance, Math.sqrt(dx * dx + dy * dy));
    }

    return distance;
}
