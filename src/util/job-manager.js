import crypto from 'node:crypto';

export const JOB_TTL_MS = 30 * 60 * 1000;
export const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
export const TERMINAL_EVENT_TYPES = new Set(['job_completed', 'job_failed']);
export const TERMINAL_SSE_RETRY_MS = 24 * 60 * 60 * 1000;

const MAX_LLM_RETRIES = 3;

export function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(new Error('Job cancelled.'));
            return;
        }

        const timeout = setTimeout(resolve, ms);

        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timeout);
                reject(new Error('Job cancelled.'));
            },
            { once: true },
        );
    });
}

export function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw new Error('Job cancelled.');
    }
}

export async function withRetries(task, signal, attempts = MAX_LLM_RETRIES) {
    let lastError;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        throwIfAborted(signal);

        try {
            return await task();
        } catch (error) {
            lastError = error;

            if (attempt >= attempts) {
                break;
            }

            await delay(1000 * 2 ** (attempt - 1), signal);
        }
    }

    throw lastError;
}

export async function runWithConcurrency(tasks, concurrency) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < tasks.length) {
            const taskIndex = index++;
            results[taskIndex] = await tasks[taskIndex]();
        }
    }

    await Promise.all(
        Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()),
    );
    return results;
}

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {'pending'|'running'|'completed'|'failed'|'cancelled'} status
 * @property {object} config
 * @property {object} progress
 * @property {object} results
 * @property {string|null} error
 * @property {number} createdAt
 * @property {Set<import('express').Response>} sseClients
 * @property {AbortController|null} abortController
 * @property {number} eventCounter
 * @property {Array<{id:number,eventType:string,data:object}>} eventLog
 */

export class JobManager {
    /**
	 * @param {{ttlMs?: number, cleanupIntervalMs?: number}} [options]
	 */
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? JOB_TTL_MS;
        this.cleanupIntervalMs = options.cleanupIntervalMs ?? CLEANUP_INTERVAL_MS;
        /** @type {Map<string, Job>} */
        this.jobs = new Map();
        this.cleanupTimer = setInterval(
            () => this.cleanup(),
            this.cleanupIntervalMs,
        );
        this.cleanupTimer.unref?.();
    }

    /**
	 * Creates a background job and optionally starts the runner.
	 * @param {object} config Full job config from client.
	 * @param {{autoStart?: boolean}} [options] Job creation options.
	 * @returns {Job}
	 */
    createJob(config, options = {}) {
        /** @type {Job} */
        const job = {
            id: crypto.randomUUID(),
            status: 'pending',
            config: config && typeof config === 'object' ? config : {},
            progress: {},
            results: {},
            error: null,
            createdAt: Date.now(),
            sseClients: new Set(),
            abortController: new AbortController(),
            eventCounter: 0,
            eventLog: [],
        };

        this.jobs.set(job.id, job);
        if (options.autoStart !== false) {
            setImmediate(() => this.runJob(job.id));
        }
        return job;
    }

    /**
	 * Gets a job by ID.
	 * @param {string} id Job ID.
	 * @returns {Job|null}
	 */
    getJob(id) {
        return this.jobs.get(id) ?? null;
    }

    /**
	 * Cancels a running or pending job.
	 * @param {string} id Job ID.
	 * @returns {boolean}
	 */
    cancelJob(id) {
        const job = this.getJob(id);
        if (!job) {
            return false;
        }

        if (TERMINAL_STATUSES.has(job.status)) {
            return true;
        }

        job.status = 'cancelled';
        job.abortController?.abort();
        this.emitEvent(id, 'job_failed', { error: 'Job cancelled.' });
        // Defer close to allow SSE event to flush to clients
        setTimeout(() => this.closeSseClients(job), 50);
        return true;
    }

    /**
	 * Adds an SSE client and replays missed events.
	 * @param {string} id Job ID.
	 * @param {import('express').Response} response Express response.
	 * @param {number} [lastEventId=0] Last received SSE event ID.
	 * @returns {boolean}
	 */
    addSseClient(id, response, lastEventId = 0) {
        const job = this.getJob(id);
        if (!job) {
            return false;
        }

        for (const event of job.eventLog) {
            if (event.id > lastEventId) {
                this.writeSseEvent(response, event.id, event.eventType, event.data);
            }
        }

        if (TERMINAL_STATUSES.has(job.status)) {
            response.flush?.();
            setImmediate(() => this.closeSseClient(response));
            return true;
        }

        job.sseClients.add(response);

        response.on('close', () => {
            job.sseClients.delete(response);
        });

        return true;
    }

    /**
	 * Emits an SSE event to all connected clients and stores it for reconnect replay.
	 * @param {string} jobId Job ID.
	 * @param {string} eventType SSE event type.
	 * @param {object} [data={}] Event payload.
	 */
    emitEvent(jobId, eventType, data = {}) {
        const job = this.getJob(jobId);
        if (!job) {
            return;
        }

        const event = {
            id: ++job.eventCounter,
            eventType,
            data: data && typeof data === 'object' ? data : {},
        };
        job.eventLog.push(event);

        for (const client of [...job.sseClients]) {
            this.writeSseEvent(client, event.id, event.eventType, event.data);
        }
    }

    /**
	 * Creates a safe public view of a job.
	 * @param {Job} job Job object.
	 * @returns {{id:string,status:string,progress:object,results:object,error:string|null}}
	 */
    serializeJob(job) {
        return {
            id: job.id,
            status: job.status,
            progress: job.progress,
            results: job.results,
            error: job.error,
        };
    }

    /**
	 * Removes expired jobs and closes lingering SSE connections.
	 */
    cleanup() {
        const now = Date.now();

        for (const [id, job] of this.jobs.entries()) {
            if (now - job.createdAt <= this.ttlMs) {
                continue;
            }

            job.abortController?.abort();
            this.closeSseClients(job);
            this.jobs.delete(id);
        }
    }

    /**
	 * Closes all jobs and stops cleanup timer.
	 */
    shutdown() {
        clearInterval(this.cleanupTimer);

        for (const job of this.jobs.values()) {
            job.abortController?.abort();
            this.closeSseClients(job);
        }

        this.jobs.clear();
    }

    /**
	 * @param {Job} job Job object.
	 */
    closeSseClients(job) {
        for (const client of [...job.sseClients]) {
            this.closeSseClient(client);
        }
        job.sseClients.clear();
    }

    /**
	 * @param {import('express').Response} response Express response.
	 */
    closeSseClient(response) {
        try {
            if (!response.writableEnded) {
                response.end();
            }
        } catch (error) {
            console.debug('Failed to close job SSE client:', error);
        }
    }

    /**
	 * @param {import('express').Response} response Express response.
	 * @param {number} id Event ID.
	 * @param {string} eventType Event type.
	 * @param {object} data Event payload.
	 */
    writeSseEvent(response, id, eventType, data) {
        if (response.writableEnded) {
            return;
        }

        response.write(`id: ${id}\n`);
        response.write(`event: ${eventType}\n`);
        if (TERMINAL_EVENT_TYPES.has(eventType)) {
            response.write(`retry: ${TERMINAL_SSE_RETRY_MS}\n`);
        }
        response.write(`data: ${JSON.stringify(data)}\n\n`);
        response.flush?.();
    }

    /**
	 * Runs a background job.
	 * @param {string} _jobId Job ID.
	 * @returns {Promise<void>}
	 */
    async runJob(_jobId) {
        throw new Error('Not implemented');
    }
}
