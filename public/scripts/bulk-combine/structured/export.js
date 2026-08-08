import { escapeXml, minifyXml } from '../../group-card-xml-parser.js';

function xmlNode(node, depth) {
    const indent = '  '.repeat(depth);
    const attributes = Object.entries(node.attributes ?? {})
        .map(([name, value]) => ` ${name}="${escapeXml(value)}"`)
        .join('');
    const children = Array.isArray(node.children) ? node.children : [];
    const text = String(node.text ?? '');

    if (children.length === 0) {
        return [`${indent}<${node.name}${attributes}>${escapeXml(text)}</${node.name}>`];
    }

    const lines = [`${indent}<${node.name}${attributes}>`];
    if (text) {
        lines.push(`${'  '.repeat(depth + 1)}${escapeXml(text)}`);
    }
    for (const child of children) {
        lines.push(...xmlNode(child, depth + 1));
    }
    lines.push(`${indent}</${node.name}>`);
    return lines;
}

function jsonNodeValue(node) {
    const value = {};
    for (const [name, attributeValue] of Object.entries(node.attributes ?? {})) {
        value[`@${name}`] = String(attributeValue ?? '');
    }

    const children = Array.isArray(node.children) ? node.children : [];
    const text = String(node.text ?? '');
    if (text || children.length === 0) {
        value['#text'] = text;
    }

    const groups = new Map();
    for (const child of children) {
        if (!groups.has(child.name)) {
            groups.set(child.name, []);
        }
        groups.get(child.name).push(child);
    }
    for (const [name, group] of groups) {
        const values = group.map(jsonNodeValue);
        value[name] = values.length === 1 ? values[0] : values;
    }
    return value;
}

function jsonDocument(doc) {
    const model = {};
    const groups = new Map();
    for (const node of Array.isArray(doc) ? doc : []) {
        if (!groups.has(node.name)) {
            groups.set(node.name, []);
        }
        groups.get(node.name).push(node);
    }
    for (const [name, group] of groups) {
        const values = group.map(jsonNodeValue);
        model[name] = values.length === 1 ? values[0] : values;
    }
    return model;
}

/**
 * Serializes a generic document in the selected output format.
 *
 * @param {object[]} doc Generic document.
 * @param {'xml'|'json'|'toon'} format Output format.
 * @param {{toonEncode?: (value: unknown) => string}} [codecs] Optional TOON codec.
 * @returns {string} Serialized document.
 */
export function serializeDoc(doc, format, codecs = {}) {
    const model = jsonDocument(doc);
    if (format === 'xml') {
        return (Array.isArray(doc) ? doc : []).flatMap((node) => xmlNode(node, 0)).join('\n');
    }
    if (format === 'toon' && typeof codecs.toonEncode === 'function') {
        return String(codecs.toonEncode(model));
    }
    return JSON.stringify(model, null, 2);
}

function findNode(nodes, name) {
    for (const node of Array.isArray(nodes) ? nodes : []) {
        if (node.name === name) {
            return node;
        }
        const descendant = findNode(node.children, name);
        if (descendant) {
            return descendant;
        }
    }
    return null;
}

/**
 * Composes one summary per character, falling back to that character's full
 * document when no summary exists.
 *
 * @param {object[][]} docs Character documents.
 * @param {'xml'|'json'|'toon'} format Output format.
 * @param {{toonEncode?: (value: unknown) => string}} [codecs] Optional TOON codec.
 * @returns {string} Composed summaries.
 */
export function composeSummaries(docs, format, codecs = {}) {
    const selected = (Array.isArray(docs) ? docs : []).map((doc) => {
        const summary = findNode(doc, 'summary');
        return summary ? { summary, doc: [summary] } : { summary: null, doc };
    });

    if (format === 'xml') {
        const lines = ['<characters>'];
        for (const item of selected) {
            for (const line of item.doc.flatMap((node) => xmlNode(node, 1))) {
                lines.push(line);
            }
        }
        lines.push('</characters>');
        return lines.join('\n');
    }

    const model = {
        characters: selected.map((item) => item.summary
            ? jsonNodeValue(item.summary)
            : jsonDocument(item.doc)),
    };
    if (format === 'toon' && typeof codecs.toonEncode === 'function') {
        return String(codecs.toonEncode(model));
    }
    return JSON.stringify(model, null, 2);
}

/**
 * Builds lorebook entries from full character documents.
 *
 * @param {object[][]} docs Character documents.
 * @param {'xml'|'json'|'toon'} format Output format.
 * @param {{sourceNames?: string[], codecs?: {toonEncode?: (value: unknown) => string}}} [options] Source-name fallbacks and optional TOON codec.
 * @returns {Array<{key: string[], comment: string, content: string}>} Entries.
 */
export function lorebookEntriesFromDocs(docs, format, options = {}) {
    return (Array.isArray(docs) ? docs : []).map((doc, index) => {
        const summary = findNode(doc, 'summary');
        const identity = summary?.attributes ?? doc?.[0]?.attributes ?? {};
        const name = String(identity.name ?? '').trim();
        const aliases = String(identity.aliases ?? '')
            .split(',')
            .map((alias) => alias.trim())
            .filter(Boolean);
        return {
            key: [name, ...aliases],
            comment: name || String(options.sourceNames?.[index] ?? ''),
            content: serializeDoc(doc, format, options.codecs ?? {}),
        };
    });
}

/**
 * Applies the selected format's safe minifier.
 *
 * @param {unknown} text Serialized text.
 * @param {'xml'|'json'|'toon'} format Output format.
 * @returns {string} Minified or original text.
 */
export function minifyForFormat(text, format) {
    const input = String(text ?? '');
    if (format === 'xml') {
        return minifyXml(input, { singleLine: true });
    }
    if (format === 'json') {
        try {
            return JSON.stringify(JSON.parse(input));
        } catch {
            return input;
        }
    }
    return input;
}
