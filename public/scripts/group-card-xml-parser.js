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
 * @returns {Array<{tag: string, content: string, raw: string, openTag: string}>}
 */
export function extractXmlBlocksByTag(text, tagName) {
    /** @type {Array<{tag: string, content: string, raw: string, openTag: string}>} */
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
                openTag: openTagText,
            });
            consumedUpTo = blockEnd;
        }
    }

    return blocks;
}

/**
 * Extracts attributes from an XML opening tag.
 * @param {string} openTagString XML opening tag.
 * @returns {Record<string, string>} Attribute name/value map.
 */
export function extractOpenTagAttributes(openTagString) {
    /** @type {Record<string, string>} */
    const attrs = {};
    const regex = /(\w[\w-]*)=(?:"([^"]*)"|'([^']*)')/g;
    let m;

    while ((m = regex.exec(String(openTagString ?? ''))) !== null) {
        attrs[m[1]] = m[2] ?? m[3] ?? '';
    }

    return attrs;
}

/**
 * Extracts the opening tag for a named XML block.
 * @param {string} xmlString XML text.
 * @param {string} tagName Tag name.
 * @returns {string} Opening tag text, or a plain opening tag fallback.
 */
function extractOpenTag(xmlString, tagName) {
    const regex = new RegExp(`<${tagName}(?:\\s+[^>]*[^/])?>`);
    const match = regex.exec(String(xmlString ?? ''));
    return match ? match[0] : `<${tagName}>`;
}

/**
 * Extracts any top-level XML blocks regardless of tag name.
 * Tries <character> first, then falls back to any tag.
 * @param {string} text
 * @returns {Array<{tag: string, content: string, raw: string, openTag: string}>}
 */
export function extractTopLevelXmlBlocks(text) {
    const characterBlocks = extractXmlBlocksByTag(text, 'character');
    if (characterBlocks.length > 0) {
        return characterBlocks;
    }

    const anyOpenRegex = /<([a-zA-Z_][\w.-]*)(?:\s+[^>]*[^/])?>/g;
    /** @type {Array<{tag: string, content: string, raw: string, openTag: string}>} */
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
                    openTag: block.openTag,
                });
                consumedUpTo = realEnd;
            }
        }

        anyOpenRegex.lastIndex = Math.max(consumedUpTo, nextSearchIndex);
    }

    return blocks;
}

/**
 * Counts root-level XML corpus blocks.
 * Nested blocks do not count.
 * @param {string} xmlString XML text.
 * @returns {number} Root-level XML block count.
 */
export function countXmlCorpus(xmlString) {
    const cleaned = String(xmlString ?? '').trim();

    if (!cleaned) {
        return 0;
    }

    return extractTopLevelXmlBlocks(cleaned).length;
}

/**
 * Removes non-XML trailing text after the last closing tag.
 * @param {string} text XML-ish text.
 * @returns {string} Text ending at the last closing tag when present.
 */
function trimAfterLastClosingTag(text) {
    const closeTagRegex = /<\/([a-zA-Z_][\w.-]*)\s*>/g;
    let lastCloseEnd = -1;

    while (closeTagRegex.exec(text) !== null) {
        lastCloseEnd = closeTagRegex.lastIndex;
    }

    if (lastCloseEnd === -1) {
        return text;
    }

    return text.slice(0, lastCloseEnd).trim();
}

/**
 * Appends closing tags for unclosed XML tags.
 * @param {string} text XML-ish text.
 * @returns {string} Text with best-effort appended closing tags.
 */
function closeUnclosedTags(text) {
    const tagRegex = /<\/?([a-zA-Z_][\w.-]*)(?:\s+[^>]*)?>/g;
    /** @type {string[]} */
    const stack = [];
    let fixed = '';
    let lastIndex = 0;
    let match;

    while ((match = tagRegex.exec(text)) !== null) {
        const tagText = match[0];
        const tagName = match[1];
        fixed += text.slice(lastIndex, match.index);

        if (tagText.startsWith('</')) {
            const matchingIndex = stack.lastIndexOf(tagName);

            if (matchingIndex === -1) {
                fixed += tagText;
            } else {
                for (let index = stack.length - 1; index > matchingIndex; index--) {
                    fixed += `</${stack[index]}>`;
                }

                stack.length = matchingIndex;
                fixed += tagText;
            }
        } else {
            fixed += tagText;

            if (!tagText.endsWith('/>')) {
                stack.push(tagName);
            }
        }

        lastIndex = tagRegex.lastIndex;
    }

    fixed += text.slice(lastIndex);

    if (!stack.length) {
        return fixed;
    }

    return `${fixed}${stack
        .reverse()
        .map((tagName) => `</${tagName}>`)
        .join('')}`;
}

/**
 * Attempts conservative repair of malformed XML-like LLM output.
 * @param {string} xmlString XML-ish text.
 * @returns {{ fixed: string, succeeded: boolean }} Fixed text and parse status.
 */
export function autoFixXml(xmlString) {
    const cleaned = stripNoise(xmlString);

    if (!cleaned) {
        return { fixed: '', succeeded: false };
    }

    let fixed = closeUnclosedTags(cleaned).trim();
    fixed = trimAfterLastClosingTag(fixed);

    if (extractTopLevelXmlBlocks(fixed).length > 0) {
        return { fixed, succeeded: true };
    }

    return { fixed, succeeded: false };
}

/**
 * Extracts the first message content from the first <first_mes> tag.
 * @param {string} xmlString XML text.
 * @returns {string} First message content, or empty string.
 */
export function extractFirstMessage(xmlString) {
    const blocks = extractXmlBlocksByTag(String(xmlString ?? ''), 'first_mes');
    return blocks[0]?.content ?? '';
}

/**
 * Extracts all <greeting> blocks from XML text.
 * @param {string} xmlString XML text.
 * @returns {Array<{tag: string, content: string, raw: string, openTag: string}>}
 */
export function extractGreetingBlocks(xmlString) {
    return extractXmlBlocksByTag(String(xmlString ?? ''), 'greeting');
}

/**
 * Parses greeting messages from generated XML output.
 * Extracts <greeting> blocks and returns them as first_mes + alternate_greetings.
 * Falls back to <first_mes> when no <greeting> blocks found.
 * @param {string} generatedXml Generated XML text.
 * @returns {{ first_mes: string, alternate_greetings: string[] }}
 */
export function parseGreetingsFromGeneratedOutput(generatedXml) {
    const text = String(generatedXml ?? '');
    const greetingBlocks = extractGreetingBlocks(text);

    if (greetingBlocks.length > 0) {
        return {
            first_mes: greetingBlocks[0].content,
            alternate_greetings: greetingBlocks.slice(1).map((block) => block.content),
        };
    }

    const firstMes = extractFirstMessage(text);
    return {
        first_mes: firstMes,
        alternate_greetings: [],
    };
}

/**
 * Removes all <greeting> blocks from XML text.
 * @param {string} xmlString XML text.
 * @returns {string} XML text without greeting blocks.
 */
export function stripGreetingBlocks(xmlString) {
    const text = String(xmlString ?? '');
    return text
        .replace(
            /(?:[ \t]*\r?\n)?[ \t]*<greeting(?:\s+[^>]*)?>[\s\S]*?<\/greeting>[ \t]*(?:\r?\n)?/g,
            (match) => (match.includes('\n') ? '\n' : ''),
        )
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Validates and cleans generated group card XML output.
 * Falls back to raw text wrapped in <character> block when no XML found.
 * @param {string} output Raw LLM output
 * @param {number} selectedCharacterCount Expected character count
 * @returns {string} Validated description
 */
export function validateGeneratedGroupCardDescription(
    output,
    selectedCharacterCount,
) {
    const cleaned = stripNoise(output);

    if (!cleaned) {
        throw new Error('Generation returned empty output.');
    }

    const blocks = extractTopLevelXmlBlocks(cleaned);

    if (blocks.length === 0) {
        console.warn(
            'Group card generation: No XML blocks found in LLM output. Using raw text as fallback.',
        );
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

/**
 * Gets inner character content from a character block when possible.
 * @param {string} xmlString XML text.
 * @returns {string} Character content, or original text when no character block is found.
 */
function getCharacterBlockContent(xmlString) {
    const text = String(xmlString ?? '');
    const characterBlocks = extractXmlBlocksByTag(text, 'character');
    return characterBlocks[0]?.content ?? text;
}

/**
 * Extracts summary content from the first summary-like tag inside a character block.
 * @param {string} xmlString Character XML block.
 * @param {string[]} [fallbackTags=['summary']] Tags to try in order.
 * @returns {string} Summary content, or empty string.
 */
export function extractSummaryFromCharacterBlock(
    xmlString,
    fallbackTags = ['summary'],
) {
    const content = getCharacterBlockContent(xmlString);
    for (const tag of fallbackTags) {
        const blocks = extractXmlBlocksByTag(content, tag);
        if (blocks.length > 0 && blocks[0]?.content) {
            return blocks[0].content;
        }
    }
    return '';
}

/**
 * Extracts the first summary-like block from a character block, trying fallback tags in order.
 * Returns the full block object (with openTag for attribute preservation) or null.
 * @param {string} xmlString Character XML block.
 * @param {string[]} [fallbackTags=['summary']] Tags to try in order.
 * @returns {{tag: string, content: string, raw: string, openTag: string}|null}
 */
export function extractSummaryBlockFromCharacterBlock(
    xmlString,
    fallbackTags = ['summary'],
) {
    const content = getCharacterBlockContent(xmlString);
    for (const tag of fallbackTags) {
        const blocks = extractXmlBlocksByTag(content, tag);
        if (blocks.length > 0 && blocks[0]?.content) {
            return blocks[0];
        }
    }
    return null;
}

/**
 * Removes the first <summary> block from a character block.
 * @param {string} xmlString Character XML block.
 * @returns {string} Character XML block without summary, or original input when absent.
 */
export function stripSummaryFromCharacterBlock(xmlString) {
    const text = String(xmlString ?? '');
    const summaryRegex =
		/(?:[ \t]*\r?\n)?[ \t]*<summary(?:\s+[^>]*)?>[\s\S]*?<\/summary>[ \t]*(?:\r?\n)?/;

    if (!summaryRegex.test(text)) {
        return text;
    }

    return text
        .replace(summaryRegex, (match) => (match.includes('\n') ? '\n' : ''))
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Builds a compact character block containing only name and summary.
 * @param {string} xmlString Character XML block.
 * @param {string[]} [fallbackTags=['summary']] Tags to try in order.
 * @returns {string} Summary-only character XML block.
 */
export function buildSummaryCharacterBlock(
    xmlString,
    fallbackTags = ['summary'],
) {
    const charOpenTag = extractOpenTag(xmlString, 'character');
    const characterContent = getCharacterBlockContent(xmlString);
    const name =
		extractXmlBlocksByTag(characterContent, 'name')[0]?.content ?? '';
    const summaryBlock = extractSummaryBlockFromCharacterBlock(
        xmlString,
        fallbackTags,
    );
    const summaryOpenTag = summaryBlock?.openTag ?? '<summary>';
    const summaryContent = summaryBlock?.content ?? '';
    const summaryTagName = summaryBlock?.tag ?? 'summary';
    const lines = [charOpenTag];

    if (name) {
        lines.push(`  <name>${name}</name>`);
    }

    lines.push(`  ${summaryOpenTag}${summaryContent}</${summaryTagName}>`);
    lines.push('</character>');

    return lines.join('\n');
}

/**
 * Collapses whitespace in XML text nodes without changing tag contents.
 * @param {string} text XML text.
 * @returns {string} XML text with compact text nodes.
 */
function collapseXmlTextNodeWhitespace(text) {
    return text
        .split(/(<[^>]+>)/g)
        .map((part) => {
            if (!part || part.startsWith('<')) {
                return part;
            }

            return part.replace(/[\t\r\n ]+/g, ' ').trim();
        })
        .join('');
}

/**
 * Compacts XML-ish text by removing comments, blank lines, and redundant whitespace.
 * @param {string} xmlString XML text.
 * @param {{ compact?: boolean, singleLine?: boolean }} [options] Minify options.
 * @returns {string} Minified XML text.
 */
export function minifyXml(xmlString, options = {}) {
    const input = String(xmlString ?? '');

    if (!input.trim()) {
        return '';
    }

    const { compact = false, singleLine = false } = options ?? {};
    let text = input.replace(/<!--[\s\S]*?-->/g, '');
    text = collapseXmlTextNodeWhitespace(text);

    if (compact || singleLine) {
        text = text.replace(/>\s*</g, '>\n<');
    }

    let lines = text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    if (compact || singleLine) {
        lines = lines.map((line) => line.replace(/^\s+/, ''));
    }

    if (singleLine) {
        return lines
            .join(' ')
            .replace(/[\t ]+/g, ' ')
            .trim();
    }

    return lines.join('\n');
}
