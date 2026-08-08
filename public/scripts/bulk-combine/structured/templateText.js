import {
    escapeXml,
    extractOpenTagAttributes,
} from '../../group-card-xml-parser.js';
import { normalizeTemplate } from './templateModel.js';

function serializeNode(node, depth) {
    const indent = '  '.repeat(depth);
    const lines = [];

    if (node.hint) {
        lines.push(`${indent}<!-- ${node.hint} -->`);
    }

    const attributes = node.attributes.map((attribute) => ` ${attribute.name}="${escapeXml(attribute.values)}"`);
    if (node.maxLength !== null) {
        attributes.push(` max="${node.maxLength}"`);
    }

    const opening = `${indent}<${node.name}${attributes.join('')}>`;
    if (node.children.length === 0) {
        // Hints live in comments, so leaf bodies stay empty in the canonical form.
        lines.push(`${opening}</${node.name}>`);
        return lines;
    }

    lines.push(opening);
    for (const child of node.children) {
        lines.push(...serializeNode(child, depth + 1));
    }
    lines.push(`${indent}</${node.name}>`);
    return lines;
}

/**
 * Serializes a template to its canonical XML editor form.
 *
 * @param {object[]} tree Template tree.
 * @returns {string} Canonical XML.
 */
export function serializeTemplate(tree) {
    return serializeNode(normalizeTemplate(tree)[0], 0).join('\n');
}

function lineAt(text, index) {
    return text.slice(0, index).split('\n').length;
}

function decodeXml(value) {
    return String(value ?? '')
        .replaceAll('&lt;', '<')
        .replaceAll('&gt;', '>')
        .replaceAll('&quot;', '"')
        .replaceAll('&#039;', '\'')
        .replaceAll('&apos;', '\'')
        .replaceAll('&amp;', '&');
}

function pushError(errors, text, index, message) {
    errors.push({ line: lineAt(text, index), message });
}

function parseOpeningTag(token, errors, text, index) {
    const match = /^<([a-zA-Z_][\w.-]*)(?:\s+[\s\S]*?)?\s*\/?>$/.exec(token);
    if (!match) {
        pushError(errors, text, index, 'Malformed XML opening tag.');
        return null;
    }

    const attributes = extractOpenTagAttributes(token);
    const maxValue = attributes.max;
    delete attributes.max;
    let maxLength = null;

    if (maxValue !== undefined) {
        if (!/^\d+$/.test(maxValue)) {
            pushError(errors, text, index, 'The max attribute must be numeric.');
        } else {
            maxLength = Number(maxValue);
        }
    }

    return {
        name: match[1],
        hint: '',
        attributes: Object.entries(attributes).map(([name, values]) => ({ name, values: decodeXml(values) })),
        maxLength,
        children: [],
        text: '',
        pendingHints: [],
        index,
    };
}

function finishNode(frame) {
    const textHint = decodeXml(frame.text.trim());
    if (!frame.hint && textHint) {
        frame.hint = textHint;
    }
    return {
        name: frame.name,
        hint: frame.hint,
        attributes: frame.attributes,
        maxLength: frame.maxLength,
        children: frame.children,
    };
}

function checkSiblingNames(node, errors, text) {
    const names = new Set();
    for (const child of node.children) {
        if (!child.name.trim()) {
            pushError(errors, text, 0, 'Element names must not be empty.');
        } else if (names.has(child.name)) {
            pushError(errors, text, 0, `Duplicate sibling element name: ${child.name}.`);
        }
        names.add(child.name);
        checkSiblingNames(child, errors, text);
    }
}

/**
 * Parses the canonical XML editor form without browser DOM APIs.
 * Comments immediately above an element become that element's hint. A first
 * comment inside the root is treated as root guidance for the supplied
 * character-template notation.
 *
 * @param {unknown} input XML template text.
 * @returns {{tree: object[]|null, errors: Array<{line: number, message: string}>}} Parse result.
 */
export function parseTemplate(input) {
    const text = String(input ?? '');
    const errors = [];
    const roots = [];
    const stack = [];
    let topHints = [];
    let cursor = 0;
    const tokenRegex = /<!--[\s\S]*?-->|<[^>]*>/g;
    let match;

    while ((match = tokenRegex.exec(text)) !== null) {
        const gap = text.slice(cursor, match.index);
        if (stack.length > 0) {
            stack[stack.length - 1].text += gap;
        } else if (gap.trim()) {
            pushError(errors, text, cursor, 'Text is not allowed outside the root element.');
        }

        const token = match[0];
        if (token.startsWith('<!--')) {
            const hint = token.slice(4, -3).trim();
            if (stack.length === 0) {
                topHints.push(hint);
            } else {
                const parent = stack[stack.length - 1];
                if (stack.length === 1 && !parent.hint && parent.children.length === 0 && !parent.text.trim()) {
                    parent.hint = hint;
                } else {
                    parent.pendingHints.push(hint);
                }
            }
        } else if (/^<\//.test(token)) {
            const closing = /^<\/([a-zA-Z_][\w.-]*)\s*>$/.exec(token);
            if (!closing || stack.length === 0) {
                pushError(errors, text, match.index, 'Malformed or unexpected XML closing tag.');
            } else {
                const frame = stack.pop();
                if (frame.name !== closing[1]) {
                    pushError(errors, text, match.index, `Expected </${frame.name}> but found </${closing[1]}>.`);
                }
                const node = finishNode(frame);
                if (stack.length > 0) {
                    stack[stack.length - 1].children.push(node);
                } else {
                    roots.push(node);
                }
            }
        } else {
            const frame = parseOpeningTag(token, errors, text, match.index);
            if (frame) {
                const parent = stack[stack.length - 1];
                const pending = parent ? parent.pendingHints.splice(0) : topHints.splice(0);
                frame.hint = pending.filter(Boolean).join('\n');

                if (token.endsWith('/>')) {
                    const node = finishNode(frame);
                    if (parent) {
                        parent.children.push(node);
                    } else {
                        roots.push(node);
                    }
                } else {
                    stack.push(frame);
                }
            }
        }
        cursor = tokenRegex.lastIndex;
    }

    const trailing = text.slice(cursor);
    if (stack.length > 0) {
        pushError(errors, text, cursor, `Unclosed element <${stack[stack.length - 1].name}>.`);
    } else if (trailing.trim()) {
        pushError(errors, text, cursor, 'Malformed XML or trailing text.');
    }

    if (roots.length === 0) {
        errors.push({ line: 1, message: 'Template must contain one root element.' });
        return { tree: null, errors };
    }
    if (roots.length > 1) {
        errors.push({ line: 1, message: 'Template must contain exactly one root element.' });
    }

    for (const root of roots) {
        checkSiblingNames(root, errors, text);
    }

    return { tree: normalizeTemplate(roots), errors };
}
