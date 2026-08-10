import { createHash, randomUUID } from 'node:crypto';

import { DEFAULT_TEMPLATE, normalizeTemplate } from '../../../public/scripts/bulk-combine/structured/templateModel.js';
import { OPTIONAL_FIELDS, resolveCaptureFields } from './prompt-builders.js';

export const SCHEMA_VERSION = 1;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PASS_KEYS = ['transform1', 'transform2', 'summary'];
const PROMPT_KEYS = ['main', 'secondPass', 'summary', 'post'];
const STRUCTURE_FORMATS = ['xml', 'json', 'toon', 'none'];

/** Item key of the single merged item in merged passes. */
export const COMBINED_KEY = '__combined__';

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
    return { request: '', proposal: '', diff: '', applied: false, error: '' };
}

function newPrompt() {
    return { text: '', assistant: newAssistantProposal() };
}

export function newPass() {
    return { status: 'pending', inputRevision: null, items: {} };
}

function defaultStructure(format = 'xml') {
    return { format, template: normalizeTemplate(DEFAULT_TEMPLATE) };
}

function defaultSettings() {
    return {
        secondPassMode: 'individual',
        concurrency: 1,
        connectionProfile: null,
        preset: null,
        totalContextTokens: null,
        outputTokens: null,
        destination: 'card',
        xmlMinify: false,
        postProcessingEnabled: false,
        postProcessingMode: 'append',
        secondPassEnabled: false,
        fields: [...OPTIONAL_FIELDS],
        refusalRetries: 3,
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
        structure: defaultStructure(),
        sourceNotes: {},
        sourceFields: {},
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

function normalizeStructure(input, isLegacy) {
    if (isLegacy) return defaultStructure('none');
    const structure = isRecord(input) ? input : {};
    return {
        format: STRUCTURE_FORMATS.includes(structure.format) ? structure.format : 'xml',
        template: normalizeTemplate(Array.isArray(structure.template) ? structure.template : DEFAULT_TEMPLATE),
    };
}

function normalizeSourceNotes(input) {
    if (!isRecord(input)) return {};
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === 'string' ? value : String(value)]));
}

function normalizeSourceFields(input) {
    if (!isRecord(input)) return {};
    return Object.fromEntries(Object.entries(input)
        .filter(([, fields]) => Array.isArray(fields))
        .map(([key, fields]) => [key, OPTIONAL_FIELDS.filter(field => fields.includes(field))]));
}

function normalizeSettings(input) {
    const defaults = defaultSettings();
    if (!isRecord(input)) return defaults;

    return {
        secondPassMode: input.mode === 'combined' || input.secondPassMode === 'combined' ? 'combined' : defaults.secondPassMode,
        concurrency: Number.isSafeInteger(input.concurrency) && input.concurrency > 0 ? input.concurrency : defaults.concurrency,
        connectionProfile: typeof input.connectionProfile === 'string' && input.connectionProfile ? input.connectionProfile : null,
        preset: typeof input.preset === 'string' && input.preset ? input.preset : null,
        totalContextTokens: normalizeNullableInteger(input.totalContextTokens),
        outputTokens: normalizeNullableInteger(input.outputTokens),
        destination: ['card', 'lorebook'].includes(input.destination) ? input.destination : defaults.destination,
        xmlMinify: typeof input.xmlMinify === 'boolean' ? input.xmlMinify : defaults.xmlMinify,
        postProcessingEnabled: typeof input.postProcessingEnabled === 'boolean' ? input.postProcessingEnabled : defaults.postProcessingEnabled,
        postProcessingMode: ['prepend', 'append'].includes(input.postProcessingMode)
            ? input.postProcessingMode
            : defaults.postProcessingMode,
        secondPassEnabled: typeof input.secondPassEnabled === 'boolean' ? input.secondPassEnabled : defaults.secondPassEnabled,
        fields: Array.isArray(input.fields)
            ? OPTIONAL_FIELDS.filter(field => input.fields.includes(field))
            : defaults.fields,
        refusalRetries: Number.isSafeInteger(input.refusalRetries) && input.refusalRetries >= 0 && input.refusalRetries <= 5
            ? input.refusalRetries
            : defaults.refusalRetries,
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
        error: typeof assistant.error === 'string' ? assistant.error : '',
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
        structure: normalizeStructure(source.structure, !Object.hasOwn(source, 'structure')),
        sourceNotes: normalizeSourceNotes(source.sourceNotes),
        sourceFields: normalizeSourceFields(source.sourceFields),
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
        && ['request', 'proposal', 'diff', 'error'].every(key => typeof value.assistant[key] === 'string')
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

function isStructure(value) {
    return isRecord(value) && STRUCTURE_FORMATS.includes(value.format) && Array.isArray(value.template);
}

function isSourceNotes(value) {
    return isRecord(value) && Object.values(value).every(note => typeof note === 'string');
}

function isFieldSelection(value) {
    return Array.isArray(value) && value.every(field => OPTIONAL_FIELDS.includes(field));
}

function isSourceFields(value) {
    return isRecord(value) && Object.values(value).every(isFieldSelection);
}

function isSettings(value) {
    return isRecord(value)
        && ['individual', 'combined'].includes(value.secondPassMode)
        && Number.isSafeInteger(value.concurrency) && value.concurrency > 0
        && (value.connectionProfile === null || typeof value.connectionProfile === 'string')
        && (value.preset === null || typeof value.preset === 'string')
        && isNullableInteger(value.totalContextTokens)
        && isNullableInteger(value.outputTokens)
        && ['card', 'lorebook'].includes(value.destination)
        && typeof value.xmlMinify === 'boolean'
        && typeof value.postProcessingEnabled === 'boolean'
        && ['prepend', 'append'].includes(value.postProcessingMode)
        && typeof value.secondPassEnabled === 'boolean'
        && isFieldSelection(value.fields)
        && Number.isSafeInteger(value.refusalRetries)
        && value.refusalRetries >= 0 && value.refusalRetries <= 5;
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
        && isStructure(input.structure)
        && isSourceNotes(input.sourceNotes)
        && isSourceFields(input.sourceFields)
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

/**
 * Returns only settings that affect generated pass inputs. Concurrency is
 * intentionally excluded because it changes scheduling, not generation.
 * @param {object} settings Task generation settings
 * @param {object} completion Sanitized completion-generation settings
 * @returns {object} Stable generation-affecting settings subset
 */
export function relevantSettings(settings = {}, completion = {}) {
    return {
        secondPassMode: settings.secondPassMode,
        totalContextTokens: settings.totalContextTokens,
        outputTokens: settings.outputTokens,
        destination: settings.destination,
        connectionProfile: settings.connectionProfile,
        preset: settings.preset,
        completion,
    };
}

function hasSucceededOutput(pass) {
    return Object.values(pass?.items || {}).some(item => item?.status === 'succeeded');
}

function sourcesWithSucceededOutputs(task, pass) {
    return task.sources
        .filter(source => pass.items[source.key]?.status === 'succeeded')
        .map(source => ({
            ...source,
            fields: {
                ...source.fields,
                description: pass.items[source.key].output,
            },
            captureFields: resolveCaptureFields(task, source.key),
        }));
}

/**
 * Joins succeeded per-source Transform-1 outputs for a merged Transform-2,
 * falling back to a legacy merged Transform-1 item.
 * @param {object} task Bulk Combine task
 * @returns {string} Merged Transform-1 document
 */
export function transform2CombinedDocument(task) {
    const outputs = task.sources
        .filter(source => task.passes.transform1.items[source.key]?.status === 'succeeded')
        .map(source => String(task.passes.transform1.items[source.key].output ?? ''));
    if (outputs.length > 0) return outputs.join('\n\n');

    const legacy = task.passes.transform1.items[COMBINED_KEY];
    return legacy?.status === 'succeeded' ? String(legacy.output ?? '') : '';
}

/** Wraps a succeeded merged pass output as one synthetic source document. */
function combinedInputSource(pass) {
    const item = pass?.items?.[COMBINED_KEY];
    return item?.status === 'succeeded'
        ? [{ key: COMBINED_KEY, name: COMBINED_KEY, fields: { description: String(item.output ?? '') } }]
        : [];
}

function passStaleness(pass, currentRevision, upstreamStale = false) {
    if (!hasSucceededOutput(pass) || !pass.inputRevision) {
        return { stale: false, reason: 'not_run' };
    }
    if (upstreamStale) return { stale: true, reason: 'upstream_stale' };
    return pass.inputRevision === currentRevision
        ? { stale: false, reason: 'current' }
        : { stale: true, reason: 'input_changed' };
}

// Shared input-hash contract used by BOTH the runner (to record inputRevision on
// success) and deriveStaleness (to detect drift). They MUST agree field-for-field
// or staleness will be wrong. Mirrors the runner's per-pass input/prompt derivation.
function passInputPrompts(task, passKey) {
    if (passKey === 'transform2') return [task.prompts.main.text, task.prompts.secondPass.text];
    if (passKey === 'summary') return [task.prompts.summary.text];
    return [task.prompts.main.text];
}
function passInputSources(task, passKey) {
    if (passKey === 'transform1') {
        return task.sources.map(source => ({
            ...source,
            notes: task.sourceNotes?.[source.key] ?? '',
            captureFields: resolveCaptureFields(task, source.key),
        }));
    }
    if (passKey === 'transform2') {
        if (!task.settings.secondPassEnabled) return [];
        if (task.settings.secondPassMode === 'combined') {
            const document = transform2CombinedDocument(task);
            // Mirror the runner: no document, no input (keeps the shared hash in parity).
            return document
                ? [{ key: COMBINED_KEY, name: task.name || COMBINED_KEY, fields: { description: document } }]
                : [];
        }
        return sourcesWithSucceededOutputs(task, task.passes.transform1);
    }
    const useTransform2 = task.settings.secondPassEnabled && hasSucceededOutput(task.passes.transform2);
    const upstream = useTransform2 ? task.passes.transform2 : task.passes.transform1;
    return upstream.items[COMBINED_KEY]?.status === 'succeeded'
        ? combinedInputSource(upstream)
        : sourcesWithSucceededOutputs(task, upstream);
}

/**
 * Computes the canonical input hash a pass was / will be run against.
 * @param {object} task Bulk Combine task
 * @param {string} passKey 'transform1' | 'transform2' | 'summary'
 * @returns {string} sha256 hex of the pass's canonical inputs
 */
export function computePassInputHash(task, passKey) {
    return hashInputs({
        sources: passInputSources(task, passKey),
        prompts: passInputPrompts(task, passKey),
        settings: relevantSettings(task.settings, task.completion),
        structure: { format: task.structure.format, template: task.structure.template },
    });
}

/**
 * Derives pass staleness without changing the persisted task or its outputs.
 * @param {object} task Bulk Combine task
 * @returns {object} Derived staleness for each generated pass
 */
export function deriveStaleness(task) {
    const transform1 = passStaleness(task.passes.transform1, computePassInputHash(task, 'transform1'));

    let transform2 = { stale: false, reason: 'disabled' };
    if (task.settings.secondPassEnabled) {
        transform2 = passStaleness(task.passes.transform2, computePassInputHash(task, 'transform2'), transform1.stale);
    }

    const useTransform2 = task.settings.secondPassEnabled && hasSucceededOutput(task.passes.transform2);
    const summary = passStaleness(
        task.passes.summary,
        computePassInputHash(task, 'summary'),
        useTransform2 ? transform2.stale : transform1.stale,
    );

    return { transform1, transform2, summary };
}
