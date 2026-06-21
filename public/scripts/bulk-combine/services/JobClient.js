'use strict';

/**
 * @file Server-side group-card job client.
 *
 * Wraps the `/api/characters/group-card-job` endpoints used for parallel
 * generation: creating a job, subscribing to its SSE event stream,
 * cancelling, and polling status. Only `openai` and `textgenerationwebui`
 * APIs use server jobs; other APIs fall back to {@link module:bulk-combine/services/ClientGen}.
 */

import {
    getRequestHeaders,
    main_api,
    amount_gen,
    max_context,
} from '../../../script.js';
import { oai_settings } from '../../openai.js';
import { textgenerationwebui_settings } from '../../textgen-settings.js';
import { nai_settings } from '../../nai-settings.js';
import { kai_settings } from '../../kai-settings.js';
import { horde_settings } from '../../horde.js';
import { getCoreCharacterField } from '../helpers.js';

/**
 * sessionStorage key holding the active job id (for resume/restore).
 *
 * @type {string}
 */
export const GROUP_CARD_JOB_SESSION_KEY = 'groupCardJobId';

/**
 * Throws response text when an API request fails.
 *
 * @param {Response} response Fetch response.
 * @param {string} fallbackMessage Fallback failure message.
 */
export async function throwIfNotOk(response, fallbackMessage) {
    if (response.ok) {
        return;
    }

    const responseText = await response.text();
    throw new Error(responseText || fallbackMessage);
}

/**
 * Sends an API request and returns the fetch response.
 *
 * @param {string} url API endpoint.
 * @param {object} body JSON request body.
 * @returns {Promise<Response>} Fetch response.
 */
export async function sendJsonRequest(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
}

/**
 * Safely clones settings for server-side generation config.
 *
 * @param {object} value Settings object.
 * @returns {object} Clone.
 */
export function cloneGroupCardJobSettings(value) {
    try {
        return structuredClone(value ?? {});
    } catch {
        return JSON.parse(JSON.stringify(value ?? {}));
    }
}

/**
 * Builds LLM config snapshot for a server-side group card job.
 *
 * @returns {object} LLM config.
 */
export function getGroupCardJobLlmConfig() {
    return {
        type: main_api,
        amount_gen,
        max_context,
        openai: cloneGroupCardJobSettings(oai_settings),
        textgenerationwebui: cloneGroupCardJobSettings(
            textgenerationwebui_settings,
        ),
        novelai: cloneGroupCardJobSettings(nai_settings),
        kobold: cloneGroupCardJobSettings(kai_settings),
        horde: cloneGroupCardJobSettings(horde_settings),
    };
}

/**
 * Checks whether the current API can be used by the server-side group-card job runner.
 *
 * @returns {boolean} True when server-side jobs can call the current API directly.
 */
export function canUseServerGroupCardJob() {
    return ['openai', 'textgenerationwebui'].includes(main_api);
}

/**
 * Builds a server-side group card job config.
 *
 * @param {string} groupName Group card name.
 * @param {string} prompt Main prompt.
 * @param {Array<object>} selectedCharacters Source characters.
 * @param {boolean} createLorebook Whether to create lorebook.
 * @param {Array<string>} fields Included fields.
 * @param {number} concurrency Parallel concurrency.
 * @param {boolean} postMergeEnabled Whether post-merge runs.
 * @param {string} postMergePrompt Post-merge prompt.
 * @param {string} cropStrategy Crop strategy.
 * @param {number} cropPadding Crop padding.
 * @param {string} [postProcessMode] Post-process mode.
 * @param {boolean} [dynamicLorebook] Whether to use dynamic lorebook output.
 * @param {boolean} [minify] Whether to minify final XML output.
 * @param {boolean} [minifySingleLine] Whether to minify final XML to one line.
 * @param {number} [maxCols] Max columns for grid avatar.
 * @returns {object} Job config.
 */
export function buildGroupCardJobConfig(
    groupName,
    prompt,
    selectedCharacters,
    createLorebook,
    fields,
    concurrency,
    postMergeEnabled,
    postMergePrompt,
    cropStrategy,
    cropPadding,
    postProcessMode = 'replace',
    dynamicLorebook = false,
    minify = false,
    minifySingleLine = false,
    maxCols = 0,
) {
    return {
        groupName,
        prompt,
        characters: selectedCharacters.map((character) => ({
            name: getCoreCharacterField(character, 'name'),
            description: getCoreCharacterField(character, 'description'),
            personality: getCoreCharacterField(character, 'personality'),
            scenario: getCoreCharacterField(character, 'scenario'),
            first_mes: getCoreCharacterField(character, 'first_mes'),
            mes_example: getCoreCharacterField(character, 'mes_example'),
            avatar: character?.avatar ?? '',
        })),
        fields,
        processingMode: 'parallel',
        concurrency,
        postMergeEnabled,
        postMergePrompt,
        postProcessMode: ['replace', 'prepend', 'append'].includes(postProcessMode)
            ? postProcessMode
            : 'replace',
        avatarOffsets: [],
        createLorebook,
        dynamicLorebook: Boolean(dynamicLorebook),
        minify: Boolean(minify),
        minifySingleLine: Boolean(minifySingleLine),
        cropStrategy,
        cropPadding,
        maxCols,
        llm: getGroupCardJobLlmConfig(),
    };
}

/**
 * Create a new server-side group-card generation job.
 *
 * @param {object} config Job configuration payload.
 * @returns {Promise<{jobId: string}>} The created job id.
 */
export async function createJob(config) {
    const jobResponse = await fetch('/api/characters/group-card-job', {
        method: 'POST',
        headers: {
            ...getRequestHeaders(),
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ config }),
    });

    if (jobResponse.status === 404) {
        return { jobId: '' };
    }

    await throwIfNotOk(
        jobResponse,
        'Failed to start server-side group card generation.',
    );
    const jobData = await jobResponse.json();
    const jobId = String(jobData.jobId ?? jobData.id ?? '');

    if (!jobId) {
        throw new Error('Server did not return a group card job ID.');
    }

    return { jobId };
}

/**
 * Subscribe to a job's SSE event stream.
 *
 * The returned EventSource is already connected. Call `source.close()` to
 * disconnect. All event types are forwarded to the matching optional callback.
 * On `job_completed` or `job_failed` the source is closed automatically and
 * the session key is removed.
 *
 * @param {string} jobId Job to observe.
 * @param {object} [callbacks] Event callbacks.
 * @param {() => void} [callbacks.onStarted] Job started.
 * @param {(data: object) => void} [callbacks.onCharacterStarted] Character started.
 * @param {(data: object) => void} [callbacks.onCharacterCompleted] Character completed.
 * @param {(data: object) => void} [callbacks.onCharacterFailed] Character failed.
 * @param {() => void} [callbacks.onMergeStarted] Merge started.
 * @param {() => void} [callbacks.onMergeCompleted] Merge completed.
 * @param {() => void} [callbacks.onPostMergeStarted] Post-merge started.
 * @param {() => void} [callbacks.onPostMergeCompleted] Post-merge completed.
 * @param {() => void} [callbacks.onAvatarStarted] Avatar started.
 * @param {() => void} [callbacks.onAvatarCompleted] Avatar completed.
 * @param {() => void} [callbacks.onCardCreated] Card created.
 * @param {() => void} [callbacks.onLorebookCreated] Lorebook created.
 * @param {(data: object) => void} [callbacks.onComplete] Job completed.
 * @param {(data: object) => void} [callbacks.onFailed] Job failed.
 * @param {() => void} [callbacks.onError] Connection error.
 * @returns {EventSource} Connected EventSource.
 */
export function subscribeToJob(jobId, callbacks = {}) {
    const source = new EventSource(
        `/api/characters/group-card-job/${encodeURIComponent(jobId)}/events`,
    );
    const parseEvent = (event) => JSON.parse(event.data || '{}');

    source.addEventListener('job_started', () => callbacks.onStarted?.());
    source.addEventListener('character_started', (event) =>
        callbacks.onCharacterStarted?.(parseEvent(event)),
    );
    source.addEventListener('character_completed', (event) =>
        callbacks.onCharacterCompleted?.(parseEvent(event)),
    );
    source.addEventListener('character_failed', (event) =>
        callbacks.onCharacterFailed?.(parseEvent(event)),
    );
    source.addEventListener('merge_started', () => callbacks.onMergeStarted?.());
    source.addEventListener('merge_completed', () =>
        callbacks.onMergeCompleted?.(),
    );
    source.addEventListener('post_merge_started', () =>
        callbacks.onPostMergeStarted?.(),
    );
    source.addEventListener('post_merge_completed', () =>
        callbacks.onPostMergeCompleted?.(),
    );
    source.addEventListener('avatar_started', () =>
        callbacks.onAvatarStarted?.(),
    );
    source.addEventListener('avatar_completed', () =>
        callbacks.onAvatarCompleted?.(),
    );
    source.addEventListener('card_created', () => callbacks.onCardCreated?.());
    source.addEventListener('lorebook_created', () =>
        callbacks.onLorebookCreated?.(),
    );
    source.addEventListener('job_completed', (event) => {
        sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
        source.close();
        callbacks.onComplete?.(parseEvent(event));
    });
    source.addEventListener('job_failed', (event) => {
        sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
        source.close();
        callbacks.onFailed?.(parseEvent(event));
    });
    source.onerror = () => callbacks.onError?.();

    return source;
}

/**
 * Cancel a running job.
 *
 * @param {string} jobId Job to cancel.
 * @returns {Promise<void>} Resolves when cancellation is acknowledged.
 */
export async function cancelJob(jobId) {
    if (!jobId) {
        return;
    }

    await fetch(
        `/api/characters/group-card-job/${encodeURIComponent(jobId)}/cancel`,
        {
            method: 'POST',
            headers: getRequestHeaders(),
        },
    );
    sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
}

/**
 * Fetch the current status of a job.
 *
 * @param {string} jobId Job to inspect.
 * @returns {Promise<object|null>} Job status object, or null when unavailable.
 */
export async function getJob(jobId) {
    const response = await fetch(
        `/api/characters/group-card-job/${encodeURIComponent(jobId)}`,
        { headers: getRequestHeaders() },
    );

    if (!response.ok) {
        return null;
    }

    return response.json();
}
