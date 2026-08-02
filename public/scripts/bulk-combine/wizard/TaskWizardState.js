'use strict';

/**
 * @file Server-backed state layer for the 8-page Bulk Combine guided task
 * workflow.
 *
 * The durable server task is the single source of truth. This module holds
 * the latest authoritative snapshot (as returned by `GET /tasks/:id`,
 * including `derivedStaleness`), derives per-page rail statuses from it, and
 * applies optimistic PATCH updates with revision-conflict recovery.
 *
 * Navigation contract: {@link TaskWizardState#setPage} only PATCHes
 * `currentPage`/`furthestPage`. It NEVER starts, resumes, or cancels any
 * server execution — rendering and navigation are pure.
 *
 * Re-sync contract: the server is authoritative. SSE events are treated as
 * bare notifications — every event triggers a fresh `getTask()` and the
 * whole snapshot is swapped in (documented simple choice; no client-side
 * event folding). Likewise, after every successful PATCH the snapshot is
 * re-fetched because the PATCH response omits `derivedStaleness`.
 */

import { createTaskClient, RevisionConflictError } from '../services/TaskClient.js';

/**
 * sessionStorage key holding ONLY the active task id (re-open convenience).
 * The server remains the authority; no task data is persisted client-side.
 *
 * @type {string}
 */
export const ACTIVE_TASK_STORAGE_KEY = 'bulkCombineActiveTaskId';

/**
 * The 8 guided-workflow pages in fixed order. Conditional pages stay in the
 * list; their availability is expressed via the computed page status.
 *
 * @type {ReadonlyArray<{key: string, index: number, title: string}>}
 */
export const TASK_WIZARD_PAGES = Object.freeze([
    { key: 'cards', index: 1, title: 'Cards' },
    { key: 'prompt', index: 2, title: 'Prompt & Settings' },
    { key: 'transform1', index: 3, title: 'Transform 1' },
    { key: 'transform2', index: 4, title: 'Transform 2' },
    { key: 'summary', index: 5, title: 'Lorebook Summary' },
    { key: 'post', index: 6, title: 'Post Processing' },
    { key: 'review', index: 7, title: 'Review' },
    { key: 'avatar', index: 8, title: 'Avatar Studio & Create' },
]);

const PAGE_MIN = 1;
const PAGE_MAX = TASK_WIZARD_PAGES.length;

/**
 * Resolves a page key to its 1-based page index.
 *
 * @param {string} key Page key.
 * @returns {number|null} 1-based index, or null for unknown keys.
 */
export function pageIndexForKey(key) {
    return TASK_WIZARD_PAGES.find((page) => page.key === key)?.index ?? null;
}

/**
 * Clamps a page candidate to a valid 1-based page index.
 *
 * @param {unknown} page Page candidate.
 * @returns {number} Clamped page index.
 */
export function clampPage(page) {
    const n = Number(page);
    if (!Number.isFinite(n)) {
        return PAGE_MIN;
    }
    return Math.max(PAGE_MIN, Math.min(PAGE_MAX, Math.round(n)));
}

/**
 * Whether a pass has at least one settled success output.
 *
 * @param {object} [pass] Pass record (`{ status, items }`).
 * @returns {boolean} True when any item succeeded.
 */
function hasSucceededOutput(pass) {
    return Object.values(pass?.items ?? {}).some((item) => item?.status === 'succeeded');
}

/**
 * Whether a pass record is in a settled-with-output state.
 *
 * @param {object} [pass] Pass record.
 * @returns {boolean} True when the pass produced usable output.
 */
function passHasResults(pass) {
    return hasSucceededOutput(pass) || ['succeeded', 'partial'].includes(pass?.status);
}

/**
 * Maps a server pass record + derived staleness to a rail page status.
 *
 * @param {object} task Task snapshot.
 * @param {string} passKey Pass key (`transform1` | `transform2` | `summary`).
 * @param {boolean} upstreamReady Whether the page's inputs are configured.
 * @returns {string} Page status.
 */
function passPageStatus(task, passKey, upstreamReady) {
    const pass = task?.passes?.[passKey];
    const status = pass?.status ?? 'pending';
    const execution = task?.execution ?? {};

    if (status === 'running' || (execution.status === 'running' && execution.pass === passKey)) {
        return 'running';
    }
    if (status === 'interrupted') {
        return 'interrupted';
    }
    if (status === 'failed') {
        return 'failed';
    }
    if (task?.derivedStaleness?.[passKey]?.stale === true && passHasResults(pass)) {
        return 'stale';
    }
    if (status === 'succeeded' || status === 'partial') {
        return 'complete';
    }
    return upstreamReady ? 'ready' : 'not_started';
}

/**
 * Computes the rail status of the Post Processing page.
 *
 * @param {object} task Task snapshot.
 * @param {boolean} latestTransformHasResults Whether a final transform output exists.
 * @returns {string} Page status.
 */
function postPageStatus(task, latestTransformHasResults) {
    const post = task?.post ?? {};

    if (post.status === 'failed') {
        return 'failed';
    }
    if (post.status === 'succeeded') {
        return 'complete';
    }
    if (post.status === 'skipped') {
        return 'skipped';
    }
    return latestTransformHasResults ? 'ready' : 'not_started';
}

/**
 * Computes the rail status of every page for the given task snapshot. Pure:
 * tolerates partial/normalized tasks and a missing `derivedStaleness`
 * (treated as "nothing stale"), so freshly created tasks work too.
 *
 * Status derivation (per page):
 * - cards: `complete` with >= 2 sources, `ready` with 1, else `not_started`.
 * - prompt: `ready` when the main prompt has text, else `not_started`.
 * - transform1: running/interrupted/failed from `passes.transform1.status`
 *   (or `execution`), `stale` when `derivedStaleness.transform1.stale`,
 *   `complete` on succeeded/partial, else ready/not_started from upstream.
 * - transform2: `disabled` when `!settings.secondPassEnabled`, else like
 *   transform1 with Transform 1 results as upstream.
 * - summary: `disabled` when `settings.destination !== 'lorebook'`, else
 *   like transform1 with the latest enabled transform as upstream.
 * - post: `disabled` when `!settings.postProcessingEnabled`, else from
 *   `task.post.status` (failed/complete/skipped) or upstream readiness.
 * - review: `stale` when any upstream pass is stale, `ready` when a final
 *   assembled source exists, else `not_started`.
 * - avatar: `complete` once artifacts were created, `ready` when review
 *   inputs exist, else `not_started`.
 *
 * @param {object} task Task snapshot (with optional `derivedStaleness`).
 * @returns {Array<{key: string, title: string, index: number, status: string}>} Page states in order.
 */
export function computePageStates(task) {
    const settings = task?.settings ?? {};
    const sources = Array.isArray(task?.sources) ? task.sources : [];
    const stale = task?.derivedStaleness ?? {};

    const secondPassEnabled = settings.secondPassEnabled === true;
    const lorebookDestination = settings.destination === 'lorebook';
    const postEnabled = settings.postProcessingEnabled === true;

    const cardsReady = sources.length >= 2;
    const promptReady = Boolean(task?.prompts?.main?.text?.trim());

    const t1HasResults = passHasResults(task?.passes?.transform1);
    const t2HasResults = passHasResults(task?.passes?.transform2);
    const latestTransformHasResults = (secondPassEnabled && t2HasResults) || t1HasResults;

    const upstreamStale = [stale.transform1, stale.transform2, stale.summary]
        .some((entry) => entry?.stale === true);

    const reviewInputsExist = postEnabled
        ? task?.post?.status === 'succeeded'
        : latestTransformHasResults;

    const statuses = {
        cards: cardsReady ? 'complete' : (sources.length === 1 ? 'ready' : 'not_started'),
        prompt: promptReady ? 'ready' : 'not_started',
        transform1: passPageStatus(task, 'transform1', cardsReady && promptReady),
        transform2: !secondPassEnabled
            ? 'disabled'
            : passPageStatus(task, 'transform2', t1HasResults),
        summary: !lorebookDestination
            ? 'disabled'
            : passPageStatus(task, 'summary', latestTransformHasResults),
        post: !postEnabled
            ? 'disabled'
            : postPageStatus(task, latestTransformHasResults),
        review: !reviewInputsExist
            ? 'not_started'
            : (upstreamStale ? 'stale' : 'ready'),
        avatar: (task?.artifacts?.characterId || task?.artifacts?.character || task?.artifacts?.createdAt)
            ? 'complete'
            : (reviewInputsExist ? 'ready' : 'not_started'),
    };

    return TASK_WIZARD_PAGES.map((page) => ({ ...page, status: statuses[page.key] }));
}

/**
 * Returns sessionStorage when available (browser), else null.
 *
 * @returns {Storage|null} sessionStorage or null.
 */
function getStorage() {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
}

/**
 * Remembers the active task id for re-open convenience. Best-effort.
 *
 * @param {string|number} id Task id.
 * @returns {void}
 */
export function rememberActiveTaskId(id) {
    try {
        getStorage()?.setItem(ACTIVE_TASK_STORAGE_KEY, String(id));
    } catch {
        // Storage unavailable — re-open convenience is optional.
    }
}

/**
 * Returns the remembered active task id, if any.
 *
 * @returns {string|null} Active task id or null.
 */
export function getRememberedActiveTaskId() {
    try {
        return getStorage()?.getItem(ACTIVE_TASK_STORAGE_KEY) ?? null;
    } catch {
        return null;
    }
}

/**
 * Whether a value is a plain record (non-array object).
 *
 * @param {unknown} value Value to test.
 * @returns {boolean} True for plain records.
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Deep-merges a patch into a task snapshot, mirroring the server's PATCH
 * semantics: records merge recursively, everything else is replaced.
 *
 * @param {object} target Task snapshot to mutate.
 * @param {object} patch Patch to apply.
 * @returns {object} The mutated target.
 */
function deepMergeTask(target, patch) {
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (isRecord(value) && isRecord(target[key])) {
            deepMergeTask(target[key], value);
        } else {
            target[key] = structuredClone(value);
        }
    }
    return target;
}

/**
 * Server-backed state container for the guided task wizard.
 */
export class TaskWizardState {
    /** @type {import('../services/TaskClient.js').TaskClient} */
    #client;

    /** @type {object|null} Latest authoritative task snapshot. */
    #task = null;

    /** @type {Set<(snapshot: object) => void>} Subscriber callbacks. */
    #subscribers = new Set();

    /** @type {(() => void)|null} Active SSE unsubscribe function. */
    #unsubscribeEvents = null;

    /** @type {Promise<object|null>} Serialized re-sync chain (no overlapping getTask). */
    #syncChain = Promise.resolve(null);

    /** @type {'saved'|'saving'|'conflict'|'error'} Save/checkpoint indicator state. */
    #syncState = 'saved';

    /** @type {boolean} Whether the last update hit a revision conflict. */
    #conflict = false;

    /**
     * @param {object} [options] Options.
     * @param {import('../services/TaskClient.js').TaskClient} [options.client] Task client (defaults to a new instance).
     */
    constructor({ client } = {}) {
        this.#client = client ?? createTaskClient();
    }

    /** @returns {object|null} Current task snapshot. */
    get task() {
        return this.#task;
    }

    /** @returns {string|null} Active task id. */
    get taskId() {
        return this.#task?.id ?? null;
    }

    /** @returns {object} Derived staleness map (`{ transform1, transform2, summary }`). */
    get derivedStaleness() {
        return this.#task?.derivedStaleness ?? {};
    }

    /** @returns {Array} Current per-page states. */
    get pageStates() {
        return computePageStates(this.#task);
    }

    /** @returns {number} Current 1-based page index. */
    get currentPage() {
        return clampPage(this.#task?.currentPage ?? PAGE_MIN);
    }

    /** @returns {number} Furthest reached 1-based page index. */
    get furthestPage() {
        return Math.max(this.currentPage, clampPage(this.#task?.furthestPage ?? this.currentPage));
    }

    /** @returns {boolean} Whether the last update conflicted. */
    get conflict() {
        return this.#conflict;
    }

    /** @returns {string} Save/checkpoint indicator state. */
    get syncState() {
        return this.#syncState;
    }

    /**
     * Returns the immutable snapshot payload delivered to subscribers.
     *
     * @returns {{task: object|null, derivedStaleness: object, pageStates: Array, currentPage: number, furthestPage: number, conflict: boolean, syncState: string}} Snapshot payload.
     */
    getSnapshot() {
        return {
            task: this.#task,
            derivedStaleness: this.derivedStaleness,
            pageStates: this.pageStates,
            currentPage: this.currentPage,
            furthestPage: this.furthestPage,
            conflict: this.#conflict,
            syncState: this.#syncState,
        };
    }

    /**
     * Seeds the active task: loads the authoritative snapshot for an id, or
     * accepts an already-created task object.
     *
     * @param {string|object} taskOrId Task id or freshly created task.
     * @returns {Promise<object>} The seeded task snapshot.
     */
    async init(taskOrId) {
        const task = (typeof taskOrId === 'string' || typeof taskOrId === 'number')
            ? await this.#client.getTask(taskOrId)
            : taskOrId;

        if (!task?.id) {
            throw new Error('TaskWizardState.init requires a task id or task object.');
        }

        this.#applyTask(task);
        this.#syncState = 'saved';
        this.#conflict = false;
        rememberActiveTaskId(task.id);
        return this.#task;
    }

    /**
     * Subscribes to state changes. The callback fires on every change with
     * the {@link TaskWizardState#getSnapshot} payload; it is NOT called
     * immediately — callers render the initial state explicitly.
     *
     * @param {(snapshot: object) => void} fn Subscriber callback.
     * @returns {() => void} Unsubscribe function.
     */
    subscribe(fn) {
        this.#subscribers.add(fn);
        return () => {
            this.#subscribers.delete(fn);
        };
    }

    /**
     * Optimistically applies a patch: merges it into the local snapshot and
     * notifies immediately, then PATCHes the server (TaskClient attaches the
     * cached revision as `expectedRevision`) and re-syncs the authoritative
     * snapshot. On a revision conflict the local snapshot is replaced with
     * the server's current task and subscribers are notified with
     * `conflict: true`.
     *
     * @param {object} patch Partial task patch (deep-merged server-side).
     * @returns {Promise<void>}
     * @throws {Error} Non-conflict request failures (after an error notify).
     */
    async update(patch) {
        if (!this.#task) {
            throw new Error('TaskWizardState.update called before init.');
        }

        this.#conflict = false;
        deepMergeTask(this.#task, patch);
        this.#syncState = 'saving';
        this.#notify();

        try {
            await this.#client.patchTask(this.#task.id, patch);
            await this.#syncNow();
            this.#syncState = 'saved';
        } catch (error) {
            if (error instanceof RevisionConflictError || error?.name === 'RevisionConflictError') {
                this.#conflict = true;
                this.#syncState = 'conflict';
                if (error.currentTask) {
                    this.#applyTask(error.currentTask);
                } else {
                    await this.#syncNow().catch(() => {});
                }
            } else {
                this.#syncState = 'error';
                this.#notify();
                throw error;
            }
        }

        this.#notify();
    }

    /**
     * Navigates to a page: updates `currentPage`/`furthestPage` via an
     * optimistic PATCH. This is pure navigation — it NEVER runs, resumes, or
     * cancels any server-side work.
     *
     * @param {number} page Target 1-based page index.
     * @returns {Promise<void>}
     */
    async setPage(page) {
        const target = clampPage(page);
        if (!this.#task || target === this.currentPage) {
            return;
        }
        await this.update({
            currentPage: target,
            furthestPage: Math.max(this.furthestPage, target),
        });
    }

    /**
     * Subscribes to the task's SSE stream. Every event triggers a full
     * snapshot re-fetch (`getTask`) — events are notifications only; the
     * server snapshot stays authoritative (documented simple choice).
     * Idempotent: re-calling keeps the existing subscription.
     *
     * @returns {void}
     */
    connectEvents() {
        if (this.#unsubscribeEvents || !this.#task?.id) {
            return;
        }

        this.#unsubscribeEvents = this.#client.subscribeTask(this.#task.id, () => {
            this.#syncNow()
                .then(() => {
                    this.#syncState = 'saved';
                    this.#notify();
                })
                .catch((error) => console.warn('TaskWizardState: event re-sync failed.', error));
        });
    }

    /**
     * Unsubscribes from the task's SSE stream. Idempotent.
     *
     * @returns {void}
     */
    disconnectEvents() {
        this.#unsubscribeEvents?.();
        this.#unsubscribeEvents = null;
    }

    /**
     * Tears down the state: disconnects events and clears subscribers.
     *
     * @returns {void}
     */
    dispose() {
        this.disconnectEvents();
        this.#subscribers.clear();
    }

    /**
     * Applies a server snapshot, preserving `derivedStaleness` when the
     * incoming payload omits it (PATCH/409 responses do; GET includes it).
     *
     * @param {object} task Server task snapshot.
     * @returns {void}
     */
    #applyTask(task) {
        if (!task?.derivedStaleness && this.#task?.derivedStaleness) {
            task = { ...task, derivedStaleness: this.#task.derivedStaleness };
        }
        this.#task = task;
    }

    /**
     * Notifies all subscribers with the current snapshot. Subscriber errors
     * are logged, never propagated.
     *
     * @returns {void}
     */
    #notify() {
        const snapshot = this.getSnapshot();
        for (const fn of this.#subscribers) {
            try {
                fn(snapshot);
            } catch (error) {
                console.error('TaskWizardState: subscriber failed.', error);
            }
        }
    }

    /**
     * Re-fetches the authoritative snapshot. Re-syncs are serialized through
     * a promise chain so bursts of SSE events cannot overlap.
     *
     * @returns {Promise<object|null>} The applied task snapshot.
     */
    #syncNow() {
        const run = async () => {
            if (!this.#task?.id) {
                return null;
            }
            const task = await this.#client.getTask(this.#task.id);
            this.#applyTask(task);
            return this.#task;
        };
        this.#syncChain = this.#syncChain.then(run, run);
        return this.#syncChain;
    }
}
