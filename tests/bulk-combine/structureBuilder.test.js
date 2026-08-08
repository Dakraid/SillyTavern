'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/components/StructureBuilder.js`.
 *
 * The component only imports `structured/*` (pure, dependency-free modules),
 * so NO module mocks are required. The Node test environment has no DOM, so
 * a minimal fake `document`/element tree backs the component (plain DOM APIs
 * only — no jQuery, no HTML parsing, no querySelector).
 *
 * Every mutation assertion compares the `onCommit` payload against the direct
 * output of the corresponding `templateModel` pure op (normalized), proving
 * the DOM layer stays a thin shell over the ops.
 */

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

import {
    RESET_CONFIRM_TIMEOUT_MS,
    VALIDATION_DEBOUNCE_MS,
    createStructureBuilder,
} from '../../public/scripts/bulk-combine/components/StructureBuilder.js';
import {
    DEFAULT_TEMPLATE,
    createNode,
    duplicateNode,
    insertChild,
    moveNode,
    normalizeTemplate,
    removeNode,
    updateNode,
} from '../../public/scripts/bulk-combine/structured/templateModel.js';
import {
    parseTemplate,
    serializeTemplate,
} from '../../public/scripts/bulk-combine/structured/templateText.js';

// ---------------------------------------------------------------------------
// Minimal fake DOM
// ---------------------------------------------------------------------------

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.className = '';
        this.value = '';
        this.disabled = false;
        this.tabIndex = 0;
        this.title = '';
        this.type = '';
        this.id = '';
        this.src = '';
        this.alt = '';
        this.placeholder = '';
        this.hidden = false;
        this.draggable = false;
        this.rows = 0;
        this.spellcheck = true;
        this.min = '';
        this.step = '';
        this.focused = false;
        this._text = '';
        this._listeners = new Map();
    }

    get classList() {
        const el = this;
        const read = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...classes) => {
                el.className = [...new Set([...read(), ...classes])].join(' ');
            },
            remove: (...classes) => {
                el.className = read().filter((c) => !classes.includes(c)).join(' ');
            },
            contains: (c) => read().includes(c),
        };
    }

    get textContent() {
        if (this.children.length > 0) {
            return this.children.map((child) => child.textContent).join('');
        }
        return this._text;
    }

    set textContent(value) {
        this._text = String(value ?? '');
        this.children = [];
    }

    append(...nodes) {
        for (const node of nodes) {
            if (node.parentElement) {
                node.remove();
            }
            node.parentElement = this;
            this.children.push(node);
        }
    }

    insertBefore(node, reference) {
        if (node.parentElement) {
            node.remove();
        }
        node.parentElement = this;
        const index = reference ? this.children.indexOf(reference) : -1;
        if (index >= 0) {
            this.children.splice(index, 0, node);
        } else {
            this.children.push(node);
        }
        return node;
    }

    replaceChildren(...nodes) {
        for (const child of this.children) {
            child.parentElement = null;
        }
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }

    remove() {
        if (this.parentElement) {
            this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
            this.parentElement = null;
        }
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
        const list = this._listeners.get(type) ?? [];
        this._listeners.set(type, list.filter((f) => f !== fn));
    }

    /**
     * Fires listeners for an event type (test helper).
     *
     * @param {string} type Event type.
     * @param {object} [event] Extra event fields (may override target).
     */
    fire(type, event = {}) {
        for (const fn of this._listeners.get(type) ?? []) {
            fn({ target: this, preventDefault: () => {}, ...event });
        }
    }

    click() {
        if (this.disabled) {
            return;
        }
        this.fire('click');
    }

    focus() {
        this.focused = true;
        fakeDocument.activeElement = this;
    }
}

const fakeDocument = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
};

// ---------------------------------------------------------------------------
// Traversal helpers (the fake DOM has no querySelector)
// ---------------------------------------------------------------------------

/**
 * @param {object} node Root fake element.
 * @param {(node: object) => void} visit Visitor.
 * @returns {void}
 */
function walk(node, visit) {
    visit(node);
    for (const child of node.children ?? []) {
        walk(child, visit);
    }
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object[]} Matching elements in document order.
 */
function findAll(root, predicate) {
    const matches = [];
    walk(root, (element) => {
        if (predicate(element)) {
            matches.push(element);
        }
    });
    return matches;
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object|null} First match, or null.
 */
function findOne(root, predicate) {
    return findAll(root, predicate)[0] ?? null;
}

/**
 * @param {string} className Single class token.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasClass(className) {
    return (element) => String(element.className ?? '').split(/\s+/).includes(className);
}

/**
 * @param {string} label Expected `aria-label` value.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasAriaLabel(label) {
    return (element) => typeof element.getAttribute === 'function' && element.getAttribute('aria-label') === label;
}

/**
 * Finds a block element by its node id (`data-node-id`).
 *
 * @param {object} root Root element.
 * @param {string} nodeId Node id.
 * @returns {object|null} Block element, or null.
 */
function findBlock(root, nodeId) {
    return findOne(root, (element) => typeof element.getAttribute === 'function' && element.getAttribute('data-node-id') === nodeId);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Small deterministic fixture tree (normalized → path ids).
 * Root `character` = structured-0; summary = structured-0-0; appearance =
 * structured-0-1; physiology = structured-0-2; genitals = structured-0-2-0.
 *
 * @returns {object[]} Normalized template tree.
 */
function makeTree() {
    return normalizeTemplate([{
        name: 'character',
        hint: 'root hint',
        attributes: [{ name: 'name', values: '' }],
        children: [
            {
                name: 'summary',
                hint: 'short',
                attributes: [{ name: 'name', values: '' }, { name: 'species', values: 'anthro | feral' }],
                maxLength: 800,
            },
            { name: 'appearance', hint: 'looks' },
            {
                name: 'physiology',
                children: [{ name: 'genitals', attributes: [{ name: 'type', values: 'human | etc.' }] }],
            },
        ],
    }]);
}

/**
 * Flat reorder fixture: root[a, b, c] → ids structured-0, structured-0-0..2.
 *
 * @returns {object[]} Normalized template tree.
 */
function makeFlatTree() {
    return normalizeTemplate([{ name: 'root', children: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }]);
}

/**
 * Nesting fixture for indent/outdent: root[a[x]] → x = structured-0-0-0.
 *
 * @returns {object[]} Normalized template tree.
 */
function makeNestedTree() {
    return normalizeTemplate([{ name: 'root', children: [{ name: 'a', children: [{ name: 'x' }] }, { name: 'b' }] }]);
}

/**
 * @returns {object} Controllable fake DataTransfer.
 */
function makeDataTransfer() {
    return {
        data: {},
        effectAllowed: '',
        dropEffect: '',
        /**
         * @param {string} type MIME type.
         * @param {string} value Payload.
         */
        setData(type, value) {
            this.data[type] = value;
        },
        /**
         * @param {string} type MIME type.
         * @returns {string} Payload.
         */
        getData(type) {
            return this.data[type] ?? '';
        },
    };
}

/**
 * Creates a builder and returns the pieces under test.
 *
 * @param {object} [structure] Initial structure.
 * @param {object} [extra] Extra factory options (e.g. onRequestConfirm).
 * @returns {{builder: object, root: Element, onCommit: jest.Mock}} Builder pieces.
 */
function renderBuilder(structure, extra = {}) {
    const onCommit = jest.fn();
    const builder = createStructureBuilder({ structure, onCommit, ...extra });
    return { builder, root: builder.element, onCommit };
}

beforeEach(() => {
    fakeDocument.activeElement = null;
    global.document = fakeDocument;
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    delete global.document;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe('structureBuilder rendering', () => {
    test('renders the default template as an accessible block tree', () => {
        const { builder, root } = renderBuilder({ format: 'xml', template: DEFAULT_TEMPLATE });

        // Canvas is the role=tree host; blocks are treeitems with aria-level.
        const canvas = findOne(root, hasClass('bc-task-sb-canvas'));
        expect(canvas.getAttribute('role')).toBe('tree');
        expect(canvas.getAttribute('aria-label')).toBeTruthy();

        const rootBlock = findBlock(root, 'structured-0');
        expect(rootBlock.getAttribute('role')).toBe('treeitem');
        expect(rootBlock.getAttribute('aria-level')).toBe('1');
        expect(findOne(rootBlock, hasClass('bc-task-sb-name')).textContent).toBe('character');

        for (const name of ['summary', 'appearance', 'physiology', 'style', 'personality', 'sexuality', 'history']) {
            expect(root.textContent).toContain(name);
        }
        const summary = findBlock(root, 'structured-0-0');
        expect(summary.getAttribute('aria-level')).toBe('2');
        // Depth-3 nested block (physiology → genitals).
        const genitals = findBlock(root, 'structured-0-2-0');
        expect(genitals.getAttribute('aria-level')).toBe('3');
        expect(genitals.classList.contains('bc-task-sb-depth-2')).toBe(true);

        // Leaf blocks carry a max-length input (blank = none); containers do not.
        const maxInputs = findAll(root, hasClass('bc-task-sb-max'));
        const leafCount = findAll(root, hasClass('bc-task-sb-block')).length - 2; // character + physiology have children
        expect(maxInputs).toHaveLength(leafCount);
        expect(findOne(summary, hasClass('bc-task-sb-max')).value).toBe('800');
        expect(findOne(summary, hasClass('bc-task-sb-hint')).value).toBe('Name + Short Summary of character');

        // Attribute chips render with the freeform placeholder on blank values.
        const chips = findAll(summary, hasClass('bc-task-sb-chip'));
        expect(chips).toHaveLength(6);
        const speciesValues = findAll(summary, hasClass('bc-task-sb-chip-values'))
            .find((input) => input.value === 'anthro | feral + species');
        expect(speciesValues).toBeTruthy();

        // Toolbar: mode segmented control, format label, reset.
        expect(findOne(root, hasAriaLabel('Visual block editor')).getAttribute('aria-pressed')).toBe('true');
        expect(findOne(root, hasAriaLabel('Text editor mode')).getAttribute('aria-pressed')).toBe('false');
        expect(findOne(root, hasClass('bc-task-sb-format-label')).textContent).toBe('Format preview: XML');
        expect(findOne(root, hasAriaLabel('Reset to default template'))).not.toBe(null);

        // Read-only JSON preview of the committed tree.
        const preview = findOne(root, hasClass('bc-task-sb-preview-json'));
        expect(preview.textContent).toContain('"@name"');
        expect(preview.textContent).toContain('"summary"');
        expect(root.textContent).toContain('JSON/TOON outputs are generated from this template.');

        // getValue returns the committed structure (deep-equal clone).
        expect(builder.getValue()).toEqual({ format: 'xml', template: normalizeTemplate(DEFAULT_TEMPLATE) });
    });

    test('falls back to the default template for missing/empty structures', () => {
        const empty = renderBuilder({ format: 'json', template: [] });
        expect(findOne(empty.root, hasClass('bc-task-sb-name')).textContent).toBe('character');
        expect(findOne(empty.root, hasClass('bc-task-sb-format-label')).textContent).toBe('Format preview: JSON');

        const none = renderBuilder();
        expect(none.builder.getValue().format).toBe('xml');
        expect(none.builder.getValue().template).toEqual(normalizeTemplate(DEFAULT_TEMPLATE));
    });

    test('setStructure re-renders from new props without firing onCommit', () => {
        const { builder, root, onCommit } = renderBuilder({ format: 'xml', template: makeTree() });
        expect(root.textContent).toContain('physiology');

        const replacement = makeFlatTree();
        builder.setStructure({ format: 'toon', template: replacement });

        expect(onCommit).not.toHaveBeenCalled();
        expect(root.textContent).not.toContain('physiology');
        expect(findBlock(root, 'structured-0-2')).not.toBe(null); // flat tree node 'c'
        expect(findOne(root, hasClass('bc-task-sb-name')).textContent).toBe('root');
        expect(findOne(root, hasClass('bc-task-sb-format-label')).textContent).toBe('Format preview: TOON');
        expect(builder.getValue()).toEqual({ format: 'toon', template: replacement });
    });

    test('all icon buttons carry aria-label and title (DESIGN §5)', () => {
        const { root } = renderBuilder({ format: 'xml', template: makeTree() });
        const iconButtons = findAll(root, hasClass('bc-task-sb-icon-button'));
        expect(iconButtons.length).toBeGreaterThan(0);
        for (const button of iconButtons) {
            expect(button.getAttribute('aria-label')).toBeTruthy();
            expect(button.title).toBeTruthy();
        }
    });
});

// ---------------------------------------------------------------------------
// Visual-mode pure-op pathways
// ---------------------------------------------------------------------------

describe('structureBuilder visual ops', () => {
    test('add element inserts via insertChild and focuses the new name input', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        findOne(root, hasAriaLabel('Add child element to appearance')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(insertChild(tree, 'structured-0-1', createNode({ name: 'newElement' }))),
        );

        // New block at path [0,1,0]; its name is in edit mode and focused.
        const newBlock = findBlock(root, 'structured-0-1-0');
        expect(newBlock).not.toBe(null);
        const nameInput = findOne(newBlock, hasClass('bc-task-sb-name-input'));
        expect(nameInput.value).toBe('newElement');
        expect(fakeDocument.activeElement).toBe(nameInput);

        // Adding to a container appends after existing children.
        findOne(root, hasAriaLabel('Add child element to physiology')).click();
        expect(onCommit).toHaveBeenCalledTimes(2);
        expect(findBlock(root, 'structured-0-2-1')).not.toBe(null);
    });

    test('rename commits on Enter, cancels on Escape, rejects empty names', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        // Click label → inline input appears, focused, pre-filled.
        findOne(root, hasAriaLabel('Rename element appearance')).click();
        const block = findBlock(root, 'structured-0-1');
        const input = findOne(block, hasClass('bc-task-sb-name-input'));
        expect(input.value).toBe('appearance');
        expect(fakeDocument.activeElement).toBe(input);

        input.value = 'look';
        input.fire('keydown', { key: 'Enter' });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-1', { name: 'look' })),
        );
        // Label restored after commit.
        expect(findOne(root, hasAriaLabel('Rename element look'))).not.toBe(null);

        // Escape cancels: no commit, label restored.
        findOne(root, hasAriaLabel('Rename element look')).click();
        const editAgain = findOne(findBlock(root, 'structured-0-1'), hasClass('bc-task-sb-name-input'));
        editAgain.value = 'discarded';
        editAgain.fire('keydown', { key: 'Escape' });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findOne(root, hasAriaLabel('Rename element look'))).not.toBe(null);

        // Empty name behaves like cancel.
        findOne(root, hasAriaLabel('Rename element look')).click();
        const emptyEdit = findOne(findBlock(root, 'structured-0-1'), hasClass('bc-task-sb-name-input'));
        emptyEdit.value = '   ';
        emptyEdit.fire('keydown', { key: 'Enter' });
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(findOne(root, hasAriaLabel('Rename element look'))).not.toBe(null);
    });

    test('delete removes non-root nodes via removeNode; root delete is disabled', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        const rootDelete = findOne(root, hasAriaLabel('Delete character'));
        expect(rootDelete.disabled).toBe(true);
        rootDelete.click();
        expect(onCommit).not.toHaveBeenCalled();

        findOne(root, hasAriaLabel('Delete appearance')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(normalizeTemplate(removeNode(tree, 'structured-0-1')));
        expect(root.textContent).not.toContain('appearance');
    });

    test('duplicate clones a subtree with fresh ids; root duplicate is disabled', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        expect(findOne(root, hasAriaLabel('Duplicate character')).disabled).toBe(true);

        findOne(root, hasAriaLabel('Duplicate appearance')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(normalizeTemplate(duplicateNode(tree, 'structured-0-1')));

        // The copy sits next to the source with a fresh (normalized) id.
        expect(findBlock(root, 'structured-0-1')).not.toBe(null);
        expect(findBlock(root, 'structured-0-2')).not.toBe(null);
        const appearanceLabels = findAll(root, hasAriaLabel('Rename element appearance'));
        expect(appearanceLabels).toHaveLength(2);
        // Physiology shifted to path [0,3] after the duplicate.
        expect(findBlock(root, 'structured-0-3')).not.toBe(null);
    });

    test('move up/down/indent/outdent map to moveNode with boundary disabled states', () => {
        const tree = makeFlatTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        // Boundaries: first/last reorder disabled, root fully disabled.
        expect(findOne(root, hasAriaLabel('Move a up')).disabled).toBe(true);
        expect(findOne(root, hasAriaLabel('Move c down')).disabled).toBe(true);
        expect(findOne(root, hasAriaLabel('Indent a')).disabled).toBe(true);
        expect(findOne(root, hasAriaLabel('Outdent a')).disabled).toBe(true);
        for (const label of ['Move root up', 'Move root down', 'Indent root', 'Outdent root']) {
            expect(findOne(root, hasAriaLabel(label)).disabled).toBe(true);
        }

        // Up: b swaps with a. Focus is restored to the moved node's button.
        findOne(root, hasAriaLabel('Move b up')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(normalizeTemplate(moveNode(tree, 'structured-0-1', 'structured-0', 0)));
        expect(fakeDocument.activeElement?.getAttribute('aria-label')).toBe('Move b up');
    });

    test('move down, indent, and outdent compute the expected gap indices', () => {
        const flat = makeFlatTree();
        const down = renderBuilder({ format: 'xml', template: flat });
        findOne(down.root, hasAriaLabel('Move b down')).click();
        // Pre-removal gap index: index + 1 lands after the following sibling.
        expect(down.onCommit).toHaveBeenLastCalledWith(normalizeTemplate(moveNode(flat, 'structured-0-1', 'structured-0', 2)));

        const indent = renderBuilder({ format: 'xml', template: makeFlatTree() });
        findOne(indent.root, hasAriaLabel('Indent b')).click();
        // Indent = move into the previous sibling as its last child.
        expect(indent.onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(makeFlatTree(), 'structured-0-1', 'structured-0-0')),
        );

        const nested = makeNestedTree();
        const outdent = renderBuilder({ format: 'xml', template: nested });
        expect(findOne(outdent.root, hasAriaLabel('Outdent x')).disabled).toBe(false);
        findOne(outdent.root, hasAriaLabel('Outdent x')).click();
        // Outdent = move to the grandparent directly after the parent.
        expect(outdent.onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(nested, 'structured-0-0-0', 'structured-0', 1)),
        );
    });

    test('attribute chips add, edit (name/values), and remove via updateNode', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        // Add: blank chip appended and its name input focused.
        findOne(root, hasAriaLabel('Add attribute to appearance')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-1', { attributes: [{ name: '', values: '' }] })),
        );
        const chipName = findOne(findBlock(root, 'structured-0-1'), hasClass('bc-task-sb-chip-name'));
        expect(fakeDocument.activeElement).toBe(chipName);

        // Edit name on change.
        chipName.value = 'size';
        chipName.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(2);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-1', { attributes: [{ name: 'size', values: '' }] })),
        );

        // Edit values on change (placeholder = freeform).
        const chipValues = findOne(findBlock(root, 'structured-0-1'), hasClass('bc-task-sb-chip-values'));
        expect(chipValues.placeholder).toBe('freeform');
        chipValues.value = 'big | small';
        chipValues.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(3);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-1', { attributes: [{ name: 'size', values: 'big | small' }] })),
        );

        // Remove the chip.
        findOne(root, hasAriaLabel('Remove attribute @size from appearance')).click();
        expect(onCommit).toHaveBeenCalledTimes(4);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-1', { attributes: [] })),
        );
    });

    test('maxLength and hint edits commit via updateNode; invalid max reverts', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        const summaryBlock = () => findBlock(root, 'structured-0-0');

        // Blank max = no limit.
        const maxInput = findOne(summaryBlock(), hasClass('bc-task-sb-max'));
        expect(maxInput.value).toBe('800');
        maxInput.value = '';
        maxInput.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-0', { maxLength: null })),
        );

        // Numeric max commits truncated.
        const maxAgain = findOne(summaryBlock(), hasClass('bc-task-sb-max'));
        maxAgain.value = '500';
        maxAgain.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(2);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-0', { maxLength: 500 })),
        );

        // Garbage input reverts without committing.
        const maxBad = findOne(summaryBlock(), hasClass('bc-task-sb-max'));
        maxBad.value = 'many';
        maxBad.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(2);
        expect(findOne(summaryBlock(), hasClass('bc-task-sb-max')).value).toBe('500');

        // Hint commits on change.
        const hintInput = findOne(summaryBlock(), hasClass('bc-task-sb-hint'));
        hintInput.value = 'a better hint';
        hintInput.fire('change');
        expect(onCommit).toHaveBeenCalledTimes(3);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(updateNode(tree, 'structured-0-0', { maxLength: 500, hint: 'a better hint' })),
        );
    });
});

// ---------------------------------------------------------------------------
// Text mode
// ---------------------------------------------------------------------------

describe('structureBuilder text mode', () => {
    /**
     * Switches a rendered builder to text mode and returns the key elements.
     *
     * @param {object} root Builder root element.
     * @returns {{textarea: object, canvas: object, textPanel: object, visualButton: object}} Elements.
     */
    function enterTextMode(root) {
        findOne(root, hasAriaLabel('Text editor mode')).click();
        return {
            textarea: findOne(root, hasClass('bc-task-sb-textarea')),
            canvas: findOne(root, hasClass('bc-task-sb-canvas')),
            textPanel: findOne(root, hasClass('bc-task-sb-text-panel')),
            visualButton: findOne(root, hasAriaLabel('Visual block editor')),
        };
    }

    test('switching to text mode serializes the committed tree; visual→text always allowed', () => {
        const tree = makeTree();
        const { root } = renderBuilder({ format: 'xml', template: tree });
        const { textarea, canvas, textPanel, visualButton } = enterTextMode(root);

        expect(canvas.hidden).toBe(true);
        expect(textPanel.hidden).toBe(false);
        expect(textarea.rows).toBeGreaterThanOrEqual(16);
        expect(textarea.value).toBe(serializeTemplate(tree));
        expect(root.textContent).toContain('✓ well-formed');
        expect(visualButton.disabled).toBe(false);

        // Back to visual.
        visualButton.click();
        expect(findOne(root, hasClass('bc-task-sb-canvas')).hidden).toBe(false);
        expect(findOne(root, hasClass('bc-task-sb-text-panel')).hidden).toBe(true);
    });

    test('live validation lists line-anchored errors and disables Apply + Visual while dirty', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });
        const { textarea, visualButton } = enterTextMode(root);

        textarea.value = '<character>\n  <summary>\n</character>';
        textarea.fire('input');
        jest.advanceTimersByTime(VALIDATION_DEBOUNCE_MS);

        const errors = findOne(root, hasClass('bc-task-sb-validation-errors'));
        expect(errors).not.toBe(null);
        expect(errors.textContent).toContain('Line');
        expect(findOne(root, hasAriaLabel('Apply text changes')).disabled).toBe(true);

        // Text→Visual is blocked while the buffer is dirty (hint on the button).
        expect(visualButton.disabled).toBe(true);
        expect(visualButton.title).toContain('Apply or discard text changes first');
        visualButton.click(); // Disabled fake click = no-op.
        expect(findOne(root, hasClass('bc-task-sb-canvas')).hidden).toBe(true);
        expect(onCommit).not.toHaveBeenCalled();
    });

    test('Apply parses and commits; Discard reverts to the applied template', () => {
        const tree = makeTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });
        const { textarea, visualButton } = enterTextMode(root);

        const edited = '<character>\n  <summary max="120">short</summary>\n  <mood></mood>\n</character>';
        textarea.value = edited;
        textarea.fire('input');
        jest.advanceTimersByTime(VALIDATION_DEBOUNCE_MS);
        expect(findOne(root, hasAriaLabel('Apply text changes')).disabled).toBe(false);

        findOne(root, hasAriaLabel('Apply text changes')).click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(parseTemplate(edited).tree);

        // After Apply: clean state — Visual re-enabled, Discard disabled.
        expect(visualButton.disabled).toBe(false);
        expect(findOne(root, hasAriaLabel('Discard text changes')).disabled).toBe(true);
        visualButton.click();
        expect(findOne(root, hasClass('bc-task-sb-canvas')).hidden).toBe(false);
        expect(findBlock(root, 'structured-0-1')).not.toBe(null); // 'mood' block now on canvas

        // Dirty again, then Discard reverts the buffer.
        const again = enterTextMode(root);
        again.textarea.value = '<other></other>';
        again.textarea.fire('input');
        expect(findOne(root, hasAriaLabel('Discard text changes')).disabled).toBe(false);
        findOne(root, hasAriaLabel('Discard text changes')).click();
        expect(again.textarea.value).toBe(serializeTemplate(parseTemplate(edited).tree));
        expect(findOne(root, hasAriaLabel('Visual block editor')).disabled).toBe(false);
        expect(onCommit).toHaveBeenCalledTimes(1);
    });

    test('a dirty text buffer survives setStructure and shows the sync badge', () => {
        const tree = makeTree();
        const { builder, root, onCommit } = renderBuilder({ format: 'xml', template: tree });
        const { textarea } = enterTextMode(root);

        textarea.value = '<character><draft></draft></character>';
        textarea.fire('input');
        jest.advanceTimersByTime(VALIDATION_DEBOUNCE_MS);

        builder.setStructure({ format: 'xml', template: makeFlatTree() });
        expect(onCommit).not.toHaveBeenCalled();
        // Buffer preserved; badge visible.
        expect(textarea.value).toBe('<character><draft></draft></character>');
        expect(findOne(root, hasClass('bc-task-sb-sync-badge')).hidden).toBe(false);

        // A clean buffer re-syncs instead.
        const clean = renderBuilder({ format: 'xml', template: makeTree() });
        const cleanText = enterTextMode(clean.root);
        clean.builder.setStructure({ format: 'xml', template: makeFlatTree() });
        expect(cleanText.textarea.value).toBe(serializeTemplate(makeFlatTree()));
        expect(findOne(clean.root, hasClass('bc-task-sb-sync-badge')).hidden).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe('structureBuilder reset', () => {
    test('inline two-tap confirm commits DEFAULT_TEMPLATE and auto-disarms', () => {
        const { root, onCommit } = renderBuilder({ format: 'xml', template: makeFlatTree() });
        const reset = findOne(root, hasAriaLabel('Reset to default template'));

        reset.click();
        expect(onCommit).not.toHaveBeenCalled();
        expect(reset.textContent).toBe('Confirm reset?');
        expect(reset.classList.contains('bc-task-sb-reset-armed')).toBe(true);

        // The armed state reverts after the timeout.
        jest.advanceTimersByTime(RESET_CONFIRM_TIMEOUT_MS);
        expect(reset.textContent).toBe('Reset to default template');
        expect(onCommit).not.toHaveBeenCalled();

        // Two taps within the window commit the default template.
        reset.click();
        reset.click();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(normalizeTemplate(DEFAULT_TEMPLATE));
        expect(reset.textContent).toBe('Reset to default template');
        expect(findOne(root, hasClass('bc-task-sb-name')).textContent).toBe('character');
    });

    test('injected onRequestConfirm receives message + onConfirm and no window confirm is used', () => {
        const onRequestConfirm = jest.fn();
        const { root, onCommit } = renderBuilder(
            { format: 'xml', template: makeFlatTree() },
            { onRequestConfirm },
        );

        findOne(root, hasAriaLabel('Reset to default template')).click();

        expect(onRequestConfirm).toHaveBeenCalledTimes(1);
        const request = onRequestConfirm.mock.calls[0][0];
        expect(request.message).toContain('default character template');
        expect(typeof request.onConfirm).toBe('function');
        expect(onCommit).not.toHaveBeenCalled();

        request.onConfirm();
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(normalizeTemplate(DEFAULT_TEMPLATE));
    });
});

// ---------------------------------------------------------------------------
// Drag & drop
// ---------------------------------------------------------------------------

describe('structureBuilder drag & drop', () => {
    test('handle dragstart seeds the drag state; root handle is not draggable', () => {
        const { root } = renderBuilder({ format: 'xml', template: makeFlatTree() });

        const rootHandle = findOne(findBlock(root, 'structured-0'), hasClass('bc-task-sb-drag'));
        expect(rootHandle.draggable).toBe(false);
        expect(rootHandle.classList.contains('bc-task-sb-drag-disabled')).toBe(true);

        const transfer = makeDataTransfer();
        const cBlock = findBlock(root, 'structured-0-2');
        const handle = findOne(cBlock, hasClass('bc-task-sb-drag'));
        expect(handle.draggable).toBe(true);
        handle.fire('dragstart', { dataTransfer: transfer });
        expect(transfer.data['text/plain']).toBe('structured-0-2');
        expect(cBlock.classList.contains('bc-task-sb-block-dragging')).toBe(true);
        handle.fire('dragend');
        expect(cBlock.classList.contains('bc-task-sb-block-dragging')).toBe(false);
    });

    test('dropping on a container appends via moveNode', () => {
        const tree = makeFlatTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        const transfer = makeDataTransfer();
        findOne(findBlock(root, 'structured-0-0'), hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer });

        const rootContainer = findOne(findBlock(root, 'structured-0'), hasClass('bc-task-sb-children'));
        rootContainer.fire('drop', { dataTransfer: transfer });

        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(tree, 'structured-0-0', 'structured-0', 3)),
        );
    });

    test('dropping before/after a sibling respects the midpoint', () => {
        const tree = makeFlatTree();

        // Before: c dropped above a (clientY in the upper half).
        const before = renderBuilder({ format: 'xml', template: tree });
        const transfer = makeDataTransfer();
        findOne(findBlock(before.root, 'structured-0-2'), hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer });
        const aBlock = findBlock(before.root, 'structured-0-0');
        aBlock.getBoundingClientRect = () => ({ top: 100, height: 40 });
        aBlock.fire('drop', { dataTransfer: transfer, clientY: 110 });
        expect(before.onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(tree, 'structured-0-2', 'structured-0', 0)),
        );

        // After: c dropped below a (clientY in the lower half).
        const after = renderBuilder({ format: 'xml', template: tree });
        const transfer2 = makeDataTransfer();
        findOne(findBlock(after.root, 'structured-0-2'), hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer2 });
        const aBlock2 = findBlock(after.root, 'structured-0-0');
        aBlock2.getBoundingClientRect = () => ({ top: 100, height: 40 });
        aBlock2.fire('drop', { dataTransfer: transfer2, clientY: 130 });
        expect(after.onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(tree, 'structured-0-2', 'structured-0', 1)),
        );
    });

    test('self drops, cycle drops, and id-less drops never reach onCommit', () => {
        const nested = makeNestedTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: nested });

        // Self drop on the same block.
        const transfer = makeDataTransfer();
        const aBlock = findBlock(root, 'structured-0-0');
        findOne(aBlock, hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer });
        aBlock.getBoundingClientRect = () => ({ top: 0, height: 10 });
        aBlock.fire('drop', { dataTransfer: transfer, clientY: 2 });
        expect(onCommit).not.toHaveBeenCalled();

        // Cycle: parent a dropped into its own descendant's container.
        const transfer2 = makeDataTransfer();
        findOne(aBlock, hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer2 });
        const xContainer = findOne(findBlock(root, 'structured-0-0-0'), hasClass('bc-task-sb-children'));
        xContainer.fire('drop', { dataTransfer: transfer2 });
        expect(onCommit).not.toHaveBeenCalled();

        // No drag state and no dataTransfer payload → nothing happens.
        const empty = makeDataTransfer();
        xContainer.fire('drop', { dataTransfer: empty });
        expect(onCommit).not.toHaveBeenCalled();
    });

    test('dataTransfer fallback carries the drag when closure state is absent', () => {
        const tree = makeFlatTree();
        const { root, onCommit } = renderBuilder({ format: 'xml', template: tree });

        // No dragstart: the drop reads the id from the dataTransfer alone.
        const transfer = makeDataTransfer();
        transfer.setData('text/plain', 'structured-0-1');
        const rootContainer = findOne(findBlock(root, 'structured-0'), hasClass('bc-task-sb-children'));
        rootContainer.fire('drop', { dataTransfer: transfer });

        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit).toHaveBeenLastCalledWith(
            normalizeTemplate(moveNode(tree, 'structured-0-1', 'structured-0', 3)),
        );
    });

    test('dragover positions the insertion line indicator at the hovered gap', () => {
        const { root } = renderBuilder({ format: 'xml', template: makeFlatTree() });

        const transfer = makeDataTransfer();
        findOne(findBlock(root, 'structured-0-2'), hasClass('bc-task-sb-drag')).fire('dragstart', { dataTransfer: transfer });

        const bBlock = findBlock(root, 'structured-0-1');
        bBlock.getBoundingClientRect = () => ({ top: 0, height: 20 });
        bBlock.fire('dragover', { dataTransfer: transfer, clientY: 4 }); // upper half → before b

        const line = findOne(root, hasClass('bc-task-sb-insert-line'));
        expect(line).not.toBe(null);
        const container = findOne(findBlock(root, 'structured-0'), hasClass('bc-task-sb-children'));
        expect(line.parentElement).toBe(container);
        // Inserted before the b block (index 1 among the container's children).
        expect(container.children.indexOf(line)).toBe(1);

        // Container-level dragover appends the line at the end (before the add button).
        container.fire('dragover', { dataTransfer: transfer });
        expect(container.children.indexOf(line)).toBe(3);

        // Leaving the container clears the indicator.
        container.fire('dragleave', {});
        expect(findOne(root, hasClass('bc-task-sb-insert-line'))).toBe(null);
    });
});
