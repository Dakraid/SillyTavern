let nextNodeId = 1;

function freshId() {
    return `structured-node-${nextNodeId++}`;
}

function cloneAttributes(attributes) {
    if (!Array.isArray(attributes)) {
        return [];
    }

    return attributes.map((attribute) => ({
        name: String(attribute?.name ?? ''),
        values: String(attribute?.values ?? ''),
    }));
}

/**
 * Creates a structure node without retaining caller-owned references.
 *
 * @param {object} [partial] Initial node fields.
 * @returns {object} Structure node.
 */
export function createNode(partial = {}) {
    return {
        id: String(partial.id || freshId()),
        name: String(partial.name ?? ''),
        hint: String(partial.hint ?? ''),
        attributes: cloneAttributes(partial.attributes),
        maxLength: Number.isFinite(Number(partial.maxLength)) && partial.maxLength !== null && partial.maxLength !== ''
            ? Math.max(0, Math.trunc(Number(partial.maxLength)))
            : null,
        children: Array.isArray(partial.children)
            ? partial.children.map((child) => createNode(child))
            : [],
    };
}

function cloneTree(tree) {
    return Array.isArray(tree) ? tree.map((node) => createNode(node)) : [];
}

function visit(nodes, callback) {
    for (let index = 0; index < nodes.length; index++) {
        if (callback(nodes[index], nodes, index)) {
            return true;
        }
        if (visit(nodes[index].children, callback)) {
            return true;
        }
    }
    return false;
}

function collectIds(nodes, ids = new Set()) {
    for (const node of nodes) {
        ids.add(node.id);
        collectIds(node.children, ids);
    }
    return ids;
}

function refreshIds(node, usedIds) {
    node.id = freshId();
    while (usedIds.has(node.id)) {
        node.id = freshId();
    }
    usedIds.add(node.id);
    node.children.forEach((child) => refreshIds(child, usedIds));
    return node;
}

function ensureUniqueIds(node, usedIds) {
    if (!node.id || usedIds.has(node.id)) {
        node.id = freshId();
        while (usedIds.has(node.id)) {
            node.id = freshId();
        }
    }
    usedIds.add(node.id);
    node.children.forEach((child) => ensureUniqueIds(child, usedIds));
    return node;
}

/**
 * Inserts a child into a cloned tree.
 *
 * @param {object[]} tree Template tree.
 * @param {string} parentId Parent node id.
 * @param {object} node Child node.
 * @param {number} [index] Insertion index.
 * @returns {object[]} Updated tree.
 */
export function insertChild(tree, parentId, node, index) {
    const result = cloneTree(tree);
    const inserted = ensureUniqueIds(createNode(node), collectIds(result));
    visit(result, (candidate) => {
        if (candidate.id !== parentId) {
            return false;
        }
        const target = Number.isInteger(index)
            ? Math.max(0, Math.min(index, candidate.children.length))
            : candidate.children.length;
        candidate.children.splice(target, 0, inserted);
        return true;
    });
    return result;
}

/**
 * Removes a non-root node from a cloned tree.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @returns {object[]} Updated tree.
 */
export function removeNode(tree, id) {
    const result = cloneTree(tree);
    visit(result, (node, siblings, index) => {
        if (node.id === id && siblings !== result) {
            siblings.splice(index, 1);
            return true;
        }
        return false;
    });
    return result;
}

function containsId(node, id) {
    return node.id === id || node.children.some((child) => containsId(child, id));
}

/**
 * Reparents a non-root node in a cloned tree.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @param {string} newParentId New parent id.
 * @param {number} [index] Insertion index.
 * @returns {object[]} Updated tree.
 */
export function moveNode(tree, id, newParentId, index) {
    const result = cloneTree(tree);
    let moving = null;
    let sourceSiblings = null;
    let sourceIndex = -1;

    visit(result, (node, siblings, candidateIndex) => {
        if (node.id === id && siblings !== result) {
            moving = node;
            sourceSiblings = siblings;
            sourceIndex = candidateIndex;
            return true;
        }
        return false;
    });

    if (!moving || containsId(moving, newParentId)) {
        return result;
    }

    let parent = null;
    visit(result, (node) => {
        if (node.id === newParentId) {
            parent = node;
            return true;
        }
        return false;
    });

    if (!parent) {
        return result;
    }

    sourceSiblings.splice(sourceIndex, 1);
    const target = Number.isInteger(index)
        ? Math.max(0, Math.min(index, parent.children.length))
        : parent.children.length;
    parent.children.splice(target, 0, moving);
    return result;
}

/**
 * Duplicates a non-root node next to its source with fresh subtree ids.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @returns {object[]} Updated tree.
 */
export function duplicateNode(tree, id) {
    const result = cloneTree(tree);
    const usedIds = collectIds(result);
    visit(result, (node, siblings, index) => {
        if (node.id !== id || siblings === result) {
            return false;
        }
        siblings.splice(index + 1, 0, refreshIds(createNode(node), usedIds));
        return true;
    });
    return result;
}

/**
 * Applies node fields to a cloned tree while retaining the node id.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @param {object} patch Replacement fields.
 * @returns {object[]} Updated tree.
 */
export function updateNode(tree, id, patch) {
    const result = cloneTree(tree);
    visit(result, (node) => {
        if (node.id !== id) {
            return false;
        }
        const updated = createNode({ ...node, ...patch, id: node.id });
        Object.assign(node, updated, { id: node.id });
        return true;
    });
    return result;
}

function normalizeNode(source, path) {
    const node = source && typeof source === 'object' ? source : {};
    const max = node.maxLength;
    return {
        id: `structured-${path.join('-')}`,
        name: String(node.name ?? ''),
        hint: String(node.hint ?? ''),
        attributes: cloneAttributes(node.attributes),
        maxLength: Number.isFinite(Number(max)) && max !== null && max !== ''
            ? Math.max(0, Math.trunc(Number(max)))
            : null,
        children: Array.isArray(node.children)
            ? node.children.map((child, index) => normalizeNode(child, [...path, index]))
            : [],
    };
}

/**
 * Coerces a template to one canonical root and deterministic traversal ids.
 * Deterministic ids make the canonical XML text form round-trip without
 * leaking builder-only ids into prompts.
 *
 * @param {unknown} tree Candidate tree.
 * @returns {object[]} Normalized single-root template.
 */
export function normalizeTemplate(tree) {
    const roots = Array.isArray(tree) ? tree : [];
    const source = roots.length === 1
        ? roots[0]
        : { name: 'root', children: roots };
    return [normalizeNode(source, [0])];
}

/**
 * Finds the first summary descendant in depth-first order.
 *
 * @param {object[]} tree Template tree.
 * @returns {object|null} Summary node.
 */
export function findSummaryNode(tree) {
    let summary = null;
    visit(cloneTree(tree), (node) => {
        if (node.name === 'summary') {
            summary = node;
            return true;
        }
        return false;
    });
    return summary;
}

const ROOT_HINT = 'all freeform text unless attributed; attributed elements use the values given, only one unless stated otherwise';

export const DEFAULT_TEMPLATE = normalizeTemplate([{
    name: 'character',
    hint: ROOT_HINT,
    attributes: [{ name: 'name', values: '' }],
    children: [
        {
            name: 'summary',
            hint: 'Name + Short Summary of character',
            attributes: [
                { name: 'name', values: '' },
                { name: 'aliases', values: '' },
                { name: 'species', values: 'anthro | feral + species' },
                { name: 'gender', values: '' },
                { name: 'age', values: '' },
                { name: 'role', values: '' },
            ],
            maxLength: 800,
        },
        { name: 'appearance', hint: 'body, face, height, build, fur, feathers, markings, clothes, etc.' },
        {
            name: 'physiology',
            children: [
                {
                    name: 'genitals',
                    hint: 'Humanoid penis, knotted, cloaca, etc.',
                    attributes: [
                        { name: 'type', values: 'human | canine | equine | avian | reptilian | etc.' },
                        { name: 'description', values: 'combine to one descriptor as needed' },
                    ],
                },
                {
                    name: 'fertility',
                    hint: 'Hormonal rhythm and any quirks.',
                    attributes: [
                        { name: 'cycle', values: 'menstrual | heat-lunar | induced-ovulation | always | never' },
                        { name: 'fertility', values: 'fertile | infertile | contraception' },
                    ],
                },
                {
                    name: 'lactation',
                    hint: 'Milk production or nursing traits.',
                    attributes: [{ name: 'capability', values: 'self-lactating | induced | none' }],
                },
            ],
        },
        { name: 'style', hint: 'voice, mannerisms, dialogue style' },
        { name: 'personality', hint: 'personality, character' },
        {
            name: 'sexuality',
            hint: 'kinks, turn-ons, sexual habits and preferences',
            attributes: [
                { name: 'orientation', values: '' },
                { name: 'role', values: '' },
            ],
        },
        { name: 'history', hint: 'backstory, significant life events' },
    ],
}]);
