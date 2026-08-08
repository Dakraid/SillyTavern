import {
    escapeXml,
    extractCommentFromCharacterBlock,
    extractKeysFromCharacterBlock,
    extractXmlBlocksByTag,
    minifyXml,
    stripSummaryFromCharacterBlock,
    validateGeneratedGroupCardDescription,
} from '../../../public/scripts/group-card-xml-parser.js';
import {
    composeSummaries,
    lorebookEntriesFromDocs,
    minifyForFormat,
    serializeDoc,
} from '../../../public/scripts/bulk-combine/structured/export.js';
import { parseStructured } from '../../../public/scripts/bulk-combine/structured/parse.js';

import { COMBINED_KEY } from './task-state.js';
import { toonDecode, toonEncode } from './toon-codec.js';

function sourceName(source) {
    return String(source?.name ?? source?.fields?.name ?? source?.key ?? '');
}

function succeededItems(pass) {
    return Object.values(pass?.items ?? {}).some(item => item?.status === 'succeeded');
}

export function selectFullDescriptionPass(task) {
    return task?.settings?.secondPassEnabled && succeededItems(task?.passes?.transform2)
        ? 'transform2'
        : 'transform1';
}

export function getFullDescriptionSources(task) {
    const pass = task?.passes?.[selectFullDescriptionPass(task)];
    const merged = pass?.items?.[COMBINED_KEY];
    if (merged?.status === 'succeeded') {
        return [{
            key: COMBINED_KEY,
            name: sourceName({ name: task?.name }),
            output: String(merged.output ?? ''),
        }];
    }
    return (Array.isArray(task?.sources) ? task.sources : [])
        .filter(source => pass?.items?.[source.key]?.status === 'succeeded')
        .map(source => ({
            key: source.key,
            name: sourceName(source),
            output: String(pass.items[source.key].output ?? ''),
        }));
}

function buildSummaryBlock(name, summary) {
    return [
        '<character>',
        `  <name>${escapeXml(name)}</name>`,
        `  <description>${escapeXml(summary)}</description>`,
        '</character>',
    ].join('\n');
}

function structuredFormat(task) {
    const format = task?.structure?.format;
    return ['xml', 'json', 'toon'].includes(format) ? format : null;
}

function parseStructuredSource(source, format) {
    const parsed = parseStructured(source.output, format, { toonDecode });
    return {
        ...source,
        doc: parsed.ok ? parsed.doc : null,
        output: parsed.ok ? serializeDoc(parsed.doc, format, { toonEncode }) : source.output,
    };
}

function getStructuredFullSources(task, format) {
    const pass = task?.passes?.[selectFullDescriptionPass(task)];
    const include = item => item?.status === 'succeeded'
        || (item?.status === 'failed' && String(item.error ?? '').startsWith('Unparseable '));
    const merged = pass?.items?.[COMBINED_KEY];
    if (include(merged)) {
        return [parseStructuredSource({
            key: COMBINED_KEY,
            name: sourceName({ name: task?.name }),
            output: String(merged.output ?? ''),
        }, format)];
    }
    return (Array.isArray(task?.sources) ? task.sources : [])
        .filter(source => include(pass?.items?.[source.key]))
        .map(source => parseStructuredSource({
            key: source.key,
            name: sourceName(source),
            output: String(pass.items[source.key].output ?? ''),
        }, format));
}

function getStructuredDescriptionSources(task, fullSources, format) {
    if (task?.settings?.destination !== 'lorebook') return fullSources;

    const summaryItems = task?.passes?.summary?.items ?? {};
    return fullSources.map((source) => {
        const summary = summaryItems[source.key];
        return summary?.status === 'succeeded'
            ? parseStructuredSource({ ...source, output: String(summary.output ?? '') }, format)
            : source;
    });
}

function minifyStructured(task, text, format) {
    return format !== 'xml' || task?.settings?.xmlMinify
        ? minifyForFormat(text, format)
        : text;
}

/**
 * In lorebook mode a missing successful summary deliberately falls back to the
 * latest successful full output so a character is not silently omitted.
 */
export function getCardDescriptionBlocks(task) {
    const format = structuredFormat(task);
    if (format) {
        const fullSources = getStructuredFullSources(task, format);
        return getStructuredDescriptionSources(task, fullSources, format).map(source => ({
            key: source.key,
            name: source.name,
            xml: source.output,
        }));
    }

    const fullSources = new Map(getFullDescriptionSources(task).map(source => [source.key, source]));
    if (task?.settings?.destination !== 'lorebook') {
        return [...fullSources.values()].map(source => ({
            key: source.key,
            name: source.name,
            xml: source.output,
        }));
    }

    const mergedSummary = task?.passes?.summary?.items?.[COMBINED_KEY];
    if (mergedSummary?.status === 'succeeded') {
        const name = sourceName({ name: task?.name });
        return [{ key: COMBINED_KEY, name, xml: buildSummaryBlock(name, mergedSummary.output) }];
    }
    const mergedFull = fullSources.get(COMBINED_KEY);
    if (mergedFull) {
        return [{ key: COMBINED_KEY, name: mergedFull.name, xml: mergedFull.output }];
    }

    return (Array.isArray(task?.sources) ? task.sources : []).flatMap((source) => {
        const name = sourceName(source);
        const summary = task?.passes?.summary?.items?.[source.key];
        if (summary?.status === 'succeeded') {
            return [{ key: source.key, name, xml: buildSummaryBlock(name, summary.output) }];
        }
        const full = fullSources.get(source.key);
        return full ? [{ key: source.key, name, xml: full.output }] : [];
    });
}

function characterName(block, fallback) {
    const name = extractXmlBlocksByTag(block.content, 'name')[0]?.content;
    return String(name ?? '').trim() || fallback;
}

function lorebookEntry(core, index) {
    return {
        uid: index,
        key: core.key,
        keysecondary: [],
        comment: core.comment,
        content: core.content,
        constant: false,
        selective: false,
        order: 100 - index,
        position: 0,
        disable: false,
        addMemo: true,
        excludeRecursion: false,
        delayUntilRecursion: false,
        probability: 100,
        useProbability: true,
        depth: 4,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        preventRecursion: false,
        scanDepth: null,
        caseSensitive: null,
        matchWholeWords: null,
        useGroupScoring: null,
        automation_id: '',
        role: null,
        vectorized: false,
        displayIndex: index,
        sticky: 0,
        cooldown: 0,
        delay: 0,
    };
}

function buildLorebookEntry(block, source, index) {
    const name = characterName(block, source.name);
    const keys = extractKeysFromCharacterBlock(block);
    const comment = extractCommentFromCharacterBlock(block);
    return lorebookEntry({
        key: keys.length ? keys : [name],
        comment: comment || name,
        content: stripSummaryFromCharacterBlock(block.raw),
    }, index);
}

export function buildLorebookData(task) {
    if (task?.settings?.destination !== 'lorebook') return { entries: {} };

    const format = structuredFormat(task);
    if (format) {
        const entries = getStructuredFullSources(task, format).map((source, index) => {
            if (!source.doc) {
                return lorebookEntry({
                    key: [source.name],
                    comment: source.name,
                    content: source.output,
                }, index);
            }
            const core = lorebookEntriesFromDocs([source.doc], format, {
                sourceNames: [source.name],
                codecs: { toonEncode },
            })[0];
            core.content = minifyStructured(task, core.content, format);
            return lorebookEntry(core, index);
        });
        return { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
    }

    const entries = [];
    for (const source of getFullDescriptionSources(task)) {
        for (const block of extractXmlBlocksByTag(source.output, 'character')) {
            entries.push(buildLorebookEntry(block, source, entries.length));
        }
    }
    return { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
}

export function buildMergedCardDescription(task) {
    const format = structuredFormat(task);
    if (!format) {
        const description = getCardDescriptionBlocks(task).map(block => block.xml).join('\n\n');
        return task?.settings?.xmlMinify ? minifyXml(description, { compact: true }) : description;
    }

    let description;
    if (task?.settings?.destination === 'lorebook') {
        const fullSources = getStructuredFullSources(task, format);
        const selected = getStructuredDescriptionSources(task, fullSources, format);
        const parsedDocs = selected.filter(source => source.doc).map(source => source.doc);
        const rawOutputs = selected.filter(source => !source.doc).map(source => source.output);
        description = [composeSummaries(parsedDocs, format, { toonEncode }), ...rawOutputs].join('\n\n');
    } else {
        description = getCardDescriptionBlocks(task).map(block => block.xml).join('\n\n');
    }
    return minifyStructured(task, description, format);
}

export function applyPostProcess(baseDescription, postOutput, mode, format = 'none') {
    if (format !== 'none' && format !== 'xml' && (typeof postOutput !== 'string' || !postOutput.trim())) {
        throw new Error('Generation returned empty output.');
    }
    const output = format === 'none' || format === 'xml'
        ? validateGeneratedGroupCardDescription(postOutput, 0)
        : postOutput;
    if (!output.trim()) throw new Error('Generation returned empty output.');
    if (mode === 'prepend') return { description: `${output}\n\n${baseDescription}` };
    return { description: `${baseDescription}\n\n${output}` };
}

export function assembleReviewPayload(task) {
    const mergedDescription = buildMergedCardDescription(task);
    return {
        fullSourcePass: selectFullDescriptionPass(task),
        cardBlocks: getCardDescriptionBlocks(task),
        lorebookData: buildLorebookData(task),
        mergedDescription,
        post: {
            enabled: task?.settings?.postProcessingEnabled === true,
            mode: task?.settings?.postProcessingMode ?? 'append',
            input: mergedDescription,
            output: typeof task?.post?.output === 'string' ? task.post.output : '',
        },
        destination: task?.settings?.destination ?? 'card',
    };
}
