import {
    escapeXml,
    extractSummaryFromCharacterBlock,
    extractTopLevelXmlBlocks,
    extractXmlBlocksByTag,
    validateGeneratedGroupCardDescription,
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

function getSourceKey(source) {
    try {
        return toString(source?.key);
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

function extractCharacterBlocks(text) {
    try {
        const characterBlocks = extractXmlBlocksByTag(text, 'character');
        if (characterBlocks.length > 0) {
            return characterBlocks;
        }

        return extractTopLevelXmlBlocks(text).filter((block) => block.tag === 'character');
    } catch {
        return [];
    }
}

function extractBlockName(block) {
    try {
        return toString(extractXmlBlocksByTag(block?.content ?? '', 'name')[0]?.content).trim();
    } catch {
        return '';
    }
}

function sourceRecords(sources) {
    return (Array.isArray(sources) ? sources : []).map((source, index) => ({
        index,
        key: getSourceKey(source),
        name: getSourceField(source, 'name'),
    }));
}

export function parseCombinedResponse(rawOutput, sources, options) {
    const records = sourceRecords(sources);
    const emptyResult = {
        results: {},
        missing: records.map((source) => source.key),
        duplicates: [],
        unknown: [],
    };
    const rawText = toString(rawOutput);

    if (!rawText.trim()) {
        return emptyResult;
    }

    let parsedText = rawText;
    try {
        parsedText = validateGeneratedGroupCardDescription(rawText, records.length);
    } catch {
        // Partial combined responses remain useful when complete character blocks exist.
    }

    const blocks = extractCharacterBlocks(parsedText);
    const nameIndex = new Map();
    const assigned = new Set();
    const resultEntries = [];
    const duplicates = [];
    const unknown = [];

    for (const record of records) {
        const normalizedName = record.name.trim().toLowerCase();
        const matches = nameIndex.get(normalizedName) ?? [];
        matches.push(record);
        nameIndex.set(normalizedName, matches);
    }

    blocks.forEach((block, blockIndex) => {
        const blockName = extractBlockName(block);
        let record;

        if (blockName) {
            const matches = nameIndex.get(blockName.toLowerCase());
            if (!matches?.length) {
                unknown.push(blockName);
                return;
            }

            record = matches.find((candidate) => !assigned.has(candidate.key));
            if (!record) {
                duplicates.push(blockName);
                return;
            }
        } else {
            record = records[blockIndex];
            if (!record) {
                unknown.push('');
                return;
            }
            if (assigned.has(record.key)) {
                duplicates.push(record.name);
                return;
            }
        }

        assigned.add(record.key);
        let summary = '';
        try {
            summary = extractSummaryFromCharacterBlock(block.raw) || '';
        } catch {
            summary = '';
        }
        resultEntries.push([record.key, {
            key: record.key,
            name: record.name,
            xml: block.raw,
            summary,
        }]);
    });

    return {
        results: Object.fromEntries(resultEntries),
        missing: records.filter((source) => !assigned.has(source.key)).map((source) => source.key),
        duplicates,
        unknown,
    };
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
    const hasConstraint = normalizedOutputTokens > 0
        && Number.isFinite(contextTokens)
        && contextTokens > 0;
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
