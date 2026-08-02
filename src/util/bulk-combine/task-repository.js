import fs from 'node:fs';
import path from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import {
    createEmptyTask,
    generateTaskId,
    isTaskId,
    isValidTask,
    normalizeTask,
} from './task-state.js';

const TASK_FILENAME = 'task.json';
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const taskLocks = new Map();
const NO_CHANGE = Symbol('no-change');

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class BulkCombineTaskError extends Error {
    constructor(message) {
        super(message);
        this.name = new.target.name;
    }
}

export class InvalidTaskIdError extends BulkCombineTaskError {}
export class InvalidSidecarFilenameError extends BulkCombineTaskError {}
export class TaskValidationError extends BulkCombineTaskError {}

export class TaskNotFoundError extends BulkCombineTaskError {
    constructor(id) {
        super(`Bulk Combine task not found: ${id}`);
        this.taskId = id;
    }
}

export class TaskRevisionConflictError extends BulkCombineTaskError {
    constructor(expectedRevision, currentTask) {
        super(`Expected revision ${expectedRevision}, found ${currentTask.revision}`);
        this.expectedRevision = expectedRevision;
        this.actualRevision = currentTask.revision;
        this.currentTask = currentTask;
    }
}

function validateTaskId(id) {
    if (!isTaskId(id)) {
        throw new InvalidTaskIdError('Task id must be a UUID');
    }
    return id;
}

function validateSidecarFilename(filename) {
    if (typeof filename !== 'string'
        || !filename
        || filename.includes('..')
        || filename.includes('/')
        || filename.includes('\\')
        || filename.includes('\0')
        || filename === TASK_FILENAME) {
        throw new InvalidSidecarFilenameError('Invalid sidecar filename');
    }
    return filename;
}

function withTaskLock(id, operation) {
    const previous = taskLocks.get(id) || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    taskLocks.set(id, current);
    return current.finally(() => {
        if (taskLocks.get(id) === current) taskLocks.delete(id);
    });
}

function resetActiveItemState(items) {
    for (const item of Object.values(items)) {
        if (!item || typeof item !== 'object') continue;
        if (['queued', 'running', 'interrupted'].includes(item.status)) item.status = 'pending';
        if (['queued', 'running', 'interrupted'].includes(item.queueStatus)) item.queueStatus = 'pending';
    }
}

export class BulkCombineTaskRepository {
    constructor(tasksRoot) {
        if (typeof tasksRoot !== 'string' || !path.isAbsolute(tasksRoot)) {
            throw new TypeError('tasksRoot must be an absolute path');
        }
        this.tasksRoot = path.resolve(tasksRoot);
    }

    #taskDirectory(id) {
        validateTaskId(id);
        return path.join(this.tasksRoot, id);
    }

    #taskPath(id) {
        return path.join(this.#taskDirectory(id), TASK_FILENAME);
    }

    async #readTask(id) {
        validateTaskId(id);
        try {
            const text = await fs.promises.readFile(this.#taskPath(id), 'utf8');
            const task = normalizeTask(JSON.parse(text));
            task.id = id;
            return task;
        } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
                throw new TaskNotFoundError(id);
            }
            throw error;
        }
    }

    async #writeTask(task) {
        if (!isValidTask(task)) {
            throw new TaskValidationError('Refusing to persist invalid task state');
        }
        const directory = this.#taskDirectory(task.id);
        await fs.promises.mkdir(directory, { recursive: true });
        await writeFileAtomic(this.#taskPath(task.id), JSON.stringify(task, null, 4), 'utf8');
    }

    async #mutate(id, mutator, expectedRevision, touch = true, mutationTime = Date.now()) {
        validateTaskId(id);
        return withTaskLock(id, async () => {
            const current = await this.#readTask(id);
            if (expectedRevision !== undefined && expectedRevision !== current.revision) {
                throw new TaskRevisionConflictError(expectedRevision, current);
            }

            const draft = structuredClone(current);
            const returned = await mutator(draft);
            if (returned === NO_CHANGE) return current;
            if (returned !== undefined && !isRecord(returned)) {
                throw new TaskValidationError('Task mutator must return undefined or a record');
            }
            const normalized = normalizeTask(returned === undefined ? draft : returned);
            const updatedAt = new Date(mutationTime).toISOString();
            normalized.id = current.id;
            normalized.revision = current.revision + 1;
            normalized.createdAt = current.createdAt;
            normalized.updatedAt = updatedAt;
            if (touch) {
                normalized.lastActivityAt = updatedAt;
                normalized.expiresAt = new Date(mutationTime + DEFAULT_TTL_MS).toISOString();
            }
            await this.#writeTask(normalized);
            return normalized;
        });
    }

    async listTasks() {
        let entries;
        try {
            entries = await fs.promises.readdir(this.tasksRoot, { withFileTypes: true });
        } catch (error) {
            if (error?.code === 'ENOENT') return [];
            throw error;
        }

        const tasks = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || !isTaskId(entry.name)) continue;
            try {
                const task = await this.#readTask(entry.name);
                tasks.push({
                    id: task.id,
                    name: task.name,
                    status: task.status,
                    currentPage: task.currentPage,
                    archivedAt: task.archivedAt,
                    updatedAt: task.updatedAt,
                    lastActivityAt: task.lastActivityAt,
                });
            } catch {
                // An unreadable or incomplete directory is not a task.
            }
        }
        return tasks.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.id.localeCompare(b.id));
    }

    async getTask(id) {
        return this.#readTask(id);
    }

    async createTask({ name } = {}) {
        if (typeof name !== 'string' || !name.trim()) {
            throw new TaskValidationError('Task name is required');
        }
        const id = generateTaskId();
        return withTaskLock(id, async () => {
            const task = createEmptyTask({ id, name });
            await this.#writeTask(task);
            return task;
        });
    }

    async updateTask(id, mutator, { expectedRevision } = {}) {
        if (typeof mutator !== 'function') {
            throw new TaskValidationError('Task mutator must be a function');
        }
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
            throw new TaskValidationError('expectedRevision must be a positive integer');
        }
        return this.#mutate(id, mutator, expectedRevision);
    }

    async checkpoint(id, mutator) {
        return this.#mutate(id, mutator);
    }

    async deleteTask(id) {
        validateTaskId(id);
        return withTaskLock(id, async () => {
            await this.#readTask(id);
            await fs.promises.rm(this.#taskDirectory(id), { recursive: true, force: true });
        });
    }

    async duplicateTask(id, { name } = {}) {
        validateTaskId(id);
        if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
            throw new TaskValidationError('Duplicate name must be a non-empty string');
        }

        return withTaskLock(id, async () => {
            const original = await this.#readTask(id);
            const duplicateId = generateTaskId();
            return withTaskLock(duplicateId, async () => {
                const destination = this.#taskDirectory(duplicateId);
                try {
                    await fs.promises.cp(this.#taskDirectory(id), destination, {
                        recursive: true,
                        force: false,
                        errorOnExist: true,
                    });
                    const now = new Date().toISOString();
                    const duplicate = normalizeTask({
                        ...original,
                        id: duplicateId,
                        name: name?.trim() || `${original.name} copy`,
                        revision: 1,
                        status: 'draft',
                        currentPage: 1,
                        furthestPage: 1,
                        createdAt: now,
                        updatedAt: now,
                        lastActivityAt: now,
                        archivedAt: null,
                        expiresAt: new Date(Date.parse(now) + DEFAULT_TTL_MS).toISOString(),
                        activePass: null,
                        execution: { status: 'idle', pass: null, startedAt: null, interruptedAt: null },
                    });
                    for (const pass of Object.values(duplicate.passes)) {
                        if (['queued', 'running', 'interrupted'].includes(pass.status)) pass.status = 'pending';
                        resetActiveItemState(pass.items);
                    }
                    await this.#writeTask(duplicate);
                    return duplicate;
                } catch (error) {
                    await fs.promises.rm(destination, { recursive: true, force: true });
                    throw error;
                }
            });
        });
    }

    async setArchived(id, archived) {
        if (typeof archived !== 'boolean') {
            throw new TaskValidationError('archived must be a boolean');
        }
        return this.#mutate(id, task => {
            task.archivedAt = archived ? new Date().toISOString() : null;
        });
    }

    async cleanupExpired({ now = Date.now(), ttlMs = DEFAULT_TTL_MS } = {}) {
        if (!Number.isFinite(now) || !Number.isFinite(ttlMs) || ttlMs < 0) {
            throw new TaskValidationError('Invalid cleanup time');
        }
        const summaries = await this.listTasks();
        let removed = 0;
        for (const summary of summaries) {
            try {
                const didRemove = await withTaskLock(summary.id, async () => {
                    const current = await this.#readTask(summary.id);
                    if (current.archivedAt !== null || Date.parse(current.lastActivityAt) >= now - ttlMs) return false;
                    await fs.promises.rm(this.#taskDirectory(summary.id), { recursive: true, force: true });
                    return true;
                });
                if (didRemove) removed++;
            } catch (error) {
                if (!(error instanceof TaskNotFoundError)) throw error;
            }
        }
        return removed;
    }

    async recoverInterrupted({ now = Date.now() } = {}) {
        if (!Number.isFinite(now)) throw new TaskValidationError('Invalid recovery time');
        const summaries = await this.listTasks();
        const interruptedAt = new Date(now).toISOString();
        let recovered = 0;

        for (const summary of summaries) {
            let changed = false;
            try {
                await this.#mutate(summary.id, task => {
                    // Per PLAN step 5: interrupt pass status; retain queued/running item status for explicit resume confirmation.
                    for (const pass of Object.values(task.passes)) {
                        if (['running', 'queued'].includes(pass.status)) {
                            pass.status = 'interrupted';
                            changed = true;
                        }
                    }
                    if (['running', 'queued'].includes(task.status)) {
                        task.status = 'interrupted';
                        changed = true;
                    }
                    if (!changed) return NO_CHANGE;
                    task.activePass = null;
                    task.execution.status = 'interrupted';
                    task.execution.pass = null;
                    task.execution.interruptedAt = interruptedAt;
                }, undefined, false, now);
                if (changed) recovered++;
            } catch (error) {
                if (!(error instanceof TaskNotFoundError)) throw error;
            }
        }
        return recovered;
    }

    getSidecarPath(id, filename) {
        validateTaskId(id);
        validateSidecarFilename(filename);
        return path.join(this.#taskDirectory(id), filename);
    }

    async writeSidecar(id, filename, buffer) {
        validateTaskId(id);
        validateSidecarFilename(filename);
        if (!Buffer.isBuffer(buffer)) throw new TaskValidationError('Sidecar content must be a Buffer');
        return withTaskLock(id, async () => {
            await this.#readTask(id);
            await writeFileAtomic(this.getSidecarPath(id, filename), buffer);
        });
    }

    async readSidecar(id, filename) {
        validateTaskId(id);
        validateSidecarFilename(filename);
        await this.#readTask(id);
        return fs.promises.readFile(this.getSidecarPath(id, filename));
    }
}
