import { normalizeTemplate } from './templateModel.js';

function cloneDoc(nodes) {
    return Array.isArray(nodes) ? nodes.map((node) => ({
        name: String(node?.name ?? ''),
        attributes: node?.attributes && typeof node.attributes === 'object'
            ? Object.fromEntries(Object.entries(node.attributes).map(([key, value]) => [key, String(value ?? '')]))
            : {},
        text: String(node?.text ?? ''),
        children: cloneDoc(node?.children),
        unknown: Boolean(node?.unknown),
    })) : [];
}

function markUnknown(nodes, templates) {
    for (const node of nodes) {
        const match = templates.find((template) => template.name === node.name);
        node.unknown = !match;
        markUnknown(node.children, match?.children ?? []);
    }
}

/**
 * Marks elements absent from the template and returns the input document.
 *
 * @param {object[]} doc Generic document.
 * @param {object[]} template Template tree.
 * @returns {object[]} Annotated document.
 */
export function annotateUnknown(doc, template) {
    const result = Array.isArray(doc) ? doc : [];
    try {
        markUnknown(result, normalizeTemplate(template));
    } catch {
        // A malformed document has no safely matchable template elements.
        try {
            markUnknown(result, []);
        } catch {
            return result;
        }
    }
    return result;
}

function validateLevel(nodes, templates, parentPath, issues) {
    for (const template of templates) {
        const matches = nodes.filter((node) => node.name === template.name);
        const path = `${parentPath}/${template.name}`;
        if (matches.length === 0) {
            issues.push({
                path,
                kind: 'missing',
                message: `Missing <${template.name}> element.`,
            });
            continue;
        }

        for (const node of matches) {
            if (template.maxLength !== null && node.text.length > template.maxLength) {
                issues.push({
                    path,
                    kind: 'overlength',
                    message: `Text exceeds the ${template.maxLength}-character limit.`,
                });
            }

            for (const attribute of template.attributes) {
                const vocabulary = attribute.values.split('|').map((value) => value.trim()).filter(Boolean);
                if (vocabulary.length === 0 || !(attribute.name in node.attributes)) {
                    continue;
                }
                if (!vocabulary.includes(node.attributes[attribute.name])) {
                    issues.push({
                        path,
                        kind: 'attribute',
                        message: `Attribute ${attribute.name} has a value outside its vocabulary.`,
                    });
                }
            }
            validateLevel(node.children, template.children, path, issues);
        }
    }

    for (const node of nodes) {
        if (!templates.some((template) => template.name === node.name)) {
            const path = `${parentPath}/${node.name}`;
            issues.push({
                path,
                kind: 'unknown',
                message: `Unknown <${node.name}> element.`,
            });
            validateLevel(node.children, [], path, issues);
        }
    }
}

/**
 * Reports soft conformance issues without rejecting the document.
 *
 * @param {object[]} doc Generic document.
 * @param {object[]} template Template tree.
 * @returns {Array<{path: string, kind: 'missing'|'unknown'|'overlength'|'attribute', message: string}>} Issues.
 */
export function validateAgainstTemplate(doc, template) {
    try {
        const issues = [];
        const normalized = normalizeTemplate(template);
        annotateUnknown(doc, normalized);
        validateLevel(cloneDoc(doc), normalized, '', issues);
        return issues;
    } catch {
        return [];
    }
}
