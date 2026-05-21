import { Delaunay } from 'd3-delaunay';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';

const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 1536;
const SEED_CANDIDATES = 10;
const BORDER_COLOR = { r: 20, g: 20, b: 20, a: 255 };
const BORDER_RADIUS = 1;

/**
 * Generate a Voronoi mosaic composite from character avatar images.
 * @param {string[]} avatarPaths Absolute paths to character avatar PNGs.
 * @param {string} outputPath Where to write the composite PNG.
 * @param {{width?: number, height?: number}} options Output dimensions.
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

    fs.mkdirSync(path.dirname(outputPath), { recursive: true });

    if (avatarPaths.length === 1) {
        const buffer = await readAvatarBuffer(avatarPaths[0], width, height);
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

        const imageBuffer = await readAvatarBuffer(avatarPaths[i], width, height);
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

async function readAvatarBuffer(avatarPath, width, height) {
    try {
        return await createAvatarBuffer(avatarPath, width, height);
    } catch {
        const fallbackPath = path.isAbsolute(DEFAULT_AVATAR_PATH)
            ? DEFAULT_AVATAR_PATH
            : path.resolve(DEFAULT_AVATAR_PATH);
        return await createAvatarBuffer(fallbackPath, width, height);
    }
}

function createAvatarBuffer(avatarPath, width, height) {
    return sharp(avatarPath)
        .resize(width, height, {
            fit: 'cover',
            position: sharp.strategy.attention,
        })
        .png()
        .toBuffer();
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
