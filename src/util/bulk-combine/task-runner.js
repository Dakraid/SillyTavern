import DiffMatchPatch from 'diff-match-patch';

import { runWithConcurrency, throwIfAborted, withRetries } from '../job-manager.js';
import { applyPostProcess, buildMergedCardDescription } from './artifact-assembler.js';
import { COMBINED_KEY, computePassInputHash, hashInputs } from './task-state.js';
import {
    CORE_FIELDS,
    buildCombinedPrompt,
    buildIndividualPrompt,
    buildMergedPassPrompt,
    buildPostProcessPrompt,
    preflightTokens,
} from './prompt-builders.js';

const PASS_KEYS = ['transform1', 'transform2', 'summary'];
const PROMPT_KEYS = ['main', 'secondPass', 'summary', 'post'];
const RESUMABLE_STATUSES = new Set(['pending', 'failed', 'interrupted', 'queued']);
const dmp = new DiffMatchPatch();

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
    const error = new Error(typeof detail === 'string' && detail
        ? detail
        : `Completion failed with status ${result?.status ?? 'unknown'}`);
    if (Number.isInteger(result?.status)) error.status = result.status;
    return error;
}

function completionContent(result) {
    if (!Number.isInteger(result?.status) || result.status < 200 || result.status >= 300) {
        throw completionError(result);
    }
    return typeof result.content === 'string' ? result.content : String(result.content ?? '');
}

function stripCodeFences(content) {
    const trimmed = content.trim();
    const fenced = trimmed.match(/^```[^\r\n]*\r?\n([\s\S]*?)\r?\n?```$/);
    return (fenced?.[1] ?? trimmed).trim();
}

function promptText(task, passKey) {
    if (passKey === 'transform2') {
        return `${task.prompts.main.text}\n\n${task.prompts.secondPass.text}`;
    }
    return passKey === 'summary' ? task.prompts.summary.text : task.prompts.main.text;
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
    // Combined mode: one merged item per pass. Transform 1 consumes all
    // sources in one prompt; transform2/summary consume the upstream pass's
    // single merged output document.
    if (task.settings.mode === 'combined') {
        if (passKey === 'transform1') {
            return task.sources.length > 0
                ? new Map([[COMBINED_KEY, { sources: task.sources, document: null }]])
                : new Map();
        }
        if (passKey === 'transform2' && !task.settings.secondPassEnabled) return new Map();

        let inputPass = task.passes.transform1;
        if (passKey === 'summary'
            && task.settings.secondPassEnabled
            && task.passes.transform2.items[COMBINED_KEY]?.status === 'succeeded') {
            inputPass = task.passes.transform2;
        }
        const upstream = inputPass.items[COMBINED_KEY];
        return upstream?.status === 'succeeded' && upstream.output
            ? new Map([[COMBINED_KEY, { sources: [], document: upstream.output }]])
            : new Map();
    }

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
    if (task.settings.mode === 'combined') {
        if (Array.isArray(itemKeys) && itemKeys.length > 0) {
            return itemKeys.includes(COMBINED_KEY) ? [COMBINED_KEY] : [];
        }
        if (scope === 'all') return [COMBINED_KEY];
        return RESUMABLE_STATUSES.has(newItem(task.passes[passKey].items[COMBINED_KEY]).status)
            ? [COMBINED_KEY]
            : [];
    }

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

function tokenLimitError(preflight, contextTokens) {
    const blocked = preflight.blocked[0];
    const usage = preflight.items.find(item => item.key === blocked.key);
    return new Error(`Token limit exceeded (needs ${usage.total}, context ${contextTokens})`);
}

export class TaskAlreadyRunningError extends Error {
    constructor(taskId) {
        super(`Bulk Combine task is already running: ${taskId}`);
        this.name = 'TaskAlreadyRunningError';
        this.taskId = taskId;
    }
}

export class TaskNotResumableError extends Error {
    constructor(passKey) {
        super(`Bulk Combine pass is not resumable: ${passKey}`);
        this.name = 'TaskNotResumableError';
        this.passKey = passKey;
    }
}

export function createTaskRunner({ executeCompletion, countTokens, emit } = {}) {
    if (typeof executeCompletion !== 'function' || typeof countTokens !== 'function') {
        throw new TypeError('executeCompletion and countTokens are required');
    }

    /**
     * Live per-task operations. Queue runs, prompt assists, and post-processes
     * stay mutually exclusive; item-scoped regenerations overlap any of them
     * and each other, sharing the task's concurrency slots.
     *
     * @type {Map<string, {ops: Set<{kind: string, passKey: string|null, keys: Set<string>, controller: AbortController}>, itemControllers: Map<string, AbortController>, limit: number, inFlight: number, waiters: Array<{resolve: Function, reject: Function}>}>}
     */
    const taskOps = new Map();
    const sendEvent = (taskId, passKey, type, payload = {}) => {
        if (typeof emit !== 'function') return;
        try {
            emit(taskId, { type, taskId, passKey, ...payload });
        } catch {
            // Notifications are advisory; durable checkpoints remain authoritative.
        }
    };

    function opsEntry(taskId) {
        let entry = taskOps.get(taskId);
        if (!entry) {
            entry = { ops: new Set(), itemControllers: new Map(), limit: 1, inFlight: 0, waiters: [] };
            taskOps.set(taskId, entry);
        }
        return entry;
    }

    function pruneEntry(taskId, entry) {
        if (entry.ops.size === 0 && entry.inFlight === 0 && entry.waiters.length === 0) {
            taskOps.delete(taskId);
        }
    }

    function hasBlockingOp(entry, kinds) {
        for (const op of entry.ops) {
            if (kinds.includes(op.kind)) return true;
        }
        return false;
    }

    /** Whether another live op claimed this item of this pass. */
    function claimedByOtherOp(entry, self, passKey, key) {
        for (const op of entry.ops) {
            if (op !== self && op.passKey === passKey && op.keys.has(key)) return true;
        }
        return false;
    }

    /** Whether another live queue run owns this pass's bookkeeping. */
    function hasRunOpForPass(entry, self, passKey) {
        for (const op of entry.ops) {
            if (op !== self && op.kind === 'run' && op.passKey === passKey) return true;
        }
        return false;
    }

    /**
     * Takes a shared per-task concurrency slot; waits when the task's limit is
     * saturated. Rejects with the cancellation error when aborted while queued.
     *
     * @param {object} entry Task op entry.
     * @param {AbortSignal} signal Op abort signal.
     * @returns {Promise<void>} Resolves once the slot is held.
     */
    function acquireSlot(entry, signal) {
        throwIfAborted(signal);
        if (entry.inFlight < entry.limit) {
            entry.inFlight++;
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const waiter = { resolve, reject };
            entry.waiters.push(waiter);
            signal.addEventListener('abort', () => {
                const index = entry.waiters.indexOf(waiter);
                if (index >= 0) {
                    entry.waiters.splice(index, 1);
                    reject(new Error('Job cancelled.'));
                }
            }, { once: true });
        });
    }

    function releaseSlot(entry) {
        const next = entry.waiters.shift();
        if (next) {
            // Hand the slot over; the in-flight count is unchanged.
            next.resolve();
        } else {
            entry.inFlight--;
        }
    }

    async function runPass({
        taskId,
        passKey,
        repo,
        userDirectories,
        scope = 'missing',
        itemKeys = null,
        prepareTask = null,
        onScheduled = null,
    }) {
        if (!PASS_KEYS.includes(passKey)) throw new TypeError(`Invalid pass key: ${passKey}`);
        // Item-scoped runs are regenerations: they overlap queue runs and
        // other regenerations. Queue runs stay exclusive with queue runs,
        // assists, and post-processes; nothing overlaps an assist/post.
        const isRegen = Array.isArray(itemKeys) && itemKeys.length > 0;
        const kind = isRegen ? 'regen' : 'run';
        const entry = opsEntry(taskId);
        if (hasBlockingOp(entry, isRegen ? ['assist', 'post'] : ['run', 'assist', 'post'])) {
            pruneEntry(taskId, entry);
            throw new TaskAlreadyRunningError(taskId);
        }

        const controller = new AbortController();
        const op = { kind, passKey, keys: new Set(), controller };
        entry.ops.add(op);
        const { signal } = controller;

        try {
            const task = typeof prepareTask === 'function'
                ? await prepareTask()
                : await repo.getTask(taskId);
            if (typeof onScheduled === 'function') onScheduled(task);
            entry.limit = Math.max(1, task.settings.concurrency);
            const keys = targetKeys(task, passKey, scope, itemKeys);
            const inputs = deriveInputs(task, passKey);
            const text = promptText(task, passKey);
            const runnableKeys = keys.filter(key => inputs.has(key));
            const hints = new Map(runnableKeys.map(key => [key, newItem(task.passes[passKey].items[key]).regenHint]));
            const prompts = new Map();

            if (task.settings.mode === 'combined' && runnableKeys.length > 0) {
                // One merged prompt: transform1 embeds every source block,
                // transform2/summary feed the upstream merged output document.
                const input = inputs.get(COMBINED_KEY);
                const nudge = hints.get(COMBINED_KEY);
                prompts.set(COMBINED_KEY, input.document !== null
                    ? buildMergedPassPrompt(text, input.document, nudge)
                    : buildCombinedPrompt(input.sources, text, CORE_FIELDS, nudge));
            } else {
                for (const key of runnableKeys) {
                    prompts.set(key, buildIndividualPrompt(inputs.get(key), text, CORE_FIELDS, hints.get(key)));
                }
            }

            const preflight = await preflightTokens({
                prompts: [...prompts].map(([key, prompt]) => ({ key, text: prompt })),
                outputTokens: task.settings.outputTokens,
                contextTokens: task.settings.totalContextTokens,
                model: task.completion?.model ?? null,
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
                if (!isRegen) {
                    pass.status = 'running';
                    draft.activePass = passKey;
                    draft.execution = { status: 'running', pass: passKey, startedAt };
                }
                for (const key of keys) {
                    const item = newItem(pass.items[key]);
                    if (!inputs.has(key)) {
                        item.status = 'skipped';
                        item.error = null;
                    } else if (claimedByOtherOp(entry, op, passKey, key)) {
                        // Claimed by an in-flight run/regeneration — leave it untouched.
                        continue;
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
                            op.keys.add(key);
                        }
                    }
                    pass.items[key] = item;
                }
            });
            sendEvent(taskId, passKey, 'pass_started', { itemKeys: keys });

            // Per-item abort controllers: an item-scoped cancel aborts exactly
            // one card's in-flight work; op-level cancellation reaches them
            // through the op signal. Combined mode shares one controller — a
            // single request covers every claimed key.
            const sharedController = task.settings.mode === 'combined' && op.keys.size > 0
                ? new AbortController()
                : null;
            for (const key of op.keys) {
                const itemController = sharedController ?? new AbortController();
                if (!sharedController) {
                    signal.addEventListener('abort', () => itemController.abort(), { once: true });
                }
                entry.itemControllers.set(`${passKey}:${key}`, itemController);
            }
            if (sharedController) {
                signal.addEventListener('abort', () => sharedController.abort(), { once: true });
            }

            const executableKeys = runnableKeys.filter(key => !blockedKeys.has(key) && op.keys.has(key));

            if (task.settings.mode === 'combined' && executableKeys.length > 0) {
                let attempts = 0;
                let acquired = false;
                const combinedSignal = sharedController?.signal ?? signal;
                try {
                    await acquireSlot(entry, combinedSignal);
                    acquired = true;
                    throwIfAborted(combinedSignal);
                    await repo.checkpoint(taskId, draft => {
                        draft.passes[passKey].items[COMBINED_KEY].status = 'running';
                    });
                    sendEvent(taskId, passKey, 'item_started', { itemKey: COMBINED_KEY });
                    const content = await withRetries(async () => {
                        attempts++;
                        // This run-time completion snapshot is the frontend's sanitized config-resolution seam; the executor resolves secret_id.
                        const output = completionContent(await executeCompletion({
                            body: { ...(task.completion || {}), messages: [{ role: 'user', content: prompts.get(COMBINED_KEY) }], stream: false },
                            userDirectories,
                            signal: combinedSignal,
                        }));
                        if (!output.trim()) throw new Error('Completion returned empty content');
                        return output;
                    }, combinedSignal, 3);
                    // One big pass: the whole response is the merged result.
                    await repo.checkpoint(taskId, draft => {
                        const item = draft.passes[passKey].items[COMBINED_KEY];
                        item.status = 'succeeded';
                        item.output = content;
                        item.error = null;
                        item.attempts += attempts;
                        item.hintApplied = Boolean(hints.get(COMBINED_KEY)?.trim());
                    });
                    sendEvent(taskId, passKey, 'item_succeeded', { itemKey: COMBINED_KEY });
                } catch (error) {
                    try {
                        await repo.checkpoint(taskId, draft => {
                            const item = draft.passes[passKey].items[COMBINED_KEY];
                            if (signal.aborted || combinedSignal.aborted) {
                                if (item.status === 'running') item.status = 'interrupted';
                            } else {
                                item.status = 'failed';
                                item.error = String(error);
                            }
                            item.attempts += attempts;
                            if (attempts > 0) item.hintApplied = Boolean(hints.get(COMBINED_KEY)?.trim());
                        });
                        if (!signal.aborted && combinedSignal.aborted) {
                            sendEvent(taskId, passKey, 'item_cancelled', { itemKey: COMBINED_KEY });
                        } else if (!signal.aborted) {
                            sendEvent(taskId, passKey, 'item_failed', { itemKey: COMBINED_KEY, error: String(error) });
                        }
                    } catch {
                        // A failed checkpoint must not escape the settled combined queue item.
                    }
                } finally {
                    if (acquired) releaseSlot(entry);
                }
            } else if (task.settings.mode !== 'combined' && executableKeys.length > 0) {
                const itemTasks = executableKeys.map(key => async () => {
                    let attempts = 0;
                    let acquired = false;
                    const itemSignal = entry.itemControllers.get(`${passKey}:${key}`)?.signal ?? signal;
                    try {
                        await acquireSlot(entry, itemSignal);
                        acquired = true;
                        throwIfAborted(itemSignal);
                        await repo.checkpoint(taskId, draft => {
                            draft.passes[passKey].items[key].status = 'running';
                        });
                        sendEvent(taskId, passKey, 'item_started', { itemKey: key });
                        const content = await withRetries(async () => {
                            attempts++;
                            // This run-time completion snapshot is the frontend's sanitized config-resolution seam; the executor resolves secret_id.
                            const output = completionContent(await executeCompletion({
                                body: { ...(task.completion || {}), messages: [{ role: 'user', content: prompts.get(key) }], stream: false },
                                userDirectories,
                                signal: itemSignal,
                            }));
                            if (!output.trim()) throw new Error('Completion returned empty content');
                            return output;
                        }, itemSignal, 3);
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
                                    // Op-level cancel keeps queued items resumable.
                                    if (item.status === 'running') item.status = 'interrupted';
                                } else if (itemSignal.aborted) {
                                    // Item-scoped cancel settles the card as interrupted.
                                    if (item.status === 'running' || item.status === 'queued') item.status = 'interrupted';
                                } else {
                                    item.status = 'failed';
                                    item.error = String(error);
                                }
                                item.attempts += attempts;
                                if (attempts > 0) item.hintApplied = Boolean(hints.get(key)?.trim());
                            });
                            if (itemSignal.aborted && !signal.aborted) {
                                sendEvent(taskId, passKey, 'item_cancelled', { itemKey: key });
                            } else if (!signal.aborted) {
                                sendEvent(taskId, passKey, 'item_failed', { itemKey: key, error: String(error) });
                            }
                        } catch {
                            // Every pool task settles even when its failure checkpoint cannot be written.
                        }
                    } finally {
                        if (acquired) releaseSlot(entry);
                    }
                });
                await runWithConcurrency(itemTasks, Math.max(1, task.settings.concurrency));
            }

            const settled = await repo.getTask(taskId);
            if (signal.aborted) {
                if (!isRegen) {
                    const interruptedAt = new Date().toISOString();
                    const interrupted = await repo.checkpoint(taskId, draft => {
                        draft.passes[passKey].status = 'interrupted';
                        draft.activePass = null;
                        draft.execution = { status: 'interrupted', pass: null, interruptedAt };
                    });
                    sendEvent(taskId, passKey, 'pass_cancelled');
                    return { passKey, status: 'interrupted', items: itemStatuses(interrupted, passKey, keys) };
                }
                // Regenerations never own pass bookkeeping; item statuses were
                // already folded by the per-item catch above.
                sendEvent(taskId, passKey, 'pass_cancelled');
                return { passKey, status: 'interrupted', items: itemStatuses(settled, passKey, keys) };
            }

            if (isRegen && hasRunOpForPass(entry, op, passKey)) {
                // A queue run for this pass is live — it finalizes the pass.
                return { passKey, status: settled.passes[passKey]?.status ?? 'running', items: itemStatuses(settled, passKey, keys) };
            }

            const completed = await repo.checkpoint(taskId, draft => {
                const statusKeys = task.settings.mode === 'combined'
                    ? [COMBINED_KEY]
                    : draft.sources.map(source => source.key);
                const status = finalStatus(draft, passKey, statusKeys);
                draft.passes[passKey].status = status;
                if (status === 'succeeded') {
                    draft.passes[passKey].inputRevision = computePassInputHash(draft, passKey);
                }
                if (!isRegen) {
                    draft.activePass = null;
                    draft.execution = { status: 'idle', pass: null };
                }
            });
            const status = completed.passes[passKey].status;
            sendEvent(taskId, passKey, 'pass_completed', { status });
            return { passKey, status, items: itemStatuses(completed, passKey, keys) };
        } finally {
            entry.ops.delete(op);
            for (const key of op.keys) {
                entry.itemControllers.delete(`${passKey}:${key}`);
            }
            pruneEntry(taskId, entry);
        }
    }

    async function runPromptAssist({
        taskId,
        promptKey,
        repo,
        userDirectories,
        prepareTask = null,
        onScheduled = null,
    }) {
        if (!PROMPT_KEYS.includes(promptKey)) throw new TypeError(`Invalid prompt key: ${promptKey}`);

        const entry = opsEntry(taskId);
        if (entry.ops.size > 0) {
            pruneEntry(taskId, entry);
            throw new TaskAlreadyRunningError(taskId);
        }

        const controller = new AbortController();
        const op = { kind: 'assist', passKey: null, keys: new Set(), controller };
        entry.ops.add(op);
        const { signal } = controller;

        try {
            const task = typeof prepareTask === 'function'
                ? await prepareTask()
                : await repo.getTask(taskId);
            if (typeof onScheduled === 'function') onScheduled(task);
            const original = task.prompts[promptKey].text;
            const request = task.prompts[promptKey].assistant.request;
            if (!request.trim()) return { status: 'skipped' };

            try {
                const instruction = `You are helping refine a prompt.\n\nCURRENT PROMPT:\n${original}\n\nREFINEMENT REQUEST:\n${request}\n\nReturn ONLY the revised prompt text, with no commentary or code fences.`;
                const preflight = await preflightTokens({
                    prompts: [{ key: promptKey, text: instruction }],
                    outputTokens: task.settings.outputTokens,
                    contextTokens: task.settings.totalContextTokens,
                    model: task.completion?.model ?? null,
                }, countTokens);
                if (!preflight.ok) throw tokenLimitError(preflight, task.settings.totalContextTokens);

                const proposal = stripCodeFences(await withRetries(async () => {
                    throwIfAborted(signal);
                    return completionContent(await executeCompletion({
                        body: {
                            ...(task.completion || {}),
                            messages: [{ role: 'user', content: instruction }],
                            stream: false,
                        },
                        userDirectories,
                        signal,
                    }));
                }, signal, 3));
                const diff = dmp.patch_toText(dmp.patch_make(original, proposal));
                await repo.checkpoint(taskId, draft => {
                    draft.prompts[promptKey].assistant = {
                        request,
                        proposal,
                        diff,
                        applied: false,
                        error: '',
                    };
                });
                sendEvent(taskId, promptKey, 'prompt_assist_completed');
                return { status: 'succeeded', proposal };
            } catch (error) {
                await repo.checkpoint(taskId, draft => {
                    draft.prompts[promptKey].assistant = {
                        request,
                        proposal: '',
                        diff: '',
                        applied: false,
                        error: String(error),
                    };
                });
                sendEvent(taskId, promptKey, 'prompt_assist_failed', { error: String(error) });
                throw error;
            }
        } finally {
            entry.ops.delete(op);
            pruneEntry(taskId, entry);
        }
    }

    async function runPostProcess({ taskId, repo, userDirectories }) {
        const entry = opsEntry(taskId);
        if (entry.ops.size > 0) {
            pruneEntry(taskId, entry);
            throw new TaskAlreadyRunningError(taskId);
        }

        const controller = new AbortController();
        const op = { kind: 'post', passKey: null, keys: new Set(), controller };
        entry.ops.add(op);
        const { signal } = controller;

        try {
            const task = await repo.getTask(taskId);
            if (!task.settings.postProcessingEnabled) return { status: 'skipped' };

            const input = buildMergedCardDescription(task);
            const mode = task.settings.postProcessingMode;
            if (!input) {
                await repo.checkpoint(taskId, draft => {
                    draft.post = { status: 'skipped', mode, input, output: '', error: null };
                });
                return { status: 'skipped' };
            }

            try {
                const prompt = buildPostProcessPrompt(task.prompts.post.text, input);
                const preflight = await preflightTokens({
                    prompts: [{ key: 'post', text: prompt }],
                    outputTokens: task.settings.outputTokens,
                    contextTokens: task.settings.totalContextTokens,
                    model: task.completion?.model ?? null,
                }, countTokens);
                if (!preflight.ok) throw tokenLimitError(preflight, task.settings.totalContextTokens);

                const content = await withRetries(async () => {
                    throwIfAborted(signal);
                    return completionContent(await executeCompletion({
                        body: {
                            ...(task.completion || {}),
                            messages: [{ role: 'user', content: prompt }],
                            stream: false,
                        },
                        userDirectories,
                        signal,
                    }));
                }, signal, 3);
                const result = applyPostProcess(input, content, mode);
                const ranAt = new Date().toISOString();
                await repo.checkpoint(taskId, draft => {
                    draft.post = {
                        status: 'succeeded',
                        mode,
                        input,
                        output: result.description,
                        error: null,
                        ranAt,
                    };
                });
                sendEvent(taskId, 'post', 'post_process_completed');
                return { status: 'succeeded', output: result.description };
            } catch (error) {
                await repo.checkpoint(taskId, draft => {
                    draft.post = {
                        status: 'failed',
                        mode,
                        input,
                        output: '',
                        error: String(error),
                    };
                });
                sendEvent(taskId, 'post', 'post_process_failed', { error: String(error) });
                throw error;
            }
        } finally {
            entry.ops.delete(op);
            pruneEntry(taskId, entry);
        }
    }

    async function resume({ taskId, passKey, repo, userDirectories, onScheduled = null }) {
        if (!PASS_KEYS.includes(passKey)) throw new TypeError(`Invalid pass key: ${passKey}`);
        const task = await repo.getTask(taskId);
        const pass = task.passes[passKey];
        const hasResumableItem = task.settings.mode === 'combined'
            ? RESUMABLE_STATUSES.has(newItem(pass.items[COMBINED_KEY]).status)
            : task.sources.some(source => RESUMABLE_STATUSES.has(newItem(pass.items[source.key]).status));
        if (pass.status !== 'interrupted' || !hasResumableItem) throw new TaskNotResumableError(passKey);
        if (typeof onScheduled === 'function') onScheduled(task);
        // Persisted live-running items are intentionally excluded to avoid silently billing uncertain work twice.
        return runPass({ taskId, passKey, repo, userDirectories, scope: 'missing' });
    }

    /**
     * Cancels work for a task. Without a scope every live op is aborted; with
     * `{passKey, itemKey}` only that card's in-flight generation is aborted.
     *
     * @param {string} taskId Task id.
     * @param {object} [scope] Optional item scope.
     * @param {string} [scope.passKey] Pass key.
     * @param {string} [scope.itemKey] Item (source) key.
     * @returns {Promise<boolean>} True when something was aborted.
     */
    async function cancel(taskId, { passKey, itemKey } = {}) {
        const entry = taskOps.get(taskId);
        if (!entry) return false;
        if (typeof passKey === 'string' && typeof itemKey === 'string') {
            const controller = entry.itemControllers.get(`${passKey}:${itemKey}`);
            if (!controller || controller.signal.aborted) return false;
            controller.abort();
            return true;
        }
        if (entry.ops.size === 0) return false;
        for (const op of entry.ops) {
            op.controller.abort();
        }
        return true;
    }

    return { runPass, runPromptAssist, runPostProcess, resume, cancel };
}
