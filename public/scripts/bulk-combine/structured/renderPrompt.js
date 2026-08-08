import { findSummaryNode, normalizeTemplate } from './templateModel.js';
import { serializeTemplate } from './templateText.js';

function nodeValue(node) {
    const value = {};
    for (const attribute of node.attributes) {
        value[`@${attribute.name}`] = attribute.values;
    }
    if (node.hint) {
        value['#text'] = node.hint;
    }

    const grouped = new Map();
    for (const child of node.children) {
        if (!grouped.has(child.name)) {
            grouped.set(child.name, []);
        }
        grouped.get(child.name).push(child);
    }
    for (const [name, children] of grouped) {
        const exemplar = nodeValue(children[0]);
        value[name] = children.length > 1 ? [exemplar] : exemplar;
    }
    return value;
}

function skeleton(tree) {
    const root = normalizeTemplate(tree)[0];
    return { [root.name]: nodeValue(root) };
}

function instruction(format, rootName) {
    if (format === 'xml') {
        return `Respond with ONLY a <${rootName}> document following this template; keep attribute values from the given vocabularies.`;
    }
    return `Respond with ONLY a ${format.toUpperCase()} document following this template; keep attribute values from the given vocabularies.`;
}

function compositionHint(format) {
    if (format === 'xml') {
        return 'Multiple characters are composed as <characters>…</characters> of summary elements.';
    }
    return 'Multiple characters are composed as {"characters":[…]} of summary elements.';
}

function lengthHints(nodes, hints = []) {
    for (const node of nodes) {
        if (node.maxLength !== null) {
            hints.push(`Text for <${node.name}> must not exceed ${node.maxLength} characters.`);
        }
        lengthHints(node.children, hints);
    }
    return hints;
}

/**
 * Renders the selected structure as prompt instructions.
 *
 * @param {{format?: string, template?: object[]}} structure Structure settings.
 * @param {'full'|'summary'} kind Contract scope.
 * @param {{toonEncode?: (value: unknown) => string}} [codecs] Optional TOON codec.
 * @returns {string} Prompt fragment.
 */
export function renderStructureInstructions(structure, kind, codecs = {}) {
    const format = structure?.format ?? 'none';
    if (format === 'none') {
        return '';
    }

    const template = normalizeTemplate(structure?.template);
    let renderTree = template;
    if (kind === 'summary') {
        const summary = findSummaryNode(template);
        if (!summary) {
            return '';
        }
        renderTree = normalizeTemplate([summary]);
    }

    const rootName = renderTree[0].name;
    const model = skeleton(renderTree);
    let rendered;
    let fallbackNote = '';

    if (format === 'xml') {
        rendered = serializeTemplate(renderTree);
    } else if (format === 'toon' && typeof codecs.toonEncode === 'function') {
        rendered = String(codecs.toonEncode(model));
    } else {
        rendered = JSON.stringify(model, null, 2);
        if (format === 'toon') {
            fallbackNote = '\nThe JSON-shaped skeleton above must be encoded as TOON.';
        }
    }

    const parts = [instruction(format, rootName), rendered + fallbackNote, ...lengthHints(renderTree)];
    if (kind === 'full' && findSummaryNode(template)) {
        parts.push(compositionHint(format));
    }
    return parts.join('\n\n');
}
