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
const CROP_STRATEGIES = new Set(['attention', 'entropy', 'center', 'top', 'face']);
const SEED_CANDIDATES = 10;
const BORDER_COLOR = { r: 20, g: 20, b: 20, a: 255 };
const BORDER_RADIUS = 1;

/**
 * Generate a Voronoi mosaic composite from character avatar images.
 * @param {string[]} avatarPaths Absolute paths to character avatar PNGs.
 * @param {string} outputPath Where to write the composite PNG.
 * @param {{width?: number, height?: number, cropStrategy?: string, cropPadding?: number}} options Output dimensions and crop options.
 * @returns {Promise<string>} The output path.
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

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (avatarPaths.length === 1) {
        const buffer = await readAvatarBuffer(avatarPaths[0], width, height, cropOptions);
        await sharp(buffer).png().toFile(outputPath);
        return outputPath;
    }

    const points = generateSeedPoints(avatarPaths.length, width, height);
    const delaunay = Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, width, height]);
    /** @type {Array<Array<[number, number]>>} */
    const polygons = [];
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

        const imageBuffer = await readAvatarBuffer(avatarPaths[i], width, height, cropOptions);
        const maskBuffer = Buffer.from(
            createSvgPolygonMask(width, height, normalizedPolygon),
        );
        const maskedCell = await sharp(imageBuffer)
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

    return outputPath;
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
        return createHeuristicFaceCropBuffer(avatarPath, width, height, cropPadding);
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
async function createHeuristicFaceCropBuffer(avatarPath, width, height, cropPadding) {
    const image = sharp(avatarPath);
    const metadata = await image.metadata();
    const sourceWidth = metadata.width;
    const sourceHeight = metadata.height;

    if (!sourceWidth || !sourceHeight) {
        return sharp(avatarPath)
            .resize(width, height, { fit: 'cover', position: sharp.strategy.attention })
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
    const left = clamp(Math.round(focusX - cropWidth / 2), 0, sourceWidth - cropWidth);
    const top = clamp(Math.round(focusY - cropHeight / 2), 0, sourceHeight - cropHeight);

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

/**
 * @param {number} count
 * @param {number} width
 * @param {number} height
 * @returns {Array<[number, number]>}
 */
function generateSeedPoints(count, width, height) {
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
                randomInRange(padding, width - padding),
                randomInRange(padding, height - padding),
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

function randomInRange(min, max) {
    if (max <= min) {
        return (min + max) / 2;
    }

    return min + Math.random() * (max - min);
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
