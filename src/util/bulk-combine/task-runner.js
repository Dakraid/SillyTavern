import { runWithConcurrency, throwIfAborted, withRetries } from '../job-manager.js';
import { computePassInputHash, hashInputs } from './task-state.js';
import {
    CORE_FIELDS,
    buildCombinedPrompt,
    buildIndividualPrompt,
    parseCombinedResponse,
    preflightTokens,
} from './prompt-builders.js';

const PASS_KEYS = ['transform1', 'transform2', 'summary'];
const RESUMABLE_STATUSES = new Set(['pending', 'failed', 'interrupted', 'queued']);
const COMBINED_KEY = '__combined__';

function newItem(existing = {}) {
    return {
        status: typeof existing.status === 'string' ? existing.status : 'pending',
        output: typeof existing.output === 'string' ? existing.output : '',
        error: existing.error === null || typeof existing.error === 'string' ? existing.error : null,
        attempts: Number.isSafeInteger(existing.attempts) && existing.attempts >= 0 ? existing.attempts : 0,
        inputHash: typeof existing.inputHash === 'string' ? existing.inputHash : '',
        regenHint: typeof existing.regenHint === 'string' ? existing.regenHint : '',
        hintApplied: existing.hintApplied === true,
    };
}

function completionError(result) {
    const detail = result?.data?.error?.message ?? result?.data?.error;
    return new Error(typeof detail === 'string' && detail
        ? detail
        : `Completion failed with status ${result?.status ?? 'unknown'}`);
}

function completionContent(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) {
        throw completionError(result);
    }
    return typeof result.content === 'string' ? result.content : String(result.content ?? '');
}

function promptText(task, passKey) {
    if (passKey === 'transform2') {
        return `${task.prompts.main.text}\n\n${task.prompts.secondPass.text}`;
    }
    return passKey === 'summary' ? task.prompts.summary.text : task.prompts.main.text;
}

function modelFromSettings(settings) {
    return settings?.model
        ?? settings?.connectionProfile?.model
        ?? settings?.preset?.model
        ?? null;
}

function sourceWithOutput(source, output) {
    return {
        ...source,
        fields: {
            ...source.fields,
            description: output,
        },
    };
}

function deriveInputs(task, passKey) {
    if (passKey === 'transform1') {
        return new Map(task.sources.map(source => [source.key, source]));
    }
    if (passKey === 'transform2' && !task.settings.secondPassEnabled) return new Map();

    let inputPass = task.passes.transform1;
    if (passKey === 'summary'
        && task.settings.secondPassEnabled
        && Object.values(task.passes.transform2.items).some(item => item?.status === 'succeeded')) {
        inputPass = task.passes.transform2;
    }

    const inputs = new Map();
    for (const source of task.sources) {
        const item = inputPass.items[source.key];
        if (item?.status === 'succeeded') {
            inputs.set(source.key, sourceWithOutput(source, item.output));
        }
    }
    return inputs;
}

function targetKeys(task, passKey, scope, itemKeys) {
    const knownKeys = new Set(task.sources.map(source => source.key));
    if (Array.isArray(itemKeys) && itemKeys.length > 0) {
        return [...new Set(itemKeys)].filter(key => knownKeys.has(key));
    }
    if (scope === 'all') return [...knownKeys];

    const items = task.passes[passKey].items;
    return [...knownKeys].filter(key => RESUMABLE_STATUSES.has(newItem(items[key]).status));
}

function itemStatuses(task, passKey, keys) {
    return Object.fromEntries(keys.map(key => [key, newItem(task.passes[passKey].items[key]).status]));
}

function finalStatus(task, passKey, keys) {
    const statuses = keys
        .map(key => newItem(task.passes[passKey].items[key]).status)
        .filter(status => status !== 'skipped');
    if (statuses.length === 0 || statuses.every(status => status === 'succeeded')) return 'succeeded';
    if (statuses.every(status => status === 'failed')) return 'failed';
    return 'partial';
}

export class TaskAlreadyRunningError extends Error {
    constructor(taskId) {
        super(`Bulk Combine task is already running: ${taskId}`);
        this.name = 'TaskAlreadyRunningError';
        this.taskId = taskId;
    }
}

export function createTaskRunner({ executeCompletion, countTokens, emit } = {}) {
    if (typeof executeCompletion !== 'function' || typeof countTokens !== 'function') {
        throw new TypeError('executeCompletion and countTokens are required');
    }

    const active = new Set();
    const controllers = new Map();
    const sendEvent = (taskId, passKey, type, payload = {}) => {
        if (typeof emit !== 'function') return;
        try {
            emit(taskId, { type, taskId, passKey, ...payload });
        } catch {
            // Notifications are advisory; durable checkpoints remain authoritative.
        }
    };

    async function runPass({
        taskId,
        passKey,
        repo,
        userDirectories,
        scope = 'missing',
        itemKeys = null,
    }) {
        if (!PASS_KEYS.includes(passKey)) throw new TypeError(`Invalid pass key: ${passKey}`);
        if (active.has(taskId)) throw new TaskAlreadyRunningError(taskId);

        active.add(taskId);
        const controller = new AbortController();
        controllers.set(taskId, controller);
        const { signal } = controller;

        try {
            const task = await repo.getTask(taskId);
            const keys = targetKeys(task, passKey, scope, itemKeys);
            const inputs = deriveInputs(task, passKey);
            const text = promptText(task, passKey);
            const runnableKeys = keys.filter(key => inputs.has(key));
            const hints = new Map(runnableKeys.map(key => [key, newItem(task.passes[passKey].items[key]).regenHint]));
            const prompts = new Map();

            if (task.settings.mode === 'combined' && runnableKeys.length > 0) {
                const nudge = runnableKeys.length === 1 ? hints.get(runnableKeys[0]) : '';
                prompts.set(COMBINED_KEY, buildCombinedPrompt(
                    runnableKeys.map(key => inputs.get(key)),
                    text,
                    CORE_FIELDS,
                    nudge,
                ));
            } else {
                for (const key of runnableKeys) {
                    prompts.set(key, buildIndividualPrompt(inputs.get(key), text, CORE_FIELDS, hints.get(key)));
                }
            }

            const preflight = await preflightTokens({
                prompts: [...prompts].map(([key, prompt]) => ({ key, text: prompt })),
                outputTokens: task.settings.outputTokens,
                contextTokens: task.settings.totalContextTokens,
                model: modelFromSettings(task.settings) || (task.completion && task.completion.model) || null,
            }, countTokens);
            const preflightItems = new Map(preflight.items.map(item => [item.key, item]));
            const blockedKeys = new Set();
            for (const blocked of preflight.blocked) {
                if (blocked.key === COMBINED_KEY) {
                    runnableKeys.forEach(key => blockedKeys.add(key));
                } else {
                    blockedKeys.add(blocked.key);
                }
            }

            const startedAt = new Date().toISOString();
            await repo.checkpoint(taskId, draft => {
                const pass = draft.passes[passKey];
                pass.status = 'running';
                draft.activePass = passKey;
                draft.execution = { status: 'running', pass: passKey, startedAt };
                for (const key of keys) {
                    const item = newItem(pass.items[key]);
                    if (!inputs.has(key)) {
                        item.status = 'skipped';
                        item.error = null;
                    } else {
                        const promptKey = task.settings.mode === 'combined' ? COMBINED_KEY : key;
                        item.inputHash = hashInputs({ source: inputs.get(key), prompt: prompts.get(promptKey) });
                        if (blockedKeys.has(key)) {
                            const usage = preflightItems.get(promptKey);
                            item.status = 'failed';
                            item.error = `Token limit exceeded (needs ${usage.total}, context ${task.settings.totalContextTokens})`;
                        } else {
                            item.status = 'queued';
                            item.error = null;
                        }
                    }
                    pass.items[key] = item;
                }
            });
            sendEvent(taskId, passKey, 'pass_started', { itemKeys: keys });

            const executableKeys = runnableKeys.filter(key => !blockedKeys.has(key));

            if (task.settings.mode === 'combined' && executableKeys.length > 0) {
                let attempts = 0;
                try {
                    throwIfAborted(signal);
                    await repo.checkpoint(taskId, draft => {
                        for (const key of executableKeys) draft.passes[passKey].items[key].status = 'running';
                    });
                    executableKeys.forEach(key => sendEvent(taskId, passKey, 'item_started', { itemKey: key }));
                    const content = await withRetries(async () => {
                        attempts++;
                        // This run-time completion snapshot is the frontend's sanitized config-resolution seam; the executor resolves secret_id.
                        return completionContent(await executeCompletion({
                            body: { ...(task.completion || {}), messages: [{ role: 'user', content: prompts.get(COMBINED_KEY) }], stream: false },
                            userDirectories,
                            signal,
                        }));
                    }, signal, 3);
                    const parsed = parseCombinedResponse(content, executableKeys.map(key => inputs.get(key)));
                    await repo.checkpoint(taskId, draft => {
                        for (const key of executableKeys) {
                            const item = draft.passes[passKey].items[key];
                            item.attempts += attempts;
                            item.hintApplied = executableKeys.length === 1 && Boolean(hints.get(key)?.trim());
                            if (parsed.results[key]) {
                                item.status = 'succeeded';
                                item.output = passKey === 'summary' ? parsed.results[key].summary : parsed.results[key].xml;
                                item.error = null;
                            } else {
                                item.status = 'failed';
                                item.error = 'No output returned for this character';
                            }
                        }
                    });
                    for (const key of executableKeys) {
                        const succeeded = Boolean(parsed.results[key]);
                        sendEvent(taskId, passKey, succeeded ? 'item_succeeded' : 'item_failed', {
                            itemKey: key,
                            error: succeeded ? undefined : 'No output returned for this character',
                        });
                    }
                } catch (error) {
                    try {
                        await repo.checkpoint(taskId, draft => {
                            for (const key of executableKeys) {
                                const item = draft.passes[passKey].items[key];
                                if (signal.aborted) {
                                    if (item.status === 'running') item.status = 'interrupted';
                                } else {
                                    item.status = 'failed';
                                    item.error = String(error);
                                }
                                item.attempts += attempts;
                                if (attempts > 0) {
                                    item.hintApplied = executableKeys.length === 1 && Boolean(hints.get(key)?.trim());
                                }
                            }
                        });
                    } catch {
                        // A failed checkpoint must not escape the settled combined queue item.
                    }
                }
            } else if (task.settings.mode !== 'combined' && executableKeys.length > 0) {
                const itemTasks = executableKeys.map(key => async () => {
                    let attempts = 0;
                    try {
                        throwIfAborted(signal);
                        await repo.checkpoint(taskId, draft => {
                            draft.passes[passKey].items[key].status = 'running';
                        });
                        sendEvent(taskId, passKey, 'item_started', { itemKey: key });
                        const content = await withRetries(async () => {
                            attempts++;
                            // This run-time completion snapshot is the frontend's sanitized config-resolution seam; the executor resolves secret_id.
                            return completionContent(await executeCompletion({
                                body: { ...(task.completion || {}), messages: [{ role: 'user', content: prompts.get(key) }], stream: false },
                                userDirectories,
                                signal,
                            }));
                        }, signal, 3);
                        await repo.checkpoint(taskId, draft => {
                            const item = draft.passes[passKey].items[key];
                            item.status = 'succeeded';
                            item.output = content;
                            item.error = null;
                            item.attempts += attempts;
                            item.hintApplied = Boolean(hints.get(key)?.trim());
                        });
                        sendEvent(taskId, passKey, 'item_succeeded', { itemKey: key });
                    } catch (error) {
                        try {
                            await repo.checkpoint(taskId, draft => {
                                const item = draft.passes[passKey].items[key];
                                if (signal.aborted) {
                                    if (item.status === 'running') item.status = 'interrupted';
                                } else {
                                    item.status = 'failed';
                                    item.error = String(error);
                                }
                                item.attempts += attempts;
                                if (attempts > 0) item.hintApplied = Boolean(hints.get(key)?.trim());
                            });
                            if (!signal.aborted) {
                                sendEvent(taskId, passKey, 'item_failed', { itemKey: key, error: String(error) });
                            }
                        } catch {
                            // Every pool task settles even when its failure checkpoint cannot be written.
                        }
                    }
                });
                await runWithConcurrency(itemTasks, Math.max(1, task.settings.concurrency));
            }

            const settled = await repo.getTask(taskId);
            if (signal.aborted) {
                const interruptedAt = new Date().toISOString();
                const interrupted = await repo.checkpoint(taskId, draft => {
                    draft.passes[passKey].status = 'interrupted';
                    draft.activePass = null;
                    draft.execution = { status: 'interrupted', pass: null, interruptedAt };
                });
                sendEvent(taskId, passKey, 'pass_cancelled');
                return { passKey, status: 'interrupted', items: itemStatuses(interrupted, passKey, keys) };
            }

            const status = finalStatus(settled, passKey, keys);
            const completed = await repo.checkpoint(taskId, draft => {
                draft.passes[passKey].status = status;
                if (status === 'succeeded') {
                    draft.passes[passKey].inputRevision = computePassInputHash(task, passKey);
                }
                draft.activePass = null;
                draft.execution = { status: 'idle', pass: null };
            });
            sendEvent(taskId, passKey, 'pass_completed', { status });
            return { passKey, status, items: itemStatuses(completed, passKey, keys) };
        } finally {
            active.delete(taskId);
            controllers.delete(taskId);
        }
    }

    async function resume({ taskId, repo, userDirectories }) {
        const task = await repo.getTask(taskId);
        // Persisted live-running items are intentionally excluded to avoid silently billing uncertain work twice.
        const passKey = task.activePass
            || PASS_KEYS.find(key => task.passes[key].status === 'interrupted');
        if (!passKey) return null;
        return runPass({ taskId, passKey, repo, userDirectories, scope: 'missing' });
    }

    async function cancel(taskId) {
        const controller = controllers.get(taskId);
        if (!controller) return false;
        controller.abort();
        return true;
    }

    return { runPass, resume, cancel };
}
