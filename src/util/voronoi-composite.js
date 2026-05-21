import { Delaunay } from 'd3-delaunay';
import { Jimp, JimpMime } from '../jimp.js';
import { DEFAULT_AVATAR_PATH } from '../constants.js';
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

    if (avatarPaths.length === 1) {
        const image = await readAvatarImage(avatarPaths[0]);
        image.cover({ w: width, h: height });
        await writePng(image, outputPath);
        return outputPath;
    }

    const points = generateSeedPoints(avatarPaths.length, width, height);
    const delaunay = Delaunay.from(points);
    const voronoi = delaunay.voronoi([0, 0, width, height]);
    const composite = new Jimp({ width, height, color: 0x000000ff });
    /** @type {Array<Array<[number, number]>>} */
    const polygons = [];

    for (let i = 0; i < avatarPaths.length; i++) {
        const polygon = voronoi.cellPolygon(i);
        if (!polygon || polygon.length < 3) {
            continue;
        }

        polygons.push(polygon.map((point) => [point[0], point[1]]));

        const image = await readAvatarImage(avatarPaths[i]);
        image.cover({ w: width, h: height });

        const mask = createPolygonMask(width, height, polygon);
        image.mask({ src: mask, x: 0, y: 0 });
        composite.blit({ src: image, x: 0, y: 0 });
    }

    drawBorders(composite, polygons);
    await writePng(composite, outputPath);
    return outputPath;
}

async function readAvatarImage(avatarPath) {
    try {
        return await Jimp.read(avatarPath);
    } catch {
        const fallbackPath = path.isAbsolute(DEFAULT_AVATAR_PATH)
            ? DEFAULT_AVATAR_PATH
            : path.resolve(DEFAULT_AVATAR_PATH);
        return await Jimp.read(fallbackPath);
    }
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

function createPolygonMask(width, height, polygon) {
    const mask = new Jimp({ width, height, color: 0x000000ff });
    const data = mask.bitmap.data;

    for (let y = 0; y < height; y++) {
        const intersections = [];
        const scanY = y + 0.5;

        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const [x1, y1] = polygon[j];
            const [x2, y2] = polygon[i];

            if (y1 > scanY === y2 > scanY) {
                continue;
            }

            const x = x1 + ((scanY - y1) * (x2 - x1)) / (y2 - y1);
            intersections.push(x);
        }

        intersections.sort((a, b) => a - b);

        for (let i = 0; i < intersections.length; i += 2) {
            if (intersections[i + 1] === undefined) {
                break;
            }

            const startX = Math.max(0, Math.ceil(intersections[i]));
            const endX = Math.min(width - 1, Math.floor(intersections[i + 1]));

            for (let x = startX; x <= endX; x++) {
                const index = (y * width + x) * 4;
                data[index] = 255;
                data[index + 1] = 255;
                data[index + 2] = 255;
                data[index + 3] = 255;
            }
        }
    }

    return mask;
}

function drawBorders(image, polygons) {
    for (const polygon of polygons) {
        for (let i = 0; i < polygon.length; i++) {
            const [x0, y0] = polygon[i];
            const [x1, y1] = polygon[(i + 1) % polygon.length];
            drawLine(
                image,
                Math.round(x0),
                Math.round(y0),
                Math.round(x1),
                Math.round(y1),
            );
        }
    }
}

function drawLine(image, x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    while (true) {
        setPixelThick(image, x0, y0, BORDER_COLOR, BORDER_RADIUS);

        if (x0 === x1 && y0 === y1) {
            break;
        }

        const e2 = 2 * err;

        if (e2 > -dy) {
            err -= dy;
            x0 += sx;
        }

        if (e2 < dx) {
            err += dx;
            y0 += sy;
        }
    }
}

function setPixelThick(image, centerX, centerY, color, radius) {
    const width = image.bitmap.width;
    const height = image.bitmap.height;
    const data = image.bitmap.data;

    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            const x = centerX + dx;
            const y = centerY + dy;

            if (x < 0 || x >= width || y < 0 || y >= height) {
                continue;
            }

            const index = (y * width + x) * 4;
            data[index] = color.r;
            data[index + 1] = color.g;
            data[index + 2] = color.b;
            data[index + 3] = color.a;
        }
    }
}

async function writePng(image, outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const buffer = await image.getBuffer(JimpMime.png);
    fs.writeFileSync(outputPath, buffer);
}
