/**
 * Shared XML parser utilities for group card generation.
 * Used by both client (BulkEditOverlay) and server (group-card-job).
 * @module group-card-xml-parser
 */

/**
 * Escapes XML/HTML special characters.
 * @param {string} value
 * @returns {string}
 */
export function escapeXml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll('\'', '&#039;');
}

/**
 * Strips markdown code fences from LLM output.
 * @param {string} output
 * @returns {string}
 */
export function stripNoise(output) {
    let text = String(output ?? '').trim();
    text = text.replace(/```[a-zA-Z]*\s*\n?/g, '').replace(/```/g, '');
    return text.trim();
}

/**
 * Builds open-tag regex for a given tag name.
 * Matches <tag>, <tag attr="...">, etc. but NOT self-closing <tag/>.
 * @param {string} tagName
 * @returns {RegExp}
 */
export function openTagRegexFor(tagName) {
    return new RegExp(`<${tagName}(?:\\s+[^>]*[^/])?>`, 'g');
}

/**
 * Extracts top-level XML blocks for a given tag name.
 * Handles attributes, nested same-name tags (depth tracking), mixed content.
 * @param {string} text
 * @param {string} tagName
 * @returns {Array<{tag: string, content: string, raw: string}>}
 */
export function extractXmlBlocksByTag(text, tagName) {
    /** @type {Array<{tag: string, content: string, raw: string}>} */
    const blocks = [];
    let consumedUpTo = 0;
    const closeTag = `</${tagName}>`;
    let match;
    const openRegex = openTagRegexFor(tagName);

    while ((match = openRegex.exec(text)) !== null) {
        const blockStart = match.index;
        if (blockStart < consumedUpTo) {
            continue;
        }

        const openTagText = match[0];
        const searchStart = blockStart + openTagText.length;
        let depth = 1;
        let pos = searchStart;
        let closeIndex = -1;

        while (depth > 0 && pos < text.length) {
            const nextClose = text.indexOf(closeTag, pos);
            if (nextClose === -1) {
                break;
            }

            const openScan = openTagRegexFor(tagName);
            openScan.lastIndex = pos;
            const nextOpenResult = openScan.exec(text);
            const nextOpen = nextOpenResult?.index ?? -1;

            if (nextOpen !== -1 && nextOpen < nextClose) {
                depth++;
                pos = nextOpen + (nextOpenResult?.[0]?.length ?? openTagText.length);
            } else {
                depth--;
                if (depth === 0) {
                    closeIndex = nextClose;
                }
                pos = nextClose + closeTag.length;
            }
        }

        if (closeIndex !== -1) {
            const blockEnd = closeIndex + closeTag.length;
            blocks.push({
                tag: tagName,
                content: text.slice(searchStart, closeIndex),
                raw: text.slice(blockStart, blockEnd),
            });
            consumedUpTo = blockEnd;
        }
    }

    return blocks;
}

/**
 * Extracts any top-level XML blocks regardless of tag name.
 * Tries <character> first, then falls back to any tag.
 * @param {string} text
 * @returns {Array<{tag: string, content: string, raw: string}>}
 */
export function extractTopLevelXmlBlocks(text) {
    const characterBlocks = extractXmlBlocksByTag(text, 'character');
    if (characterBlocks.length > 0) {
        return characterBlocks;
    }

    const anyOpenRegex = /<([a-zA-Z_][\w.-]*)(?:\s+[^>]*[^/])?>/g;
    /** @type {Array<{tag: string, content: string, raw: string}>} */
    const blocks = [];
    let consumedUpTo = 0;
    let match;

    while ((match = anyOpenRegex.exec(text)) !== null) {
        const blockStart = match.index;
        if (blockStart < consumedUpTo) {
            continue;
        }

        const tagName = match[1];
        const subBlocks = extractXmlBlocksByTag(text.slice(blockStart), tagName);
        const nextSearchIndex = blockStart + match[0].length;

        if (subBlocks.length === 0) {
            consumedUpTo = Math.max(consumedUpTo, nextSearchIndex);
        } else {
            for (const block of subBlocks) {
                const realEnd = blockStart + block.raw.length;
                if (blockStart < consumedUpTo) {
                    continue;
                }
                blocks.push({
                    tag: block.tag,
                    content: block.content,
                    raw: text.slice(blockStart, realEnd),
                });
                consumedUpTo = realEnd;
            }
        }

        anyOpenRegex.lastIndex = Math.max(consumedUpTo, nextSearchIndex);
    }

    return blocks;
}

/**
 * Validates and cleans generated group card XML output.
 * Falls back to raw text wrapped in <character> block when no XML found.
 * @param {string} output Raw LLM output
 * @param {number} selectedCharacterCount Expected character count
 * @returns {string} Validated description
 */
export function validateGeneratedGroupCardDescription(output, selectedCharacterCount) {
    const cleaned = stripNoise(output);

    if (!cleaned) {
        throw new Error('Generation returned empty output.');
    }

    const blocks = extractTopLevelXmlBlocks(cleaned);

    if (blocks.length === 0) {
        console.warn('Group card generation: No XML blocks found in LLM output. Using raw text as fallback.');
        return `<character>\n  <description>${escapeXml(cleaned)}</description>\n</character>`;
    }

    if (selectedCharacterCount > 1) {
        const characterTagCount = blocks.filter(
            (block) => block.tag === 'character',
        ).length;

        if (characterTagCount < selectedCharacterCount) {
            throw new Error(
                `Generation returned ${characterTagCount} character block(s), expected at least ${selectedCharacterCount}.`,
            );
        }
    }

    return blocks.map((block) => block.raw).join('\n\n');
}
