'use strict';

/**
 * @file Frontend client for the durable Bulk Combine task API (`/api/bulk-combine`).
 *
 * Pure data/service layer for the guided task workflow: task CRUD with
 * optimistic-concurrency revision tracking, fire-and-forget execution
 * actions, a per-task snapshot cache, and Server-Sent Events subscriptions.
 * No DOM, no jQuery, no popups — only `fetch`, `EventSource`, and
 * `getRequestHeaders()` from `script.js`.
 *
 * Snapshot-first contract: callers load the durable snapshot with
 * {@link TaskClient#getTask} (which seeds the revision cache), then subscribe
 * to live events with {@link TaskClient#subscribeTask}. A reconnect therefore
 * never depends on an in-memory event log.
 *
 * SSE auth matches the existing group-card job stream: a plain
 * `new EventSource(url)` against the same-origin endpoint (see
 * `subscribeToJob` in `services/JobClient.js`). EventSource cannot set custom
 * headers; the endpoints authenticate via the same-origin session, and CSRF
 * tokens are only required for the mutating fetch requests, which all use
 * `getRequestHeaders()`.
 *
 * This module intentionally does NOT import from `services/JobClient.js`:
 * that module pulls in the full generation-settings chain (openai.js,
 * textgen-settings.js, nai-settings.js, ...), which would break the pure
 * fetch/EventSource-only contract and make the module untestable in Node
 * with a single `script.js` mock. The tiny `throwIfNotOk` helper is mirrored
 * locally instead.
 */

import { getRequestHeaders } from '../../../script.js';

/**
 * Base URL of the Bulk Combine task API.
 *
 * @type {string}
 */
export const API_BASE = '/api/bulk-combine';

/**
 * Error thrown when a PATCH is rejected with a 409 revision conflict.
 * Exposes the server's current task snapshot so callers can merge and retry.
 */
export class RevisionConflictError extends Error {
    /**
     * @param {string} taskId Task that conflicted.
     * @param {object|null} currentTask Server-side current task snapshot.
     */
    constructor(taskId, currentTask) {
        super(`Task ${taskId} was modified elsewhere (revision conflict).`);
        this.name = 'RevisionConflictError';
        /** @type {string} */
        this.taskId = taskId;
        /** @type {object|null} */
        this.currentTask = currentTask ?? null;
    }
}

/**
 * Throws response text when an API request fails.
 * Mirrors `throwIfNotOk` from `services/JobClient.js` (see file header).
 *
 * @param {Response} response Fetch response.
 * @param {string} fallbackMessage Fallback failure message.
 */
async function throwIfNotOk(response, fallbackMessage) {
    if (response.ok) {
        return;
    }

    const responseText = await response.text();
    throw new Error(responseText || fallbackMessage);
}

/**
 * Client for the `/api/bulk-combine` task endpoints.
 */
export class TaskClient {
    /** @type {Map<string, object>} Last known task snapshots, keyed by task id. */
    #tasks = new Map();

    /** @type {Map<string, number>} Last known task revisions, keyed by task id. */
    #revisions = new Map();

    /** @type {Map<string, EventSource>} Active SSE subscriptions, keyed by task id. */
    #subscriptions = new Map();

    /**
     * Builds the URL for a single task resource.
     *
     * @param {string|number} id Task id.
     * @returns {string} Task URL.
     */
    #taskUrl(id) {
        return `${API_BASE}/tasks/${encodeURIComponent(String(id))}`;
    }

    /**
     * Sends a JSON request and parses the JSON response.
     *
     * @param {string} url Request URL.
     * @param {object} [options] Request options.
     * @param {string} [options.method] HTTP method.
     * @param {object} [options.body] JSON body. Undefined-valued keys are
     * dropped by `JSON.stringify`, so optional fields can be passed through.
     * @returns {Promise<object|Array<object>|null>} Parsed body, or null for 204 responses.
     */
    async #request(url, { method = 'GET', body } = {}) {
        const options = { method, headers: getRequestHeaders() };
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }

        const response = await fetch(url, options);
        if (response.status === 204) {
            return null;
        }

        await throwIfNotOk(response, `Bulk Combine request failed (${method} ${url}).`);
        return response.json();
    }

    /**
     * Stores a task snapshot and its revision in the cache.
     *
     * @param {object} task Task snapshot.
     * @returns {object} The same task, for chaining.
     */
    #cacheTask(task) {
        const taskId = String(task?.id ?? '');
        if (taskId) {
            this.#tasks.set(taskId, task);
            if (Number.isSafeInteger(task.revision)) {
                this.#revisions.set(taskId, task.revision);
            }
        }
        return task;
    }

    /**
     * Returns the cached revision for a task, seeding the cache from the
     * server first when the task has not been loaded yet.
     *
     * @param {string} taskId Task id.
     * @returns {Promise<number>} Current known revision.
     */
    async #ensureRevision(taskId) {
        if (!this.#revisions.has(taskId)) {
            await this.getTask(taskId);
        }

        const revision = this.#revisions.get(taskId);
        if (!Number.isSafeInteger(revision)) {
            throw new Error(`Task ${taskId} does not expose a usable revision.`);
        }
        return revision;
    }

    /**
     * Lists task summaries.
     *
     * @returns {Promise<Array<object>>} Task summaries.
     */
    async listTasks() {
        return this.#request(`${API_BASE}/tasks`);
    }

    /**
     * Fetches the full task (including `derivedStaleness`) and caches it as
     * the current snapshot. Call this before {@link TaskClient#subscribeTask}
     * so live events always apply on top of a durable snapshot.
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Full task.
     */
    async getTask(id) {
        return this.#cacheTask(await this.#request(this.#taskUrl(id)));
    }

    /**
     * Returns the last known cached snapshot for a task without fetching.
     *
     * @param {string|number} id Task id.
     * @returns {object|null} Cached task snapshot, or null when never loaded.
     */
    getCachedTask(id) {
        return this.#tasks.get(String(id)) ?? null;
    }

    /**
     * Alias of {@link TaskClient#getCachedTask}: the last known snapshot.
     *
     * @param {string|number} id Task id.
     * @returns {object|null} Cached task snapshot, or null when never loaded.
     */
    getCurrentTask(id) {
        return this.getCachedTask(id);
    }

    /**
     * Creates a task and seeds the snapshot/revision cache.
     *
     * @param {object} [options] Creation options.
     * @param {string} [options.name] Task name.
     * @returns {Promise<object>} Created task.
     */
    async createTask({ name } = {}) {
        return this.#cacheTask(await this.#request(`${API_BASE}/tasks`, {
            method: 'POST',
            body: { name },
        }));
    }

    /**
     * Patches a task with optimistic concurrency. Sends the cached revision
     * as `expectedRevision` (fetching the task first when no revision is
     * known) and updates the cache from the response. On a 409 conflict the
     * cache is refreshed from the server's `currentTask` and a
     * {@link RevisionConflictError} exposing that task is thrown so callers
     * can merge and retry.
     *
     * @param {string|number} id Task id.
     * @param {object} patch Partial task patch (deep-merged server-side).
     * @returns {Promise<object>} Updated task.
     * @throws {RevisionConflictError} When the server reports a revision conflict.
     */
    async patchTask(id, patch) {
        const taskId = String(id);
        const expectedRevision = await this.#ensureRevision(taskId);
        const response = await fetch(this.#taskUrl(taskId), {
            method: 'PATCH',
            headers: getRequestHeaders(),
            body: JSON.stringify({ expectedRevision, patch }),
        });

        if (response.status === 409) {
            const data = await response.json().catch(() => null);
            const currentTask = data?.currentTask ?? null;
            if (currentTask) {
                this.#cacheTask(currentTask);
            }
            throw new RevisionConflictError(taskId, currentTask);
        }

        await throwIfNotOk(response, `Failed to update task ${taskId}.`);
        return this.#cacheTask(await response.json());
    }

    /**
     * Deletes a task and evicts its snapshot, revision, and any active event
     * subscription from the cache.
     *
     * @param {string|number} id Task id.
     * @returns {Promise<null>} Resolves with null on success (204).
     */
    async deleteTask(id) {
        const taskId = String(id);
        const result = await this.#request(this.#taskUrl(taskId), { method: 'DELETE' });
        this.#tasks.delete(taskId);
        this.#revisions.delete(taskId);

        const source = this.#subscriptions.get(taskId);
        if (source) {
            source.close();
            this.#subscriptions.delete(taskId);
        }
        return result;
    }

    /**
     * Duplicates a task and caches the new copy.
     *
     * @param {string|number} id Task id.
     * @param {object} [options] Duplicate options.
     * @param {string} [options.name] Name for the duplicated task.
     * @returns {Promise<object>} Duplicated task.
     */
    async duplicateTask(id, { name } = {}) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/duplicate`, {
            method: 'POST',
            body: { name },
        }));
    }

    /**
     * Archives a task (exempts it from automatic expiry).
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Updated task.
     */
    async archiveTask(id) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/archive`, { method: 'POST' }));
    }

    /**
     * Unarchives a task.
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Updated task.
     */
    async unarchiveTask(id) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/unarchive`, { method: 'POST' }));
    }

    /**
     * Fetches the assembled review payload for a task.
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Review payload.
     */
    async getReview(id) {
        return this.#request(`${this.#taskUrl(id)}/review`);
    }

    /**
     * Starts a generation pass in the background (202). Fire-and-forget:
     * progress arrives over the task event stream.
     *
     * @param {string|number} id Task id.
     * @param {string} passKey Pass key (`transform1`, `transform2`, `summary`).
     * @param {object} [options] Run options.
     * @param {string} [options.scope] Run scope (`all`, `missing`, or explicit keys).
     * @param {Array<string>} [options.itemKeys] Explicit item keys to run.
     * @param {object} [options.completionSettings] Completion settings override.
     * @returns {Promise<object>} Task snapshot as accepted by the server.
     */
    async runPass(id, passKey, { scope, itemKeys, completionSettings } = {}) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/passes/${encodeURIComponent(String(passKey))}/run`, {
            method: 'POST',
            body: { scope, itemKeys, completionSettings },
        }));
    }

    /**
     * Resumes an interrupted pass in the background (202).
     *
     * @param {string|number} id Task id.
     * @param {string} passKey Pass key.
     * @returns {Promise<object>} Task snapshot as accepted by the server.
     */
    async resumePass(id, passKey) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/passes/${encodeURIComponent(String(passKey))}/resume`, { method: 'POST' }));
    }

    /**
     * Cancels running work for a task.
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Cancellation acknowledgement (`{ cancelled }`).
     */
    async cancelTask(id) {
        return this.#request(`${this.#taskUrl(id)}/cancel`, { method: 'POST' });
    }

    /**
     * Runs post-processing in the background (202).
     *
     * @param {string|number} id Task id.
     * @returns {Promise<object>} Task snapshot as accepted by the server.
     */
    async runPostProcess(id) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/post-process/run`, { method: 'POST' }));
    }

    /**
     * Requests an LLM prompt-assist proposal in the background (202). The
     * proposal is stored on the task but never mutates the prompt until an
     * explicit Apply via {@link TaskClient#patchTask}.
     *
     * @param {string|number} id Task id.
     * @param {string} promptKey Prompt key (`main`, `secondPass`, `summary`, `post`).
     * @param {object} options Assist options.
     * @param {string} options.request Natural-language assist request.
     * @param {object} [options.completionSettings] Completion settings override.
     * @returns {Promise<object>} Task snapshot as accepted by the server.
     */
    async runPromptAssist(id, promptKey, { request, completionSettings } = {}) {
        return this.#cacheTask(await this.#request(`${this.#taskUrl(id)}/prompts/${encodeURIComponent(String(promptKey))}/assist`, {
            method: 'POST',
            body: { request, completionSettings },
        }));
    }

    /**
     * Subscribes to the task's Server-Sent Events stream. Opens exactly one
     * EventSource per task: subscribing again closes the previous source.
     *
     * The stream emits bare `data:` JSON lines (default `message` events).
     * Malformed events are logged and dropped without reaching the handler.
     * EventSource reconnects automatically with backoff after a connection
     * error; combined with the snapshot-first contract (re-fetch via
     * {@link TaskClient#getTask}, then re-subscribe) no in-memory event log
     * is needed. The active source is exposed via
     * {@link TaskClient#getEventSource} for the controller to manage.
     *
     * @param {string|number} id Task id.
     * @param {(eventObject: object, rawEvent: MessageEvent) => void} onEvent Event handler.
     * @returns {() => void} Unsubscribe function; closes the source. Idempotent.
     */
    subscribeTask(id, onEvent) {
        const taskId = String(id);
        if (typeof EventSource === 'undefined') {
            console.warn(`TaskClient: EventSource is unavailable; cannot subscribe to task ${taskId} events.`);
            return () => {};
        }

        // Single live source per task: a re-subscribe replaces the old one.
        this.#subscriptions.get(taskId)?.close();

        const handler = typeof onEvent === 'function' ? onEvent : () => {};
        const source = new EventSource(`${this.#taskUrl(taskId)}/events`);
        this.#subscriptions.set(taskId, source);

        source.onmessage = (rawEvent) => {
            let eventObject;
            try {
                eventObject = JSON.parse(rawEvent?.data || '{}');
            } catch (error) {
                console.warn('TaskClient: dropping malformed task event.', error);
                return;
            }
            handler(eventObject, rawEvent);
        };
        source.onerror = () => {
            console.debug(`TaskClient: event stream for task ${taskId} interrupted; waiting for automatic reconnect.`);
        };

        let closed = false;
        return () => {
            if (closed) {
                return;
            }
            closed = true;
            source.close();
            if (this.#subscriptions.get(taskId) === source) {
                this.#subscriptions.delete(taskId);
            }
        };
    }

    /**
     * Returns the active EventSource for a task, if any.
     *
     * @param {string|number} id Task id.
     * @returns {EventSource|null} Active event source, or null.
     */
    getEventSource(id) {
        return this.#subscriptions.get(String(id)) ?? null;
    }
}

/**
 * Creates a task client instance.
 *
 * @returns {TaskClient} New task client.
 */
export function createTaskClient() {
    return new TaskClient();
}
