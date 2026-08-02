import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getAllUserHandles, getUserDirectories } from '../users.js';
import {
    BulkCombineTaskRepository,
    InvalidSidecarFilenameError,
    InvalidTaskIdError,
    TaskNotFoundError,
    TaskRevisionConflictError,
    TaskValidationError,
} from '../util/bulk-combine/task-repository.js';

const TASKS_DIRECTORY = 'bulk-combine-tasks';
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMergeInto(target, patch) {
    for (const [key, value] of Object.entries(patch)) {
        if (UNSAFE_KEYS.has(key)) continue;
        if (isRecord(value) && isRecord(target[key])) {
            deepMergeInto(target[key], value);
        } else {
            target[key] = structuredClone(value);
        }
    }
    return target;
}

export async function getRepo(request) {
    const root = request.user?.directories?.root;
    if (typeof root !== 'string' || !path.isAbsolute(root)) {
        throw new TaskValidationError('Authenticated user data root is unavailable');
    }
    const tasksRoot = path.join(root, TASKS_DIRECTORY);
    await fs.promises.mkdir(tasksRoot, { recursive: true });
    return new BulkCombineTaskRepository(tasksRoot);
}

function sendError(response, error) {
    if (error instanceof TaskNotFoundError) {
        return response.status(404).send({ error: 'task_not_found' });
    }
    if (error instanceof TaskRevisionConflictError) {
        return response.status(409).send({
            error: 'revision_conflict',
            currentTask: error.currentTask,
        });
    }
    if (error instanceof InvalidTaskIdError
        || error instanceof InvalidSidecarFilenameError
        || error instanceof TaskValidationError) {
        return response.status(400).send({ error: 'invalid_request' });
    }
    console.error('Bulk Combine task request failed:', error);
    return response.status(500).send({ error: 'internal_error' });
}

function route(handler) {
    return async (request, response) => {
        try {
            return await handler(request, response);
        } catch (error) {
            return sendError(response, error);
        }
    };
}

export const router = express.Router();

router.get('/tasks', route(async (request, response) => {
    const repo = await getRepo(request);
    return response.send(await repo.listTasks());
}));

router.post('/tasks', route(async (request, response) => {
    const repo = await getRepo(request);
    const task = await repo.createTask({ name: request.body?.name });
    return response.status(201).send(task);
}));

router.get('/tasks/:id', route(async (request, response) => {
    const repo = await getRepo(request);
    return response.send(await repo.getTask(request.params.id));
}));

router.patch('/tasks/:id', route(async (request, response) => {
    const expectedRevision = request.body?.expectedRevision;
    const patch = request.body?.patch;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !isRecord(patch)) {
        throw new TaskValidationError('PATCH requires expectedRevision and an object patch');
    }
    const repo = await getRepo(request);
    const task = await repo.updateTask(
        request.params.id,
        current => deepMergeInto(current, patch),
        { expectedRevision },
    );
    return response.send(task);
}));

router.delete('/tasks/:id', route(async (request, response) => {
    const repo = await getRepo(request);
    await repo.deleteTask(request.params.id);
    return response.sendStatus(204);
}));

router.post('/tasks/:id/duplicate', route(async (request, response) => {
    const repo = await getRepo(request);
    const task = await repo.duplicateTask(request.params.id, { name: request.body?.name });
    return response.status(201).send(task);
}));

router.post('/tasks/:id/archive', route(async (request, response) => {
    const repo = await getRepo(request);
    return response.send(await repo.setArchived(request.params.id, true));
}));

router.post('/tasks/:id/unarchive', route(async (request, response) => {
    const repo = await getRepo(request);
    return response.send(await repo.setArchived(request.params.id, false));
}));

export async function recoverInterruptedForRoot(tasksRoot) {
    const repo = new BulkCombineTaskRepository(tasksRoot);
    const recovered = await repo.recoverInterrupted();
    const removed = await repo.cleanupExpired();
    return { recovered, removed };
}

/**
 * Runs best-effort startup maintenance for every known user. One user's broken
 * task directory does not prevent recovery for the remaining users.
 * @returns {Promise<void>}
 */
export async function recoverAllUsers() {
    const handles = await getAllUserHandles();
    for (const handle of handles) {
        const tasksRoot = path.join(getUserDirectories(handle).root, TASKS_DIRECTORY);
        try {
            await recoverInterruptedForRoot(tasksRoot);
        } catch (error) {
            console.error(`Bulk Combine startup recovery failed for user ${handle}:`, error);
        }
    }
}
