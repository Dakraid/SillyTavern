import {
    countXmlCorpus,
    escapeXml,
    extractCommentFromCharacterBlock,
    extractKeysFromCharacterBlock,
    extractXmlBlocksByTag,
    minifyXml,
    stripSummaryFromCharacterBlock,
    validateGeneratedGroupCardDescription,
} from '../../../public/scripts/group-card-xml-parser.js';

import { COMBINED_KEY } from './task-state.js';

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
    // Combined mode: the pass holds one merged output for all sources.
    if (task?.settings?.mode === 'combined') {
        const item = pass?.items?.[COMBINED_KEY];
        return item?.status === 'succeeded'
            ? [{ key: COMBINED_KEY, name: sourceName({ name: task?.name }), output: String(item.output ?? '') }]
            : [];
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

/**
 * In lorebook mode a missing successful summary deliberately falls back to the
 * latest successful full output so a character is not silently omitted.
 */
export function getCardDescriptionBlocks(task) {
    const fullSources = new Map(getFullDescriptionSources(task).map(source => [source.key, source]));
    if (task?.settings?.destination !== 'lorebook') {
        return [...fullSources.values()].map(source => ({
            key: source.key,
            name: source.name,
            xml: source.output,
        }));
    }

    // Combined mode in lorebook destination: one merged block, summarized
    // when the combined summary pass succeeded.
    if (task?.settings?.mode === 'combined') {
        const name = sourceName({ name: task?.name });
        const summary = task?.passes?.summary?.items?.[COMBINED_KEY];
        if (summary?.status === 'succeeded') {
            return [{ key: COMBINED_KEY, name, xml: buildSummaryBlock(name, summary.output) }];
        }
        const full = fullSources.get(COMBINED_KEY);
        return full ? [{ key: COMBINED_KEY, name, xml: full.output }] : [];
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

function buildLorebookEntry(block, source, index) {
    const name = characterName(block, source.name);
    const keys = extractKeysFromCharacterBlock(block);
    const comment = extractCommentFromCharacterBlock(block);
    return {
        uid: index,
        key: keys.length ? keys : [name],
        keysecondary: [],
        comment: comment || name,
        content: stripSummaryFromCharacterBlock(block.raw),
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

export function buildLorebookData(task) {
    if (task?.settings?.destination !== 'lorebook') return { entries: {} };

    const entries = [];
    for (const source of getFullDescriptionSources(task)) {
        for (const block of extractXmlBlocksByTag(source.output, 'character')) {
            entries.push(buildLorebookEntry(block, source, entries.length));
        }
    }
    return { entries: Object.fromEntries(entries.map(entry => [entry.uid, entry])) };
}

export function buildMergedCardDescription(task) {
    const description = getCardDescriptionBlocks(task).map(block => block.xml).join('\n\n');
    return task?.settings?.xmlMinify ? minifyXml(description, { compact: true }) : description;
}

export function applyPostProcess(baseDescription, postOutput, mode) {
    const output = validateGeneratedGroupCardDescription(postOutput, 0);
    if (mode === 'prepend') return { description: `${output}\n\n${baseDescription}` };
    if (mode === 'append') return { description: `${baseDescription}\n\n${output}` };

    const inputCorpusCount = countXmlCorpus(baseDescription);
    const outputCorpusCount = countXmlCorpus(output);
    if (inputCorpusCount > 0 && outputCorpusCount !== inputCorpusCount) {
        throw new Error(
            `Post-processing returned ${outputCorpusCount} root XML corpus block(s), expected ${inputCorpusCount}.`,
        );
    }
    return { description: output };
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
            mode: task?.settings?.postProcessingMode ?? 'replace',
            input: mergedDescription,
            output: typeof task?.post?.output === 'string' ? task.post.output : '',
        },
        destination: task?.settings?.destination ?? 'card',
    };
}
