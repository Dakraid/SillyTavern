import {
    autoFixXml,
    extractOpenTagAttributes,
    extractTopLevelXmlBlocks,
    stripNoise,
} from '../../group-card-xml-parser.js';

function cleanFences(input) {
    const text = String(input ?? '');
    const fenced = /```[a-zA-Z]*\s*\n?([\s\S]*?)```/.exec(text);
    return stripNoise(fenced?.[1] ?? text);
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

function cleanJsonText(input) {
    const text = cleanFences(input);
    const objectStart = text.indexOf('{');
    const arrayStart = text.indexOf('[');
    const starts = [objectStart, arrayStart].filter((index) => index >= 0);
    if (starts.length === 0) {
        return '';
    }

    const start = Math.min(...starts);
    const opening = text[start];
    const closing = opening === '{' ? '}' : ']';
    let depth = 0;
    let quoted = false;
    let escaped = false;

    for (let index = start; index < text.length; index++) {
        const character = text[index];
        if (quoted) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                quoted = false;
            }
            continue;
        }
        if (character === '"') {
            quoted = true;
        } else if (character === opening) {
            depth++;
        } else if (character === closing && --depth === 0) {
            return text.slice(start, index + 1);
        }
    }
    return text.slice(start);
}

function jsonNode(name, value) {
    const node = {
        name,
        attributes: {},
        text: '',
        children: [],
        unknown: false,
    };

    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        node.text = value === null ? '' : String(value);
        return node;
    }

    for (const [key, childValue] of Object.entries(value)) {
        if (key.startsWith('@')) {
            node.attributes[key.slice(1)] = String(childValue ?? '');
        } else if (key === '#text') {
            node.text = String(childValue ?? '');
        } else {
            const values = Array.isArray(childValue) ? childValue : [childValue];
            for (const item of values) {
                node.children.push(jsonNode(key, item));
            }
        }
    }
    return node;
}

function jsonDocument(value) {
    const values = Array.isArray(value) ? value : [value];
    const doc = [];
    for (const item of values) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('JSON document must contain named element objects');
        }
        for (const [name, nodeValue] of Object.entries(item)) {
            const repeated = Array.isArray(nodeValue) ? nodeValue : [nodeValue];
            for (const entry of repeated) {
                doc.push(jsonNode(name, entry));
            }
        }
    }
    if (doc.length === 0) {
        throw new Error('JSON document is empty');
    }
    return doc;
}

function parseXmlBlock(raw) {
    const tokens = raw.match(/<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
    const roots = [];
    const stack = [];

    for (const token of tokens) {
        if (token.startsWith('<!--')) {
            continue;
        }
        if (!token.startsWith('<')) {
            if (stack.length === 0) {
                if (token.trim()) {
                    throw new Error('Text outside XML root');
                }
            } else {
                stack[stack.length - 1].text += decodeXml(token);
            }
            continue;
        }
        if (token.startsWith('</')) {
            const match = /^<\/([a-zA-Z_][\w.-]*)\s*>$/.exec(token);
            const node = stack.pop();
            if (!match || !node || node.name !== match[1]) {
                throw new Error('Mismatched XML tags');
            }
            node.text = node.text.trim();
            if (stack.length > 0) {
                stack[stack.length - 1].children.push(node);
            } else {
                roots.push(node);
            }
            continue;
        }

        const match = /^<([a-zA-Z_][\w.-]*)(?:\s+[\s\S]*?)?\s*\/?>$/.exec(token);
        if (!match) {
            throw new Error('Malformed XML tag');
        }
        const node = {
            name: match[1],
            attributes: Object.fromEntries(Object.entries(extractOpenTagAttributes(token))
                .map(([name, value]) => [name, decodeXml(value)])),
            text: '',
            children: [],
            unknown: false,
        };
        if (token.endsWith('/>')) {
            if (stack.length > 0) {
                stack[stack.length - 1].children.push(node);
            } else {
                roots.push(node);
            }
        } else {
            stack.push(node);
        }
    }

    if (stack.length > 0 || roots.length !== 1) {
        throw new Error('Incomplete XML document');
    }
    return roots[0];
}

function parseXml(input) {
    const noisy = cleanFences(input);
    const start = noisy.indexOf('<');
    if (start < 0) {
        throw new Error('No XML document found');
    }

    const { fixed, succeeded } = autoFixXml(noisy.slice(start));
    const blocks = extractTopLevelXmlBlocks(fixed);
    if (blocks.length > 0) {
        return blocks.map((block) => parseXmlBlock(block.raw));
    }

    const selfClosingRoot = /^<([a-zA-Z_][\w.-]*)(?:\s+[\s\S]*?)?\s*\/>/.exec(fixed.trim());
    if (selfClosingRoot) {
        return [parseXmlBlock(selfClosingRoot[0])];
    }
    if (!succeeded) {
        throw new Error('Malformed XML');
    }
    throw new Error('No XML root found');
}

/**
 * Parses model output into the generic structured document shape.
 *
 * @param {unknown} text Model output.
 * @param {'xml'|'json'|'toon'} format Selected format.
 * @param {{toonDecode?: (value: string) => unknown}} [codecs] Optional TOON codec.
 * @returns {{ok: boolean, doc: object[]|null, error: string|null}} Parse result.
 */
export function parseStructured(text, format, codecs = {}) {
    try {
        let doc;
        if (format === 'xml') {
            doc = parseXml(text);
        } else if (format === 'json') {
            const cleaned = cleanJsonText(text);
            if (!cleaned) {
                throw new Error('No JSON document found');
            }
            doc = jsonDocument(JSON.parse(cleaned));
        } else if (format === 'toon') {
            if (typeof codecs.toonDecode !== 'function') {
                return { ok: false, doc: null, error: 'TOON decoder unavailable' };
            }
            const decoded = codecs.toonDecode(cleanFences(text));
            doc = jsonDocument(decoded);
        } else {
            throw new Error('Unsupported structured format');
        }
        return { ok: true, doc, error: null };
    } catch (error) {
        return {
            ok: false,
            doc: null,
            error: error instanceof Error ? error.message : 'Unable to parse structured output',
        };
    }
}
