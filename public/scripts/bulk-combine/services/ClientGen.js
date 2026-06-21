'use strict';

/**
 * @file Client-side generation fallback.
 *
 * Used for APIs that are not supported by the server-side job pipeline
 * (anything other than `openai` and `textgenerationwebui`). Runs a single
 * `generateQuietPrompt` call with the assembled combine prompt and reports
 * progress through callbacks so the Stage 2 UI behaves consistently.
 */

import { generateQuietPrompt, getRequestHeaders } from '../../../script.js';
import { validateGeneratedGroupCardDescription } from '../../group-card-xml-parser.js';
import { buildGroupCardCombineQuietPrompt } from '../helpers.js';

/**
 * Run a single client-side combine generation.
 *
 * Builds the quiet prompt from the selected characters and prompt, runs
 * `generateQuietPrompt`, validates the output, and returns the generated XML.
 *
 * @param {Array<object>} characters Source characters.
 * @param {string} prompt User-configured combine instructions.
 * @param {Array<string>} [fields] Included core fields.
 * @param {object} [callbacks] Progress callbacks.
 * @param {() => void} [callbacks.onStart] Generation starting.
 * @param {() => void} [callbacks.onComplete] Generation completed.
 * @param {(error: Error) => void} [callbacks.onError] Generation failed.
 * @returns {Promise<string>} Validated generated XML description.
 */
export async function runClientGeneration(
    characters,
    prompt,
    fields,
    callbacks = {},
) {
    callbacks.onStart?.();

    const quietPrompt = buildGroupCardCombineQuietPrompt(
        prompt,
        characters,
        fields,
    );
    const generatedDescription = String(
        (await generateQuietPrompt({
            quietPrompt,
            quietToLoud: true,
            skipWIAN: true,
        })) ?? '',
    );
    const validatedDescription = validateGeneratedGroupCardDescription(
        generatedDescription,
        characters.length,
    );

    callbacks.onComplete?.();
    return validatedDescription;
}

/**
 * Generate a Voronoi composite avatar from source character avatars.
 *
 * @param {Array<string>} avatarFilenames Source avatar filenames.
 * @param {string} [cropStrategy] Crop strategy.
 * @param {number} [cropPadding] Crop padding percentage.
 * @returns {Promise<Blob|null>} Avatar blob, or null on failure.
 */
export async function generateVoronoiCompositeAvatar(
    avatarFilenames,
    cropStrategy = 'attention',
    cropPadding = 15,
) {
    const avatars = (avatarFilenames ?? []).filter(Boolean);
    if (avatars.length === 0) {
        return null;
    }

    const compositeResponse = await fetch(
        '/api/characters/generate-voronoi-composite',
        {
            method: 'POST',
            headers: {
                ...getRequestHeaders(),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                avatars,
                cropStrategy,
                cropPadding,
            }),
        },
    );

    if (!compositeResponse.ok) {
        return null;
    }

    const { image } = await compositeResponse.json();
    if (!image) {
        return null;
    }

    const imageResponse = await fetch(image);
    if (!imageResponse.ok) {
        return null;
    }

    return imageResponse.blob();
}

/**
 * Upload a composite avatar blob to an existing character.
 *
 * @param {string} avatarUrl Character avatar filename to update.
 * @param {Blob} imageBlob Composite avatar blob.
 * @returns {Promise<void>}
 */
export async function uploadCompositeAvatar(avatarUrl, imageBlob) {
    const formData = new FormData();
    formData.append('avatar_url', avatarUrl);
    formData.append('avatar', imageBlob, 'avatar.png');

    const editHeaders = getRequestHeaders();
    delete editHeaders['Content-Type'];

    await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: editHeaders,
        body: formData,
    });
}
