import {
    escapeXml,
} from '../../../public/scripts/group-card-xml-parser.js';

export const CORE_FIELDS = Object.freeze([
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
]);
export const ALWAYS_INCLUDED_FIELDS = Object.freeze(['name', 'description']);
export const OPTIONAL_FIELDS = Object.freeze([
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
]);

const CHARACTER_OPEN_TAG = '<character>';
const CHARACTER_CLOSE_TAG = '</character>';

function toString(value) {
    try {
        return String(value ?? '');
    } catch {
        return '';
    }
}

export function normalizeSelectedFields(fields) {
    if (!Array.isArray(fields)) {
        return [...CORE_FIELDS];
    }

    const selected = new Set(fields);
    return [
        ...ALWAYS_INCLUDED_FIELDS,
        ...OPTIONAL_FIELDS.filter((field) => selected.has(field)),
    ];
}

export function getSourceField(source, field) {
    try {
        const value = field === 'name'
            ? source?.fields?.name ?? source?.name
            : source?.fields?.[field] ?? '';
        return toString(value);
    } catch {
        return '';
    }
}

export function buildCharacterXmlBlock(source, fields) {
    const fieldXml = normalizeSelectedFields(fields)
        .map((field) => `  <${field}>${escapeXml(getSourceField(source, field))}</${field}>`)
        .join('\n');

    return `${CHARACTER_OPEN_TAG}\n${fieldXml}\n${CHARACTER_CLOSE_TAG}`;
}

function appendNudge(prompt, nudge) {
    return typeof nudge === 'string' && nudge.trim()
        ? `${prompt}\n\nAdditional guidance: ${nudge}`
        : prompt;
}

export function buildIndividualPrompt(source, promptText, fields, nudge) {
    const prompt = `${toString(promptText)}\n\n${buildCharacterXmlBlock(source, fields)}`;
    return appendNudge(prompt, nudge);
}

export function buildCombinedPrompt(sources, promptText, fields, nudge) {
    const blocks = (Array.isArray(sources) ? sources : [])
        .map((source) => buildCharacterXmlBlock(source, fields))
        .join('\n\n');
    const prompt = `${toString(promptText)}\n\n${blocks}`;
    return appendNudge(prompt, nudge);
}

/**
 * Builds a combined-mode follow-up pass prompt (transform2/summary): the
 * upstream pass's single merged output document is the whole input.
 *
 * @param {string} promptText Pass prompt text.
 * @param {string} inputDocument Upstream merged output.
 * @param {string} [nudge] Optional regeneration hint.
 * @returns {string} Prompt text.
 */
export function buildMergedPassPrompt(promptText, inputDocument, nudge) {
    const prompt = `${toString(promptText)}\n\n${toString(inputDocument).trim()}`;
    return appendNudge(prompt, nudge);
}

export async function preflightTokens({
    prompts,
    outputTokens,
    contextTokens,
    model,
}, countFn) {
    const normalizedOutputTokens = Number.isFinite(outputTokens) && outputTokens > 0
        ? outputTokens
        : 0;
    const hasConstraint = Number.isFinite(contextTokens) && contextTokens > 0;
    const items = [];
    const blocked = [];

    for (const prompt of Array.isArray(prompts) ? prompts : []) {
        const inputTokens = await countFn(prompt?.text, model);
        const total = inputTokens + normalizedOutputTokens;
        const item = { key: prompt?.key, inputTokens, total };
        items.push(item);

        if (hasConstraint && total > contextTokens) {
            blocked.push({
                key: prompt?.key,
                inputTokens,
                overage: total - contextTokens,
            });
        }
    }

    return { ok: blocked.length === 0, blocked, items };
}

export function buildPostProcessPrompt(promptText, inputDescription) {
    return `${toString(promptText).trim()}\n\nMerged character definitions:\n${toString(inputDescription).trim()}`;
}
