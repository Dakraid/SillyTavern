import { Delaunay } from 'd3-delaunay';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
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
 * @param {{width?: number, height?: number, cellAspect?: number|string, gap?: number, cropStrategy?: string, cropPadding?: number, offsets?: Array<{x?: number, y?: number, scale?: number}>}} options
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
    const grid = calculateGrid(avatarPaths.length, width / height / cellAspect);
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

    const totalGridWidth = cellWidth * grid.cols + gap * (grid.cols - 1);
    const totalGridHeight = cellHeight * grid.rows + gap * (grid.rows - 1);
    const startX = Math.floor((width - totalGridWidth) / 2);
    const startY = Math.floor((height - totalGridHeight) / 2);
    /** @type {Array<{ input: Buffer, left: number, top: number, blend: 'over' }>} */
    const composites = [];
    /** @type {Array<{type: string, x: number, y: number, w: number, h: number}>} */
    const cells = [];

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    for (let i = 0; i < avatarPaths.length; i++) {
        const col = i % grid.cols;
        const row = Math.floor(i / grid.cols);
        const x = startX + col * (cellWidth + gap);
        const y = startY + row * (cellHeight + gap);
        const imageBuffer = await readAvatarBuffer(
            avatarPaths[i],
            cellWidth,
            cellHeight,
            cropOptions,
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
    const { cropStrategy, cropPadding } = normalizeCropOptions(cropOptions);

    if (cropStrategy === 'face') {
        return createHeuristicFaceCropBuffer(
            avatarPath,
            width,
            height,
            cropPadding,
        );
    }

    return sharp(avatarPath)
        .resize(width, height, {
            fit: 'cover',
            position: getSharpCropPosition(cropStrategy),
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

    return { cropStrategy, cropPadding };
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
        x: Number.isFinite(x) ? clamp(Math.round(x), -100, 100) : 0,
        y: Number.isFinite(y) ? clamp(Math.round(y), -100, 100) : 0,
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

function calculateGrid(count, canvasAspect) {
    let bestCols = 1;
    let bestRows = count;
    let bestDiff = Infinity;

    for (let cols = 1; cols <= count; cols++) {
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

    const canvasLeft = clamp(x, 0, width);
    const canvasTop = clamp(y, 0, height);
    const canvasRight = clamp(x + transformedWidth, 0, width);
    const canvasBottom = clamp(y + transformedHeight, 0, height);
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
