import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { getAllUserHandles, getUserDirectories } from '../users.js';
import { executeChatCompletion } from './backends/chat-completions.js';
import { countOpenAIMessageTokens } from './tokenizers.js';
import { assembleReviewPayload } from '../util/bulk-combine/artifact-assembler.js';
import { createTaskEventBus } from '../util/bulk-combine/task-events.js';
import {
    createTaskRunner,
    TaskAlreadyRunningError,
    TaskNotResumableError,
} from '../util/bulk-combine/task-runner.js';
import { findSummaryNode, normalizeTemplate } from '../../public/scripts/bulk-combine/structured/templateModel.js';
import { parseStructured } from '../../public/scripts/bulk-combine/structured/parse.js';
import { validateAgainstTemplate } from '../../public/scripts/bulk-combine/structured/validate.js';
import { deriveStaleness, normalizeTask } from '../util/bulk-combine/task-state.js';
import { toonDecode } from '../util/bulk-combine/toon-codec.js';
import {
    BulkCombineTaskRepository,
    InvalidTaskIdError,
    TaskCorruptError,
    TaskNotFoundError,
    TaskRevisionConflictError,
    TaskValidationError,
} from '../util/bulk-combine/task-repository.js';

const TASKS_DIRECTORY = 'bulk-combine-tasks';
export const BULK_COMBINE_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PASS_KEYS = ['transform1', 'transform2', 'summary'];
const PROMPT_KEYS = ['main', 'secondPass', 'summary', 'post'];
const PATCH_ALLOWED_KEYS = new Set([
    'name',
    'status',
    'currentPage',
    'furthestPage',
    'sources',
    'structure',
    'sourceNotes',
    'sourceFields',
    'settings',
    'prompts',
    'passes',
    'completion',
    'lorebook',
    'post',
    'review',
    'avatar',
    'artifacts',
]);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SANITIZER_ALLOWED_KEYS = new Set([
    'secret_id',
    'chat_completion_source',
    'max_tokens',
    'max_completion_tokens',
    'reasoning_prefill',
]);
const SECRET_KEY_PATTERN = /key|secret|password|token|authorization/i;

const eventBus = createTaskEventBus();
const runner = createTaskRunner({
    executeCompletion: executeChatCompletion,
    countTokens: (text, model) => countOpenAIMessageTokens([{ role: 'user', content: text }], model),
    emit: (taskId, event) => eventBus.emit(taskId, event),
});

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeCompletionValue(value) {
    if (Array.isArray(value)) return value.map(sanitizeCompletionValue);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => SANITIZER_ALLOWED_KEYS.has(key) || !SECRET_KEY_PATTERN.test(key))
        .map(([key, entry]) => [key, sanitizeCompletionValue(entry)]));
}

export function sanitizeCompletionSettings(input) {
    return isRecord(input) ? sanitizeCompletionValue(input) : {};
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
    if (typeof root !== 'string' || root.length === 0) {
        throw new TaskValidationError('Authenticated user data root is unavailable');
    }
    // Resolve a possibly-relative data root against the process cwd (same as
    // the rest of the app) instead of rejecting it.
    const tasksRoot = path.join(path.resolve(root), TASKS_DIRECTORY);
    await fs.promises.mkdir(tasksRoot, { recursive: true });
    return new BulkCombineTaskRepository(tasksRoot);
}

function sendError(response, error) {
    if (error instanceof TaskNotFoundError) {
        return response.status(404).send({ error: 'task_not_found' });
    }
    if (error instanceof TaskCorruptError) {
        return response.status(500).send({ error: 'task_corrupt' });
    }
    if (error instanceof TaskAlreadyRunningError) {
        return response.status(409).send({ error: 'task_already_running' });
    }
    if (error instanceof TaskNotResumableError) {
        return response.status(409).send({ error: 'pass_not_resumable' });
    }
    if (error instanceof TaskRevisionConflictError) {
        return response.status(409).send({
            error: 'revision_conflict',
            currentTask: error.currentTask,
        });
    }
    if (error instanceof InvalidTaskIdError || error instanceof TaskValidationError) {
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

function scheduleBackground(start, failureMessage) {
    return new Promise((resolve, reject) => {
        let scheduled = false;
        let operation;
        try {
            operation = start(task => {
                scheduled = true;
                resolve(task);
            });
        } catch (error) {
            reject(error);
            return;
        }
        Promise.resolve(operation).then(() => {
            if (!scheduled) reject(new Error('Bulk Combine runner completed without scheduling'));
        }).catch(error => {
            if (!scheduled) {
                reject(error);
            } else {
                console.error(failureMessage, error);
            }
        });
    });
}

export function createBulkCombineRouter({ runner: taskRunner = runner, eventBus: taskEventBus = eventBus } = {}) {
    const taskRouter = express.Router();

    taskRouter.get('/tasks', route(async (request, response) => {
        const repo = await getRepo(request);
        return response.send(await repo.listTasks());
    }));

    taskRouter.post('/tasks', route(async (request, response) => {
        const repo = await getRepo(request);
        const task = await repo.createTask({ name: request.body?.name });
        return response.status(201).send(task);
    }));

    taskRouter.get('/tasks/:id', route(async (request, response) => {
        const repo = await getRepo(request);
        const task = await repo.getTask(request.params.id);
        return response.send({ ...task, derivedStaleness: deriveStaleness(task) });
    }));

    taskRouter.get('/tasks/:id/review', route(async (request, response) => {
        const repo = await getRepo(request);
        return response.send(assembleReviewPayload(await repo.getTask(request.params.id)));
    }));

    taskRouter.patch('/tasks/:id', route(async (request, response) => {
        const expectedRevision = request.body?.expectedRevision;
        const patch = request.body?.patch;
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !isRecord(patch)) {
            throw new TaskValidationError('PATCH requires expectedRevision and an object patch');
        }
        const sanitizedPatch = Object.fromEntries(Object.entries(structuredClone(patch))
            .filter(([key]) => PATCH_ALLOWED_KEYS.has(key)));
        if (Object.hasOwn(sanitizedPatch, 'completion')) {
            sanitizedPatch.completion = sanitizeCompletionSettings(sanitizedPatch.completion);
        }
        for (const pass of Object.values(sanitizedPatch.passes ?? {})) {
            for (const item of Object.values(pass?.items ?? {})) {
                if (isRecord(item)) delete item.issues;
            }
        }
        const repo = await getRepo(request);
        const task = await repo.updateTask(
            request.params.id,
            current => normalizeTask(deepMergeInto(current, sanitizedPatch)),
            { expectedRevision },
        );
        return response.send(task);
    }));

    taskRouter.post('/tasks/:id/validate', route(async (request, response) => {
        const repo = await getRepo(request);
        const task = await repo.getTask(request.params.id);
        const passKey = request.body?.passKey;
        const itemKey = request.body?.itemKey;
        const pass = isRecord(task.passes) && typeof passKey === 'string' && Object.hasOwn(task.passes, passKey)
            ? task.passes[passKey]
            : null;
        if (!isRecord(pass)) return response.status(404).send({ error: 'pass_not_found' });
        const item = isRecord(pass.items) && typeof itemKey === 'string' && Object.hasOwn(pass.items, itemKey)
            ? pass.items[itemKey]
            : null;
        if (!isRecord(item)) return response.status(404).send({ error: 'item_not_found' });

        const format = task.structure.format;
        let template = task.structure.template;
        if (passKey === 'summary') {
            const summary = findSummaryNode(template);
            if (!summary) return response.send({ ok: true, issues: [], status: item.status });
            template = normalizeTemplate([summary]);
        }
        if (format === 'none') return response.send({ ok: true, issues: [], status: item.status });

        const parsed = parseStructured(item.output, format, { toonDecode });
        const issues = parsed.ok ? validateAgainstTemplate(parsed.doc, template) : [];
        const taskResult = await repo.updateTask(request.params.id, draft => {
            const draftItem = draft.passes[passKey].items[itemKey];
            draftItem.issues = issues;
            if (!parsed.ok) {
                draftItem.status = 'failed';
                draftItem.error = `Unparseable ${format} output: ${parsed.error}`;
            } else if (draftItem.status === 'failed' && String(draftItem.error ?? '').startsWith('Unparseable ')) {
                draftItem.status = 'succeeded';
                draftItem.error = '';
            }
        }, { expectedRevision: task.revision });

        return response.send({
            ok: parsed.ok,
            issues,
            status: taskResult.passes[passKey].items[itemKey].status,
        });
    }));

    taskRouter.delete('/tasks/:id', route(async (request, response) => {
        const repo = await getRepo(request);
        await repo.deleteTask(request.params.id);
        return response.sendStatus(204);
    }));

    taskRouter.post('/tasks/:id/duplicate', route(async (request, response) => {
        const repo = await getRepo(request);
        const task = await repo.duplicateTask(request.params.id, { name: request.body?.name });
        return response.status(201).send(task);
    }));

    taskRouter.post('/tasks/:id/archive', route(async (request, response) => {
        const repo = await getRepo(request);
        return response.send(await repo.setArchived(request.params.id, true));
    }));

    taskRouter.post('/tasks/:id/unarchive', route(async (request, response) => {
        const repo = await getRepo(request);
        return response.send(await repo.setArchived(request.params.id, false));
    }));

    // Apply and Dismiss intentionally use the generic PATCH route: only Apply changes prompt.text,
    // which naturally marks dependent generated output stale through the input-hash contract.
    taskRouter.post('/tasks/:id/prompts/:promptKey/assist', route(async (request, response) => {
        const promptKey = request.params.promptKey;
        if (!PROMPT_KEYS.includes(promptKey)) throw new TaskValidationError('Invalid prompt key');
        if (typeof request.body?.request !== 'string') throw new TaskValidationError('Prompt assist request must be a string');

        const repo = await getRepo(request);
        await repo.getTask(request.params.id);
        const hasCompletionSettings = Object.hasOwn(request.body, 'completionSettings');
        const completion = hasCompletionSettings
            ? sanitizeCompletionSettings(request.body.completionSettings)
            : null;
        const task = await scheduleBackground(onScheduled => taskRunner.runPromptAssist({
            taskId: request.params.id,
            promptKey,
            repo,
            userDirectories: request.user.directories,
            prepareTask: () => repo.checkpoint(request.params.id, draft => {
                draft.prompts[promptKey].assistant = {
                    ...draft.prompts[promptKey].assistant,
                    request: request.body.request,
                    applied: false,
                };
                if (hasCompletionSettings) draft.completion = completion;
            }),
            onScheduled,
        }), 'Bulk Combine prompt assistance failed:');
        return response.status(202).send(task);
    }));

    taskRouter.post('/tasks/:id/passes/:pass/run', route(async (request, response) => {
        const passKey = request.params.pass;
        if (!PASS_KEYS.includes(passKey)) throw new TaskValidationError('Invalid pass key');
        const repo = await getRepo(request);
        await repo.getTask(request.params.id);
        const hasCompletionSettings = Object.hasOwn(request.body || {}, 'completionSettings');
        const completion = hasCompletionSettings
            ? sanitizeCompletionSettings(request.body.completionSettings)
            : null;
        const task = await scheduleBackground(onScheduled => taskRunner.runPass({
            taskId: request.params.id,
            passKey,
            repo,
            userDirectories: request.user.directories,
            scope: request.body?.scope ?? 'missing',
            itemKeys: request.body?.itemKeys ?? null,
            prepareTask: () => hasCompletionSettings
                ? repo.checkpoint(request.params.id, draft => {
                    draft.completion = completion;
                })
                : repo.getTask(request.params.id),
            onScheduled,
        }), 'Bulk Combine pass failed:');
        return response.status(202).send(task);
    }));

    taskRouter.post('/tasks/:id/passes/:pass/resume', route(async (request, response) => {
        if (!PASS_KEYS.includes(request.params.pass)) throw new TaskValidationError('Invalid pass key');
        const repo = await getRepo(request);
        const task = await scheduleBackground(onScheduled => taskRunner.resume({
            taskId: request.params.id,
            passKey: request.params.pass,
            repo,
            userDirectories: request.user.directories,
            onScheduled,
        }), 'Bulk Combine pass failed:');
        return response.status(202).send(task);
    }));

    taskRouter.post('/tasks/:id/post-process/run', route(async (request, response) => {
        const repo = await getRepo(request);
        const task = await repo.getTask(request.params.id);
        taskRunner.runPostProcess({
            taskId: request.params.id,
            repo,
            userDirectories: request.user.directories,
        }).catch(error => console.error('Bulk Combine post-processing failed:', error));
        return response.status(202).send(task);
    }));

    taskRouter.post('/tasks/:id/cancel', route(async (request, response) => {
        const cancelled = await taskRunner.cancel(request.params.id, {
            passKey: request.body?.passKey,
            itemKey: request.body?.itemKey,
        });
        return response.send({ cancelled });
    }));

    taskRouter.get('/tasks/:id/events', route(async (request, response) => {
        const repo = await getRepo(request);
        await repo.getTask(request.params.id);
        const unsubscribe = taskEventBus.subscribe(request.params.id, response);
        request.on('close', () => {
            if (typeof unsubscribe === 'function') {
                unsubscribe();
            } else {
                taskEventBus.unsubscribe(request.params.id, response);
            }
        });
    }));

    return taskRouter;
}

export const router = createBulkCombineRouter({ runner, eventBus });

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

export async function cleanupExpiredForAllUsers() {
    const handles = await getAllUserHandles();
    for (const handle of handles) {
        const tasksRoot = path.join(getUserDirectories(handle).root, TASKS_DIRECTORY);
        try {
            await new BulkCombineTaskRepository(tasksRoot).cleanupExpired();
        } catch (error) {
            console.error(`Bulk Combine cleanup failed for user ${handle}:`, error);
        }
    }
}

export function scheduleBulkCombineCleanup({
    cleanup = cleanupExpiredForAllUsers,
    intervalMs = BULK_COMBINE_CLEANUP_INTERVAL_MS,
} = {}) {
    const timer = setInterval(() => {
        Promise.resolve(cleanup()).catch(error => console.error('Bulk Combine cleanup failed:', error));
    }, intervalMs);
    timer.unref?.();
    return timer;
}
