import { createHash, randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASS_KEYS = ['transform1', 'transform2', 'summary'];
const PROMPT_KEYS = ['main', 'secondPass', 'summary', 'post'];

function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toIsoDate(value, fallback) {
    if (value === null || value === undefined || value === '') return fallback;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function clone(value, fallback) {
    try {
        return structuredClone(value);
    } catch {
        return fallback;
    }
}

function newAssistantProposal() {
    return { request: '', proposal: '', diff: '', applied: false };
}

function newPrompt() {
    return { text: '', assistant: newAssistantProposal() };
}

export function newPass() {
    return { status: 'pending', inputRevision: null, items: {} };
}

function defaultSettings() {
    return {
        mode: 'individual',
        concurrency: 1,
        connectionProfile: null,
        preset: null,
        totalContextTokens: null,
        outputTokens: null,
        destination: 'card',
        xmlEnabled: false,
        xmlMinify: false,
        postProcessingEnabled: false,
        postProcessingMode: 'replace',
        secondPassEnabled: false,
    };
}

function defaultPrompts() {
    return Object.fromEntries(PROMPT_KEYS.map(key => [key, newPrompt()]));
}

function defaultPasses() {
    return Object.fromEntries(PASS_KEYS.map(key => [key, newPass()]));
}

export function generateTaskId() {
    return randomUUID();
}

export function isTaskId(value) {
    return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function createEmptyTask({ name, id, createdAt } = {}) {
    const now = toIsoDate(createdAt, new Date().toISOString());
    const expiresAt = new Date(Date.parse(now) + DEFAULT_TTL_MS).toISOString();
    return {
        id: isTaskId(id) ? id : generateTaskId(),
        schemaVersion: SCHEMA_VERSION,
        name: typeof name === 'string' && name.trim() ? name.trim() : 'Untitled task',
        revision: 1,
        status: 'draft',
        currentPage: 1,
        furthestPage: 1,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        archivedAt: null,
        expiresAt,
        activePass: null,
        execution: {
            status: 'idle',
            pass: null,
            startedAt: null,
            interruptedAt: null,
        },
        sources: [],
        settings: defaultSettings(),
        prompts: defaultPrompts(),
        passes: defaultPasses(),
        completion: {},
        lorebook: {},
        post: {},
        review: {},
        avatar: {},
        artifacts: {},
    };
}

function normalizeNullableInteger(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeInputRevision(value) {
    return (typeof value === 'string' && value.length > 0)
        || (Number.isSafeInteger(value) && value > 0)
        ? value
        : null;
}

function normalizeSettings(input) {
    const defaults = defaultSettings();
    if (!isRecord(input)) return defaults;

    return {
        mode: ['individual', 'combined'].includes(input.mode) ? input.mode : defaults.mode,
        concurrency: Number.isSafeInteger(input.concurrency) && input.concurrency > 0 ? input.concurrency : defaults.concurrency,
        connectionProfile: typeof input.connectionProfile === 'string' && input.connectionProfile ? input.connectionProfile : null,
        preset: typeof input.preset === 'string' && input.preset ? input.preset : null,
        totalContextTokens: normalizeNullableInteger(input.totalContextTokens),
        outputTokens: normalizeNullableInteger(input.outputTokens),
        destination: ['card', 'lorebook'].includes(input.destination) ? input.destination : defaults.destination,
        xmlEnabled: typeof input.xmlEnabled === 'boolean' ? input.xmlEnabled : defaults.xmlEnabled,
        xmlMinify: typeof input.xmlMinify === 'boolean' ? input.xmlMinify : defaults.xmlMinify,
        postProcessingEnabled: typeof input.postProcessingEnabled === 'boolean' ? input.postProcessingEnabled : defaults.postProcessingEnabled,
        postProcessingMode: ['replace', 'prepend', 'append'].includes(input.postProcessingMode)
            ? input.postProcessingMode
            : defaults.postProcessingMode,
        secondPassEnabled: typeof input.secondPassEnabled === 'boolean' ? input.secondPassEnabled : defaults.secondPassEnabled,
    };
}

function normalizePrompt(input) {
    const prompt = newPrompt();
    if (typeof input === 'string') {
        prompt.text = input;
        return prompt;
    }
    if (!isRecord(input)) return prompt;

    prompt.text = typeof input.text === 'string' ? input.text : '';
    const assistant = isRecord(input.assistant) ? input.assistant : {};
    prompt.assistant = {
        request: typeof assistant.request === 'string' ? assistant.request : '',
        proposal: typeof assistant.proposal === 'string' ? assistant.proposal : '',
        diff: typeof assistant.diff === 'string' ? assistant.diff : '',
        applied: typeof assistant.applied === 'boolean' ? assistant.applied : false,
    };
    return prompt;
}

function normalizePass(input) {
    if (!isRecord(input)) return newPass();
    return {
        status: typeof input.status === 'string' && input.status ? input.status : 'pending',
        inputRevision: normalizeInputRevision(input.inputRevision),
        items: isRecord(input.items) ? clone(input.items, {}) : {},
    };
}

function normalizeExecution(input) {
    const execution = isRecord(input) ? input : {};
    return {
        status: typeof execution.status === 'string' && execution.status ? execution.status : 'idle',
        pass: typeof execution.pass === 'string' && execution.pass ? execution.pass : null,
        startedAt: toIsoDate(execution.startedAt, null),
        interruptedAt: toIsoDate(execution.interruptedAt, null),
    };
}

/**
 * Repairs a persisted record into the current schema. Unknown top-level keys are
 * deliberately dropped so patches cannot turn task.json into an unbounded bag.
 * @param {unknown} input Persisted or partial task state
 * @returns {object} Canonical task state
 */
export function normalizeTask(input) {
    const source = isRecord(input) ? input : {};
    const base = createEmptyTask({
        id: source.id,
        name: source.name,
        createdAt: source.createdAt,
    });
    const createdAt = toIsoDate(source.createdAt, base.createdAt);
    const updatedAt = toIsoDate(source.updatedAt, createdAt);
    const lastActivityAt = toIsoDate(source.lastActivityAt, updatedAt);
    const defaultExpiry = new Date(Date.parse(lastActivityAt) + DEFAULT_TTL_MS).toISOString();
    const currentPage = Number.isSafeInteger(source.currentPage) && source.currentPage > 0 ? source.currentPage : 1;
    const furthestPage = Number.isSafeInteger(source.furthestPage) && source.furthestPage >= currentPage
        ? source.furthestPage
        : currentPage;

    return {
        ...base,
        id: isTaskId(source.id) ? source.id : base.id,
        schemaVersion: SCHEMA_VERSION,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim() : base.name,
        revision: Number.isSafeInteger(source.revision) && source.revision > 0 ? source.revision : 1,
        status: typeof source.status === 'string' && source.status ? source.status : 'draft',
        currentPage,
        furthestPage,
        createdAt,
        updatedAt,
        lastActivityAt,
        archivedAt: toIsoDate(source.archivedAt, null),
        expiresAt: toIsoDate(source.expiresAt, defaultExpiry),
        activePass: typeof source.activePass === 'string' && source.activePass ? source.activePass : null,
        execution: normalizeExecution(source.execution),
        sources: Array.isArray(source.sources) ? clone(source.sources, []) : [],
        settings: normalizeSettings(source.settings),
        prompts: Object.fromEntries(PROMPT_KEYS.map(key => [key, normalizePrompt(source.prompts?.[key])])),
        passes: Object.fromEntries(PASS_KEYS.map(key => [key, normalizePass(source.passes?.[key])])),
        completion: isRecord(source.completion) ? clone(source.completion, {}) : {},
        lorebook: isRecord(source.lorebook) ? clone(source.lorebook, {}) : {},
        post: isRecord(source.post) ? clone(source.post, {}) : {},
        review: isRecord(source.review) ? clone(source.review, {}) : {},
        avatar: isRecord(source.avatar) ? clone(source.avatar, {}) : {},
        artifacts: isRecord(source.artifacts) ? clone(source.artifacts, {}) : {},
    };
}

function isIsoDate(value) {
    return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPrompt(value) {
    return isRecord(value)
        && typeof value.text === 'string'
        && isRecord(value.assistant)
        && ['request', 'proposal', 'diff'].every(key => typeof value.assistant[key] === 'string')
        && typeof value.assistant.applied === 'boolean';
}

function isPass(value) {
    return isRecord(value)
        && typeof value.status === 'string'
        && (value.inputRevision === null
            || (typeof value.inputRevision === 'string' && value.inputRevision.length > 0)
            || (Number.isSafeInteger(value.inputRevision) && value.inputRevision > 0))
        && isRecord(value.items);
}

function isNullableInteger(value) {
    return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function isSettings(value) {
    return isRecord(value)
        && ['individual', 'combined'].includes(value.mode)
        && Number.isSafeInteger(value.concurrency) && value.concurrency > 0
        && (value.connectionProfile === null || typeof value.connectionProfile === 'string')
        && (value.preset === null || typeof value.preset === 'string')
        && isNullableInteger(value.totalContextTokens)
        && isNullableInteger(value.outputTokens)
        && ['card', 'lorebook'].includes(value.destination)
        && typeof value.xmlEnabled === 'boolean'
        && typeof value.xmlMinify === 'boolean'
        && typeof value.postProcessingEnabled === 'boolean'
        && ['replace', 'prepend', 'append'].includes(value.postProcessingMode)
        && typeof value.secondPassEnabled === 'boolean';
}

function isExecution(value) {
    return isRecord(value)
        && typeof value.status === 'string' && Boolean(value.status)
        && (value.pass === null || typeof value.pass === 'string')
        && (value.startedAt === null || isIsoDate(value.startedAt))
        && (value.interruptedAt === null || isIsoDate(value.interruptedAt));
}

export function isValidTask(input) {
    if (!isRecord(input)) return false;
    return isTaskId(input.id)
        && input.schemaVersion === SCHEMA_VERSION
        && typeof input.name === 'string' && Boolean(input.name.trim())
        && Number.isSafeInteger(input.revision) && input.revision > 0
        && typeof input.status === 'string' && Boolean(input.status)
        && Number.isSafeInteger(input.currentPage) && input.currentPage > 0
        && Number.isSafeInteger(input.furthestPage) && input.furthestPage >= input.currentPage
        && ['createdAt', 'updatedAt', 'lastActivityAt', 'expiresAt'].every(key => isIsoDate(input[key]))
        && (input.archivedAt === null || isIsoDate(input.archivedAt))
        && (input.activePass === null || typeof input.activePass === 'string')
        && isExecution(input.execution)
        && Array.isArray(input.sources)
        && isSettings(input.settings)
        && PROMPT_KEYS.every(key => isPrompt(input.prompts?.[key]))
        && PASS_KEYS.every(key => isPass(input.passes?.[key]))
        && isRecord(input.completion)
        && ['lorebook', 'post', 'review', 'avatar', 'artifacts'].every(key => isRecord(input[key]));
}

function canonicalize(value, seen) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value !== 'object') return null;
    if (seen.has(value)) throw new TypeError('Cannot hash cyclic input');
    seen.add(value);
    let result;
    if (Array.isArray(value)) {
        result = value.map(item => canonicalize(item, seen));
    } else if (value instanceof Date) {
        result = value.toJSON();
    } else {
        result = {};
        for (const key of Object.keys(value).sort()) {
            result[key] = canonicalize(value[key], seen);
        }
    }
    seen.delete(value);
    return result;
}

export function hashInputs(value) {
    const canonicalJson = JSON.stringify(canonicalize(value, new Set()));
    return createHash('sha256').update(canonicalJson).digest('hex');
}
