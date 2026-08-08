'use strict';

/**
 * @file StructureBuilder — visual nested-block editor (Scratch-style) for the
 * Bulk Combine structure template, with a switchable XML text mode.
 *
 * Implements DESIGN `2026-08-08_20-54-DESIGN-...md` §3 + §5 and SPEC
 * `2026-08-08_20-52-SPEC-...md` Feature 3. The component edits the
 * format-agnostic template tree (`structured/templateModel.js`); JSON/TOON
 * outputs are generated from the same tree server-side, so the canvas always
 * shows the canonical element/attribute/hint model regardless of the selected
 * output format.
 *
 * Contract:
 *   `createStructureBuilder({ structure, onCommit, onRequestConfirm })`
 *     → `{ element, setStructure, getValue, dispose }`.
 *   - `structure`: `{ format, template }` (template = tree from templateModel).
 *   - `onCommit(nextTemplate)` fires after EVERY committed mutation: visual
 *     ops commit immediately; text mode commits only on Apply. The payload is
 *     always the NORMALIZED tree (`normalizeTemplate`), so hosts can persist
 *     it verbatim and tests can compare against direct pure-op output.
 *   - `onRequestConfirm({ message, onConfirm })` is an optional injectable
 *     confirm for Reset (the host wires a Popup). When absent, the component
 *     falls back to an inline two-tap confirm on the reset button itself —
 *     never `window.confirm`, never a Popup import (dependency-free).
 *   - `setStructure(structure)` re-renders from host-pushed (server-confirmed)
 *     state. An in-progress TEXT-mode draft is never clobbered: a dirty text
 *     buffer survives prop updates and a small 'server updated' badge appears
 *     instead. It never fires `onCommit`.
 *   - `getValue()` returns a deep clone of the last committed
 *     `{ format, template }`.
 *
 * Rendering contract: plain DOM only (no jQuery, no `querySelector`, no
 * `createTextNode`) so the component runs under the Node unit-test
 * environment with light DOM fakes. The canvas is rebuilt via
 * `replaceChildren` after every op; listeners live only on owned elements;
 * all mutable state is closure-held. Every tree mutation goes through the
 * pure ops in `structured/templateModel.js` — the DOM layer only computes
 * target parent + index and then calls the op. No-op mutations (self-drops,
 * cycles rejected by `moveNode`, unchanged renames) are detected by comparing
 * the normalized result and never reach `onCommit`.
 *
 * Drag & drop is HTML5 DnD from the block handle only, with drop targets on
 * child containers (append) and between siblings (insertion line indicator
 * positioned on dragover). Drag is never the only path: every block carries
 * Up / Down / Indent / Outdent buttons with boundary-aware disabled states.
 * The drag handle itself is decorative (`aria-hidden`) because the move
 * buttons are the accessible equivalent (DESIGN §5: drag has a full button
 * fallback).
 *
 * Styling lives in `components/StructureBuilder.css` (`.bc-task-sb-*`,
 * SmartTheme variables only); `public/style.css` imports it.
 */

import {
    DEFAULT_TEMPLATE,
    createNode,
    duplicateNode,
    insertChild,
    moveNode,
    normalizeTemplate,
    removeNode,
    updateNode,
} from '../structured/templateModel.js';
import { parseTemplate, serializeTemplate } from '../structured/templateText.js';

/**
 * Debounce delay for the live text-mode validation panel.
 *
 * @type {number}
 */
export const VALIDATION_DEBOUNCE_MS = 300;

/**
 * How long the inline reset confirm stays armed before reverting.
 *
 * @type {number}
 */
export const RESET_CONFIRM_TIMEOUT_MS = 3000;

/**
 * Depth tint classes are generated for depths 0..MAX_DEPTH_CLASS; deeper
 * blocks reuse the deepest tint.
 *
 * @type {number}
 */
const MAX_DEPTH_CLASS = 5;

const RESET_LABEL = 'Reset to default template';
const RESET_ARMED_LABEL = 'Confirm reset?';
const RESET_MESSAGE = 'Reset the structure template to the default character template? The current template will be replaced.';
const SYNC_BADGE_TEXT = 'The template was updated elsewhere — your unapplied text edits are kept.';
const PREVIEW_CAPTION = 'JSON/TOON outputs are generated from this template.';
const TEXT_HINT = 'Hints render as XML comments above their element; max="N" caps text length. Apply commits your edits; Discard reverts to the applied template.';
const VISUAL_DIRTY_TITLE = 'Apply or discard text changes first.';

/**
 * Locates a node in the tree, returning live positional context used for
 * boundary-aware move buttons and drop-index computation.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @returns {{node: object, parent: object|null, grandparent: object|null, siblings: object[], index: number, parentIndex: number, depth: number}|null} Location, or null when absent.
 */
function locate(tree, id) {
    /**
     * @param {object[]} nodes Sibling list under inspection.
     * @param {Array<{node: object, index: number}>} ancestors Ancestor chain (root-first).
     * @returns {object|null} Location or null.
     */
    function walk(nodes, ancestors) {
        for (let index = 0; index < nodes.length; index++) {
            const node = nodes[index];
            if (node.id === id) {
                const parentEntry = ancestors[ancestors.length - 1] ?? null;
                const grandEntry = ancestors[ancestors.length - 2] ?? null;
                return {
                    node,
                    parent: parentEntry?.node ?? null,
                    grandparent: grandEntry?.node ?? null,
                    siblings: nodes,
                    index,
                    parentIndex: parentEntry?.index ?? -1,
                    depth: ancestors.length + 1,
                };
            }
            const found = walk(node.children, [...ancestors, { node, index }]);
            if (found) {
                return found;
            }
        }
        return null;
    }
    return walk(tree, []);
}

/**
 * Finds the index path of a node (root = [0], its second child = [0, 1], …).
 * Normalized ids derive from this path (`structured-<path>`), which lets the
 * builder predict a node's id in the committed tree before normalizing.
 *
 * @param {object[]} tree Template tree.
 * @param {string} id Node id.
 * @returns {number[]|null} Index path, or null when absent.
 */
function findPathById(tree, id) {
    /**
     * @param {object[]} nodes Sibling list under inspection.
     * @param {number[]} path Index path of `nodes`.
     * @returns {number[]|null} Index path or null.
     */
    function walk(nodes, path) {
        for (let index = 0; index < nodes.length; index++) {
            const current = [...path, index];
            if (nodes[index].id === id) {
                return current;
            }
            const found = walk(nodes[index].children, current);
            if (found) {
                return found;
            }
        }
        return null;
    }
    return walk(tree, []);
}

/**
 * Maps an index path to the deterministic id `normalizeTemplate` assigns.
 *
 * @param {number[]} path Index path.
 * @returns {string} Normalized node id.
 */
function idForPath(path) {
    return `structured-${path.join('-')}`;
}

/**
 * Mirrors the JSON skeleton mapping from `structured/renderPrompt.js`
 * (element → key, attributes → `@name`, hint → `#text`, repeated children →
 * single-exemplar arrays) for the read-only format preview. Kept local so the
 * preview stays dependency-light and deterministic.
 *
 * @param {object} node Template node.
 * @returns {object} JSON-shaped skeleton value.
 */
function skeletonValue(node) {
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
        const exemplar = skeletonValue(children[0]);
        value[name] = children.length > 1 ? [exemplar] : exemplar;
    }
    return value;
}

/**
 * Builds the JSON skeleton of a template tree for the preview pane.
 *
 * @param {object[]} tree Template tree.
 * @returns {object} JSON-shaped skeleton (`{ <rootName>: … }`).
 */
function buildJsonModel(tree) {
    const root = normalizeTemplate(tree)[0];
    return { [root.name]: skeletonValue(root) };
}

/**
 * Whether a drop event lands in the upper half of a block (insert before) or
 * the lower half (insert after). Without geometry (tests, exotic browsers)
 * drops default to "after" — deterministic and always append-safe.
 *
 * @param {Element} element Block element under the cursor.
 * @param {unknown} clientY Event clientY.
 * @returns {boolean} True when the drop means "before" the block.
 */
function isBeforeMidpoint(element, clientY) {
    const rect = typeof element?.getBoundingClientRect === 'function'
        ? element.getBoundingClientRect()
        : null;
    if (!rect || typeof clientY !== 'number') {
        return false;
    }
    return clientY < rect.top + rect.height / 2;
}

/**
 * Creates the StructureBuilder component.
 *
 * @param {object} [options] Component options.
 * @param {{format?: string, template?: object[]}} [options.structure] Initial structure (`{ format, template }`).
 * @param {(template: object[]) => void} [options.onCommit] Commit callback (normalized template).
 * @param {(request: {message: string, onConfirm: () => void}) => void} [options.onRequestConfirm] Injectable confirm for Reset.
 * @returns {{element: Element, setStructure: (structure: {format?: string, template?: object[]}) => void, getValue: () => {format: string, template: object[]}, dispose: () => void}} Component instance.
 */
export function createStructureBuilder({ structure, onCommit, onRequestConfirm } = {}) {
    /** @type {{format: string, template: object[]}} Last committed structure. */
    let currentStructure = {
        format: typeof structure?.format === 'string' && structure.format ? structure.format : 'xml',
        template: Array.isArray(structure?.template) && structure.template.length > 0
            ? normalizeTemplate(structure.template)
            : structuredClone(DEFAULT_TEMPLATE),
    };
    /** @type {'visual'|'text'} Active editor mode. */
    let mode = 'visual';
    /** @type {boolean} Whether the text buffer differs from the applied template. */
    let textDirty = false;
    /** @type {string} Textarea content at the last sync/apply/discard point. */
    let lastSyncedText = '';
    /** @type {Array<{line: number, message: string}>} Latest text-mode parse errors. */
    let lastErrors = [];
    /** @type {{id: string}|null} In-flight drag (closure-first; dataTransfer is the fallback). */
    let dragState = null;
    /** @type {string|null} Node id whose name is being edited inline. */
    let nameEditId = null;
    /** @type {{nodeId: string, field: string, index?: number}|null} Focus to restore after the next canvas render. */
    let focusRequest = null;
    /** @type {{element: Element, select?: boolean}|null} Element captured during the current render. */
    let capturedFocus = null;
    /** @type {boolean} Whether the inline reset confirm is armed. */
    let resetArmed = false;
    /** @type {ReturnType<typeof setTimeout>|null} Validation debounce timer. */
    let validationTimer = null;
    /** @type {ReturnType<typeof setTimeout>|null} Reset disarm timer. */
    let resetTimer = null;

    // -----------------------------------------------------------------------
    // Persistent DOM (built once; sub-parts re-render in place)
    // -----------------------------------------------------------------------

    const root = document.createElement('div');
    root.className = 'bc-task-sb';

    const toolbar = document.createElement('div');
    toolbar.className = 'bc-task-sb-toolbar';

    const modeGroup = document.createElement('span');
    modeGroup.className = 'bc-task-sb-mode';
    modeGroup.setAttribute('role', 'group');
    modeGroup.setAttribute('aria-label', 'Editor mode');

    const visualButton = document.createElement('button');
    visualButton.type = 'button';
    visualButton.className = 'bc-task-sb-mode-button';
    visualButton.textContent = 'Visual';
    visualButton.setAttribute('aria-label', 'Visual block editor');
    visualButton.addEventListener('click', () => setMode('visual'));

    const textButton = document.createElement('button');
    textButton.type = 'button';
    textButton.className = 'bc-task-sb-mode-button';
    textButton.textContent = 'Text';
    textButton.setAttribute('aria-label', 'Text editor mode');
    textButton.title = 'Edit the template as XML text.';
    textButton.addEventListener('click', () => setMode('text'));
    modeGroup.append(visualButton, textButton);

    const formatLabel = document.createElement('span');
    formatLabel.className = 'bc-task-sb-format-label';

    const syncBadge = document.createElement('span');
    syncBadge.className = 'bc-task-sb-sync-badge';
    syncBadge.setAttribute('role', 'status');
    syncBadge.textContent = SYNC_BADGE_TEXT;
    syncBadge.hidden = true;

    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'bc-task-sb-reset';
    resetButton.addEventListener('click', onResetClick);
    toolbar.append(modeGroup, formatLabel, syncBadge, resetButton);

    const canvas = document.createElement('div');
    canvas.className = 'bc-task-sb-canvas';
    canvas.setAttribute('role', 'tree');
    canvas.setAttribute('aria-label', 'Structure template');

    const textPanel = document.createElement('div');
    textPanel.className = 'bc-task-sb-text-panel';
    textPanel.hidden = true;

    const textarea = document.createElement('textarea');
    textarea.className = 'bc-task-sb-textarea';
    textarea.rows = 16;
    textarea.spellcheck = false;
    textarea.setAttribute('aria-label', 'Template XML editor');

    const validation = document.createElement('div');
    validation.className = 'bc-task-sb-validation';
    validation.setAttribute('role', 'status');
    validation.setAttribute('aria-live', 'polite');

    const textActions = document.createElement('div');
    textActions.className = 'bc-task-sb-text-actions';
    const applyButton = document.createElement('button');
    applyButton.type = 'button';
    applyButton.className = 'bc-task-sb-apply';
    applyButton.textContent = 'Apply';
    applyButton.setAttribute('aria-label', 'Apply text changes');
    applyButton.addEventListener('click', onApply);
    const discardButton = document.createElement('button');
    discardButton.type = 'button';
    discardButton.className = 'bc-task-sb-discard';
    discardButton.textContent = 'Discard changes';
    discardButton.setAttribute('aria-label', 'Discard text changes');
    discardButton.addEventListener('click', onDiscard);
    const textHint = document.createElement('span');
    textHint.className = 'bc-task-sb-text-hint';
    textHint.textContent = TEXT_HINT;
    textActions.append(applyButton, discardButton);
    textPanel.append(textarea, textHint, validation, textActions);

    const preview = document.createElement('div');
    preview.className = 'bc-task-sb-preview';
    const previewCaption = document.createElement('p');
    previewCaption.className = 'bc-task-sb-preview-caption';
    previewCaption.textContent = PREVIEW_CAPTION;
    const previewPre = document.createElement('pre');
    previewPre.className = 'bc-task-sb-preview-json';
    previewPre.setAttribute('aria-label', 'JSON rendering of the template');
    preview.append(previewCaption, previewPre);

    const insertLine = document.createElement('div');
    insertLine.className = 'bc-task-sb-insert-line';
    insertLine.setAttribute('aria-hidden', 'true');

    textarea.addEventListener('input', onTextInput);

    root.append(toolbar, canvas, textPanel, preview);

    // -----------------------------------------------------------------------
    // Commit pipeline
    // -----------------------------------------------------------------------

    /**
     * Normalizes, stores, re-renders, and commits a mutated tree. No-op
     * results (normalized JSON identical) re-render but never reach onCommit.
     *
     * @param {object[]} nextTree Mutated tree (pure-op output).
     * @returns {void}
     */
    function commitTree(nextTree) {
        const normalized = normalizeTemplate(nextTree);
        const changed = JSON.stringify(normalized) !== JSON.stringify(currentStructure.template);
        currentStructure = { format: currentStructure.format, template: normalized };
        renderCanvas();
        renderPreview();
        if (changed) {
            onCommit?.(structuredClone(normalized));
        }
    }

    /**
     * Records a focus request to honor after the next canvas render.
     *
     * @param {string} nodeId Target node id (normalized id of the node post-commit).
     * @param {string} field Focusable field key (`name`, `move-up`, `attr-name`, …).
     * @param {number} [index] Attribute index for chip fields.
     * @returns {void}
     */
    function requestFocus(nodeId, field, index) {
        focusRequest = { nodeId, field, index };
    }

    /**
     * Captures a focus candidate during block construction when it matches the
     * pending focus request.
     *
     * @param {string} nodeId Node id being built.
     * @param {string} field Field key being built.
     * @param {Element} element Focusable element.
     * @param {boolean} [select] Whether to select the element's text on focus.
     * @param {number} [index] Attribute index for chip fields.
     * @returns {void}
     */
    function captureFocus(nodeId, field, element, select, index) {
        if (focusRequest?.nodeId !== nodeId || focusRequest.field !== field) {
            return;
        }
        if (field === 'attr-name' && focusRequest.index !== index) {
            return;
        }
        capturedFocus = { element, select: select === true };
    }

    /**
     * Focuses the captured element after a render and clears the request.
     *
     * @returns {void}
     */
    function flushFocus() {
        const captured = capturedFocus;
        capturedFocus = null;
        focusRequest = null;
        if (!captured) {
            return;
        }
        captured.element.focus?.();
        if (captured.select) {
            captured.element.select?.();
        }
    }

    // -----------------------------------------------------------------------
    // Visual-mode tree operations (thin wrappers over templateModel pure ops)
    // -----------------------------------------------------------------------

    /**
     * Adds a `newElement` child to a node and focuses its name input for
     * immediate renaming (DESIGN §3/§5).
     *
     * @param {string} parentId Parent node id.
     * @returns {void}
     */
    function addChildElement(parentId) {
        const draft = createNode({ name: 'newElement' });
        const inserted = insertChild(currentStructure.template, parentId, draft);
        const path = findPathById(inserted, draft.id);
        if (path) {
            const normalizedId = idForPath(path);
            nameEditId = normalizedId;
            requestFocus(normalizedId, 'name');
        }
        commitTree(inserted);
    }

    /**
     * Moves a node via the button fallback (drag is never the only path).
     * Restores focus onto the same move button of the moved node afterwards.
     *
     * @param {string} id Node id.
     * @param {'up'|'down'|'indent'|'outdent'} direction Move direction.
     * @returns {void}
     */
    function moveNodeBy(id, direction) {
        const loc = locate(currentStructure.template, id);
        if (!loc?.parent) {
            return;
        }
        let next = currentStructure.template;
        if (direction === 'up' && loc.index > 0) {
            next = moveNode(currentStructure.template, id, loc.parent.id, loc.index - 1);
        } else if (direction === 'down' && loc.index < loc.siblings.length - 1) {
            // Pre-removal gap index: moveNode splices the node out first, so
            // index + 1 lands the node after the following sibling.
            next = moveNode(currentStructure.template, id, loc.parent.id, loc.index + 1);
        } else if (direction === 'indent' && loc.index > 0) {
            next = moveNode(currentStructure.template, id, loc.siblings[loc.index - 1].id);
        } else if (direction === 'outdent' && loc.grandparent) {
            next = moveNode(currentStructure.template, id, loc.grandparent.id, loc.parentIndex + 1);
        }
        if (next === currentStructure.template) {
            return;
        }
        const path = findPathById(next, id);
        if (path) {
            requestFocus(idForPath(path), `move-${direction}`);
        }
        commitTree(next);
    }

    /**
     * Duplicates a non-root node (fresh subtree ids via the pure op).
     *
     * @param {string} id Node id.
     * @returns {void}
     */
    function duplicateNodeBy(id) {
        if (!locate(currentStructure.template, id)?.parent) {
            return;
        }
        commitTree(duplicateNode(currentStructure.template, id));
    }

    /**
     * Deletes a non-root node.
     *
     * @param {string} id Node id.
     * @returns {void}
     */
    function deleteNodeBy(id) {
        if (!locate(currentStructure.template, id)?.parent) {
            return;
        }
        commitTree(removeNode(currentStructure.template, id));
    }

    /**
     * Commits an inline rename. Empty names cancel (revert to the label)
     * rather than committing an invalid template.
     *
     * @param {string} id Node id.
     * @param {string} value Raw input value.
     * @returns {void}
     */
    function commitRename(id, value) {
        const name = String(value ?? '').trim();
        const loc = locate(currentStructure.template, id);
        if (!loc || !name || name === loc.node.name) {
            renderCanvas();
            return;
        }
        commitTree(updateNode(currentStructure.template, id, { name }));
    }

    /**
     * Adds a blank attribute chip and focuses its name input.
     *
     * @param {string} nodeId Node id.
     * @returns {void}
     */
    function addAttribute(nodeId) {
        const loc = locate(currentStructure.template, nodeId);
        if (!loc) {
            return;
        }
        const index = loc.node.attributes.length;
        requestFocus(nodeId, 'attr-name', index);
        commitTree(updateNode(currentStructure.template, nodeId, {
            attributes: [...loc.node.attributes, { name: '', values: '' }],
        }));
    }

    /**
     * Commits one attribute field (name or values) on a chip.
     *
     * @param {string} nodeId Node id.
     * @param {number} index Attribute index.
     * @param {'name'|'values'} field Attribute field.
     * @param {string} value New value.
     * @returns {void}
     */
    function commitAttributeField(nodeId, index, field, value) {
        const loc = locate(currentStructure.template, nodeId);
        if (!loc || !loc.node.attributes[index] || loc.node.attributes[index][field] === value) {
            return;
        }
        const attributes = loc.node.attributes.map((attribute, attributeIndex) => attributeIndex === index
            ? { ...attribute, [field]: value }
            : attribute);
        commitTree(updateNode(currentStructure.template, nodeId, { attributes }));
    }

    /**
     * Removes an attribute chip.
     *
     * @param {string} nodeId Node id.
     * @param {number} index Attribute index.
     * @returns {void}
     */
    function removeAttribute(nodeId, index) {
        const loc = locate(currentStructure.template, nodeId);
        if (!loc) {
            return;
        }
        commitTree(updateNode(currentStructure.template, nodeId, {
            attributes: loc.node.attributes.filter((_, attributeIndex) => attributeIndex !== index),
        }));
    }

    /**
     * Commits a max-length change on a text node (blank = no limit). Invalid
     * numbers revert the input without committing.
     *
     * @param {string} nodeId Node id.
     * @param {string} raw Raw input value.
     * @returns {void}
     */
    function commitMaxLength(nodeId, raw) {
        const text = String(raw ?? '').trim();
        const parsed = text === '' ? null : Number(text);
        if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) {
            renderCanvas();
            return;
        }
        const maxLength = parsed === null ? null : Math.trunc(parsed);
        const loc = locate(currentStructure.template, nodeId);
        if (!loc || loc.node.maxLength === maxLength) {
            return;
        }
        commitTree(updateNode(currentStructure.template, nodeId, { maxLength }));
    }

    /**
     * Commits a hint change.
     *
     * @param {string} nodeId Node id.
     * @param {string} value New hint.
     * @returns {void}
     */
    function commitHint(nodeId, value) {
        const loc = locate(currentStructure.template, nodeId);
        if (!loc || loc.node.hint === value) {
            return;
        }
        commitTree(updateNode(currentStructure.template, nodeId, { hint: value }));
    }

    // -----------------------------------------------------------------------
    // Drag & drop (HTML5 DnD; handlers only compute parent+index, then call ops)
    // -----------------------------------------------------------------------

    /**
     * Positions the insertion-line indicator inside a child container.
     *
     * @param {Element} containerEl Children container.
     * @param {number} index Gap index among the container's block children.
     * @returns {void}
     */
    function showInsertLine(containerEl, index) {
        // Gap indices count block children only; the indicator itself may
        // already be inside the container, so it is excluded from the lookup.
        const blocks = Array.from(containerEl.children ?? []).filter((child) => child !== insertLine);
        containerEl.insertBefore(insertLine, blocks[index] ?? null);
    }

    /**
     * Removes the insertion-line indicator.
     *
     * @returns {void}
     */
    function clearInsertLine() {
        insertLine.remove?.();
    }

    /**
     * Begins a drag from a block handle.
     *
     * @param {object} event Drag event.
     * @param {string} nodeId Dragged node id.
     * @param {Element} blockEl Block element (for the dragging style).
     * @returns {void}
     */
    function onDragStart(event, nodeId, blockEl) {
        dragState = { id: nodeId };
        event.dataTransfer?.setData?.('text/plain', nodeId);
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
        }
        blockEl.classList.add('bc-task-sb-block-dragging');
    }

    /**
     * Ends a drag (drop or cancel): clears state and the indicator.
     *
     * @param {object} event Drag event.
     * @param {Element} blockEl Block element.
     * @returns {void}
     */
    function onDragEnd(event, blockEl) {
        dragState = null;
        blockEl.classList.remove('bc-task-sb-block-dragging');
        clearInsertLine();
    }

    /**
     * Allows an append-drop over a child container and shows the end-of-list
     * insertion line.
     *
     * @param {object} event Drag event.
     * @param {string} parentId Container's parent node id.
     * @param {Element} containerEl Children container.
     * @returns {void}
     */
    function onContainerDragOver(event, parentId, containerEl) {
        if (!dragState) {
            return;
        }
        event.preventDefault?.();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        const loc = locate(currentStructure.template, parentId);
        showInsertLine(containerEl, loc?.node.children.length ?? containerEl.children?.length ?? 0);
    }

    /**
     * Allows a before/after drop over a sibling block and positions the
     * insertion line at the hovered gap.
     *
     * @param {object} event Drag event.
     * @param {object} overNode Hovered block's node.
     * @param {Element} blockEl Hovered block element.
     * @param {Element} containerEl Owning children container.
     * @returns {void}
     */
    function onBlockDragOver(event, overNode, blockEl, containerEl) {
        if (!dragState) {
            return;
        }
        event.preventDefault?.();
        event.stopPropagation?.();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'move';
        }
        if (dragState.id === overNode.id) {
            clearInsertLine();
            return;
        }
        const loc = locate(currentStructure.template, overNode.id);
        if (!loc) {
            return;
        }
        showInsertLine(containerEl, isBeforeMidpoint(blockEl, event.clientY) ? loc.index : loc.index + 1);
    }

    /**
     * Clears the insertion line when the pointer leaves a container (but not
     * when it merely moves between the container's children).
     *
     * @param {object} event Drag event.
     * @param {Element} containerEl Children container.
     * @returns {void}
     */
    function onContainerDragLeave(event, containerEl) {
        if (event.relatedTarget && typeof containerEl.contains === 'function' && containerEl.contains(event.relatedTarget)) {
            return;
        }
        clearInsertLine();
    }

    /**
     * Reads the dragged id from closure state or the dataTransfer fallback.
     *
     * @param {object} event Drop event.
     * @returns {string|null} Dragged node id.
     */
    function draggedIdOf(event) {
        return dragState?.id ?? event.dataTransfer?.getData?.('text/plain') ?? null;
    }

    /**
     * Drops onto a child container: appends the dragged node as the last
     * child. Cycle and self moves are rejected by `moveNode` and the no-op
     * guard in `commitTree`.
     *
     * @param {object} event Drop event.
     * @param {string} parentId Container's parent node id.
     * @returns {void}
     */
    function onContainerDrop(event, parentId) {
        event.preventDefault?.();
        const draggedId = draggedIdOf(event);
        dragState = null;
        clearInsertLine();
        if (!draggedId) {
            return;
        }
        const loc = locate(currentStructure.template, parentId);
        if (!loc) {
            return;
        }
        commitTree(moveNode(currentStructure.template, draggedId, parentId, loc.node.children.length));
    }

    /**
     * Drops onto a sibling block: inserts before/after it based on the drop
     * position within the block's bounds.
     *
     * @param {object} event Drop event.
     * @param {string} parentId Parent node id of the hovered block.
     * @param {object} overNode Hovered block's node.
     * @param {Element} blockEl Hovered block element.
     * @returns {void}
     */
    function onBlockDrop(event, parentId, overNode, blockEl) {
        event.preventDefault?.();
        event.stopPropagation?.();
        const draggedId = draggedIdOf(event);
        dragState = null;
        clearInsertLine();
        if (!draggedId || draggedId === overNode.id) {
            return;
        }
        const loc = locate(currentStructure.template, overNode.id);
        if (!loc) {
            return;
        }
        const index = isBeforeMidpoint(blockEl, event.clientY) ? loc.index : loc.index + 1;
        commitTree(moveNode(currentStructure.template, draggedId, parentId, index));
    }

    // -----------------------------------------------------------------------
    // Text mode
    // -----------------------------------------------------------------------

    /**
     * Re-syncs the textarea to the canonical serialization of the committed
     * template and clears the dirty state.
     *
     * @returns {void}
     */
    function syncTextarea() {
        textarea.value = serializeTemplate(currentStructure.template);
        lastSyncedText = textarea.value;
        textDirty = false;
        lastErrors = [];
        renderValidation();
        updateTextButtons();
    }

    /**
     * Handles textarea input: updates dirty state, mode/text buttons, and
     * schedules debounced validation.
     *
     * @returns {void}
     */
    function onTextInput() {
        textDirty = textarea.value !== lastSyncedText;
        updateModeButtons();
        updateTextButtons();
        clearTimeout(validationTimer);
        validationTimer = setTimeout(runValidation, VALIDATION_DEBOUNCE_MS);
    }

    /**
     * Runs the debounced live validation pass over the text buffer.
     *
     * @returns {void}
     */
    function runValidation() {
        validationTimer = null;
        lastErrors = parseTemplate(textarea.value).errors;
        renderValidation();
        updateTextButtons();
    }

    /**
     * Renders the validation panel: a well-formed marker or the line-anchored
     * error list.
     *
     * @returns {void}
     */
    function renderValidation() {
        if (lastErrors.length === 0) {
            const ok = document.createElement('p');
            ok.className = 'bc-task-sb-validation-ok';
            ok.textContent = '✓ well-formed';
            validation.replaceChildren(ok);
            return;
        }
        const list = document.createElement('ul');
        list.className = 'bc-task-sb-validation-errors';
        for (const error of lastErrors) {
            const item = document.createElement('li');
            item.textContent = `Line ${error.line}: ${error.message}`;
            list.append(item);
        }
        validation.replaceChildren(list);
    }

    /**
     * Updates Apply/Discard disabled states from validation + dirty state.
     *
     * @returns {void}
     */
    function updateTextButtons() {
        applyButton.disabled = lastErrors.length > 0;
        applyButton.title = applyButton.disabled
            ? 'Fix the template errors before applying.'
            : 'Parse the text and commit it as the template.';
        discardButton.disabled = !textDirty;
        discardButton.title = discardButton.disabled
            ? 'No changes to discard.'
            : 'Revert to the applied template.';
    }

    /**
     * Applies the text buffer: parses and commits, then re-enables switching.
     *
     * @returns {void}
     */
    function onApply() {
        const result = parseTemplate(textarea.value);
        lastErrors = result.errors;
        if (result.errors.length > 0 || !result.tree) {
            renderValidation();
            updateTextButtons();
            return;
        }
        lastSyncedText = textarea.value;
        textDirty = false;
        hideSyncBadge();
        commitTree(result.tree);
        renderValidation();
        updateModeButtons();
        updateTextButtons();
    }

    /**
     * Discards the text buffer back to the applied template.
     *
     * @returns {void}
     */
    function onDiscard() {
        clearTimeout(validationTimer);
        validationTimer = null;
        syncTextarea();
        hideSyncBadge();
        updateModeButtons();
    }

    // -----------------------------------------------------------------------
    // Mode toggle
    // -----------------------------------------------------------------------

    /**
     * Switches between visual and text mode. Visual→Text is always allowed
     * (serializes the committed tree); Text→Visual requires an applied/clean
     * buffer (the Visual button is disabled with a hint while dirty).
     *
     * @param {'visual'|'text'} nextMode Target mode.
     * @returns {void}
     */
    function setMode(nextMode) {
        if (nextMode === mode || (nextMode === 'visual' && textDirty)) {
            return;
        }
        mode = nextMode;
        if (mode === 'text') {
            syncTextarea();
        } else {
            clearTimeout(validationTimer);
            validationTimer = null;
            hideSyncBadge();
        }
        renderModeVisibility();
        updateModeButtons();
    }

    /**
     * Toggles canvas/text-panel visibility for the active mode.
     *
     * @returns {void}
     */
    function renderModeVisibility() {
        canvas.hidden = mode !== 'visual';
        textPanel.hidden = mode !== 'text';
    }

    /**
     * Updates the segmented mode control (active class, pressed state, and
     * the dirty-guard on the Visual button).
     *
     * @returns {void}
     */
    function updateModeButtons() {
        visualButton.classList[mode === 'visual' ? 'add' : 'remove']('bc-task-sb-mode-active');
        textButton.classList[mode === 'text' ? 'add' : 'remove']('bc-task-sb-mode-active');
        visualButton.setAttribute('aria-pressed', String(mode === 'visual'));
        textButton.setAttribute('aria-pressed', String(mode === 'text'));
        visualButton.disabled = mode === 'text' && textDirty;
        visualButton.title = visualButton.disabled ? VISUAL_DIRTY_TITLE : 'Edit the template as nested blocks.';
    }

    // -----------------------------------------------------------------------
    // Reset (injectable confirm, inline two-tap fallback)
    // -----------------------------------------------------------------------

    /**
     * Handles the reset button: delegates to the injectable confirm when
     * present, otherwise arms the inline two-tap confirm for
     * {@link RESET_CONFIRM_TIMEOUT_MS}.
     *
     * @returns {void}
     */
    function onResetClick() {
        if (typeof onRequestConfirm === 'function') {
            onRequestConfirm({ message: RESET_MESSAGE, onConfirm: performReset });
            return;
        }
        if (resetArmed) {
            performReset();
            return;
        }
        resetArmed = true;
        renderResetButton();
        clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
            resetArmed = false;
            resetTimer = null;
            renderResetButton();
        }, RESET_CONFIRM_TIMEOUT_MS);
    }

    /**
     * Renders the reset button for the armed/disarmed state.
     *
     * @returns {void}
     */
    function renderResetButton() {
        resetButton.textContent = resetArmed ? RESET_ARMED_LABEL : RESET_LABEL;
        resetButton.classList[resetArmed ? 'add' : 'remove']('bc-task-sb-reset-armed');
        resetButton.setAttribute('aria-label', resetArmed ? 'Confirm reset to default template' : RESET_LABEL);
        resetButton.title = resetArmed ? 'Click again to replace the current template.' : 'Replace the template with the default character template.';
    }

    /**
     * Commits a fresh clone of the default template. In text mode the buffer
     * is re-synced (reset is an explicit, confirmed replacement).
     *
     * @returns {void}
     */
    function performReset() {
        clearTimeout(resetTimer);
        resetTimer = null;
        resetArmed = false;
        renderResetButton();
        nameEditId = null;
        focusRequest = null;
        hideSyncBadge();
        commitTree(structuredClone(DEFAULT_TEMPLATE));
        if (mode === 'text') {
            syncTextarea();
            updateModeButtons();
        }
    }

    /**
     * Shows the 'server updated' badge (setStructure arrived during a dirty
     * text draft).
     *
     * @returns {void}
     */
    function showSyncBadge() {
        syncBadge.hidden = false;
    }

    /**
     * Hides the 'server updated' badge.
     *
     * @returns {void}
     */
    function hideSyncBadge() {
        syncBadge.hidden = true;
    }

    // -----------------------------------------------------------------------
    // Visual-mode block builders
    // -----------------------------------------------------------------------

    /**
     * Builds a small icon button with an accessible label.
     *
     * @param {object} options Button options.
     * @param {string} options.icon Font Awesome icon class (e.g. `fa-arrow-up`).
     * @param {string} options.label Accessible name (`aria-label`).
     * @param {string} [options.title] Tooltip / disabled explanation.
     * @param {boolean} [options.disabled] Whether the button is disabled.
     * @param {() => void} options.onClick Click handler.
     * @returns {Element} Button element.
     */
    function buildIconButton({ icon, label, title, disabled, onClick }) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'bc-task-sb-icon-button';
        button.setAttribute('aria-label', label);
        if (title) {
            button.title = title;
        }
        button.disabled = disabled === true;
        const iconElement = document.createElement('i');
        iconElement.className = `fa-solid ${icon}`;
        iconElement.setAttribute('aria-hidden', 'true');
        button.append(iconElement);
        button.addEventListener('click', () => onClick());
        return button;
    }

    /**
     * Builds the element-name slot: a rename label, or the inline edit input
     * while the node is in rename mode. Commits on blur/Enter, cancels on Esc.
     *
     * @param {object} node Template node.
     * @returns {Element} Name slot element.
     */
    function buildNameSlot(node) {
        const slot = document.createElement('span');
        slot.className = 'bc-task-sb-name-slot';

        if (nameEditId === node.id) {
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'bc-task-sb-name-input';
            input.value = node.name;
            input.setAttribute('aria-label', `Element name (renaming ${node.name || 'unnamed element'})`);
            let finished = false;
            const finish = (commit) => {
                if (finished) {
                    return;
                }
                finished = true;
                nameEditId = null;
                if (commit) {
                    commitRename(node.id, input.value);
                } else {
                    renderCanvas();
                }
            };
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault?.();
                    finish(true);
                } else if (event.key === 'Escape') {
                    event.preventDefault?.();
                    finish(false);
                }
            });
            input.addEventListener('blur', () => finish(true));
            slot.append(input);
            captureFocus(node.id, 'name', input, true);
            return slot;
        }

        const label = document.createElement('button');
        label.type = 'button';
        label.className = 'bc-task-sb-name';
        label.textContent = node.name || '(unnamed)';
        label.setAttribute('aria-label', `Rename element ${node.name || '(unnamed)'}`);
        label.title = 'Rename element';
        label.addEventListener('click', () => {
            nameEditId = node.id;
            requestFocus(node.id, 'name');
            renderCanvas();
        });
        slot.append(label);
        return slot;
    }

    /**
     * Builds the move-button group (Up/Down/Indent/Outdent) with
     * boundary-aware disabled states. All four are disabled on the root.
     *
     * @param {object} node Template node.
     * @param {object} loc Node location from {@link locate}.
     * @returns {Element} Move group element.
     */
    function buildMoveControls(node, loc) {
        const group = document.createElement('span');
        group.className = 'bc-task-sb-move';
        group.setAttribute('role', 'group');
        group.setAttribute('aria-label', `Move ${node.name || 'element'}`);

        const isRoot = !loc.parent;
        const name = node.name || 'element';
        const controls = [
            {
                icon: 'fa-arrow-up',
                direction: 'up',
                label: `Move ${name} up`,
                enabled: !isRoot && loc.index > 0,
                disabledTitle: isRoot ? 'The root element cannot be moved.' : 'Already first in this group.',
            },
            {
                icon: 'fa-arrow-down',
                direction: 'down',
                label: `Move ${name} down`,
                enabled: !isRoot && loc.index < loc.siblings.length - 1,
                disabledTitle: isRoot ? 'The root element cannot be moved.' : 'Already last in this group.',
            },
            {
                icon: 'fa-indent',
                direction: 'indent',
                label: `Indent ${name}`,
                enabled: !isRoot && loc.index > 0,
                disabledTitle: isRoot ? 'The root element cannot be moved.' : 'Indent needs a previous sibling to move into.',
            },
            {
                icon: 'fa-outdent',
                direction: 'outdent',
                label: `Outdent ${name}`,
                enabled: !isRoot && Boolean(loc.grandparent),
                disabledTitle: isRoot ? 'The root element cannot be moved.' : 'Already at the top level.',
            },
        ];

        for (const control of controls) {
            const button = buildIconButton({
                icon: control.icon,
                label: control.label,
                title: control.enabled ? `${control.label}.` : control.disabledTitle,
                disabled: !control.enabled,
                onClick: () => moveNodeBy(node.id, control.direction),
            });
            captureFocus(node.id, `move-${control.direction}`, button, false);
            group.append(button);
        }
        return group;
    }

    /**
     * Builds the block header row: drag handle, name slot, spacer, move
     * group, duplicate and delete buttons.
     *
     * @param {object} node Template node.
     * @param {object} loc Node location from {@link locate}.
     * @param {Element} block Block element (drag style target).
     * @returns {Element} Header element.
     */
    function buildHeader(node, loc, block) {
        const header = document.createElement('div');
        header.className = 'bc-task-sb-block-header';

        const isRoot = !loc.parent;
        const name = node.name || 'unnamed element';

        const handle = document.createElement('span');
        handle.className = 'bc-task-sb-drag';
        handle.textContent = '⠿';
        // Decorative affordance: the move buttons are the accessible path
        // (DESIGN §5 — drag has a full button fallback).
        handle.setAttribute('aria-hidden', 'true');
        if (isRoot) {
            handle.classList.add('bc-task-sb-drag-disabled');
            handle.title = 'The root element cannot be moved.';
        } else {
            handle.draggable = true;
            handle.title = 'Drag to move — or use the move buttons.';
            handle.addEventListener('dragstart', (event) => onDragStart(event, node.id, block));
            handle.addEventListener('dragend', (event) => onDragEnd(event, block));
        }

        const spacer = document.createElement('span');
        spacer.className = 'bc-task-sb-spacer';
        spacer.setAttribute('aria-hidden', 'true');

        const duplicate = buildIconButton({
            icon: 'fa-clone',
            label: `Duplicate ${name}`,
            title: isRoot ? 'The root element cannot be duplicated.' : `Duplicate ${name} and its children.`,
            disabled: isRoot,
            onClick: () => duplicateNodeBy(node.id),
        });
        const remove = buildIconButton({
            icon: 'fa-xmark',
            label: `Delete ${name}`,
            title: isRoot ? 'The root element cannot be deleted.' : `Delete ${name} and its children.`,
            disabled: isRoot,
            onClick: () => deleteNodeBy(node.id),
        });

        header.append(handle, buildNameSlot(node), spacer, buildMoveControls(node, loc), duplicate, remove);
        return header;
    }

    /**
     * Builds one attribute chip: `@name` input, values input (placeholder
     * "freeform"), and a remove button.
     *
     * @param {object} node Owning template node.
     * @param {{name: string, values: string}} attribute Attribute record.
     * @param {number} index Attribute index.
     * @returns {Element} Chip element.
     */
    function buildChip(node, attribute, index) {
        const chip = document.createElement('span');
        chip.className = 'bc-task-sb-chip';

        const at = document.createElement('span');
        at.className = 'bc-task-sb-chip-at';
        at.textContent = '@';
        at.setAttribute('aria-hidden', 'true');

        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.className = 'bc-task-sb-chip-name';
        nameInput.value = attribute.name;
        nameInput.placeholder = 'name';
        nameInput.setAttribute('aria-label', `Attribute ${index + 1} name on ${node.name || 'unnamed element'}`);
        nameInput.title = 'Attribute name.';
        nameInput.addEventListener('change', () => commitAttributeField(node.id, index, 'name', nameInput.value));

        const valuesInput = document.createElement('input');
        valuesInput.type = 'text';
        valuesInput.className = 'bc-task-sb-chip-values';
        valuesInput.value = attribute.values;
        valuesInput.placeholder = 'freeform';
        valuesInput.setAttribute('aria-label', `Values for attribute ${attribute.name || index + 1} on ${node.name || 'unnamed element'}`);
        valuesInput.title = 'Pipe-separated allowed values; blank = freeform.';
        valuesInput.addEventListener('change', () => commitAttributeField(node.id, index, 'values', valuesInput.value));

        const remove = buildIconButton({
            icon: 'fa-xmark',
            label: `Remove attribute @${attribute.name || '(unnamed)'} from ${node.name || 'unnamed element'}`,
            title: 'Remove this attribute.',
            onClick: () => removeAttribute(node.id, index),
        });

        chip.append(at, nameInput, valuesInput, remove);
        captureFocus(node.id, 'attr-name', nameInput, false, index);
        return chip;
    }

    /**
     * Builds the attribute-chip row for a block (chips + "+ attr").
     *
     * @param {object} node Template node.
     * @returns {Element} Attributes row element.
     */
    function buildAttributes(node) {
        const wrap = document.createElement('div');
        wrap.className = 'bc-task-sb-attrs';
        node.attributes.forEach((attribute, index) => {
            wrap.append(buildChip(node, attribute, index));
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'bc-task-sb-add-attr';
        add.textContent = '+ attr';
        add.setAttribute('aria-label', `Add attribute to ${node.name || 'unnamed element'}`);
        add.title = 'Add an attribute (name + pipe-separated values; blank values = freeform).';
        add.addEventListener('click', () => addAttribute(node.id));
        wrap.append(add);
        return wrap;
    }

    /**
     * Builds the per-block extras: the hint input (all blocks) and the
     * max-length number input (text nodes only — blank = no limit).
     *
     * @param {object} node Template node.
     * @returns {Element} Extras element.
     */
    function buildExtras(node) {
        const extras = document.createElement('div');
        extras.className = 'bc-task-sb-extras';

        const hintLabel = document.createElement('label');
        hintLabel.className = 'bc-task-sb-field';
        const hintText = document.createElement('span');
        hintText.className = 'bc-task-sb-field-label';
        hintText.textContent = 'Hint';
        const hint = document.createElement('input');
        hint.type = 'text';
        hint.className = 'bc-task-sb-hint';
        hint.value = node.hint;
        hint.placeholder = 'guidance rendered into the prompt';
        hint.setAttribute('aria-label', `Hint for ${node.name || 'unnamed element'}`);
        hint.addEventListener('change', () => commitHint(node.id, hint.value));
        hintLabel.append(hintText, hint);
        extras.append(hintLabel);

        if (node.children.length === 0) {
            const maxLabel = document.createElement('label');
            maxLabel.className = 'bc-task-sb-field';
            const maxText = document.createElement('span');
            maxText.className = 'bc-task-sb-field-label';
            maxText.textContent = 'Max length';
            const max = document.createElement('input');
            max.type = 'number';
            max.className = 'bc-task-sb-max';
            max.min = '0';
            max.step = '1';
            max.value = node.maxLength === null ? '' : String(node.maxLength);
            max.placeholder = 'none';
            max.setAttribute('aria-label', `Maximum text length for ${node.name || 'unnamed element'} (blank for no limit)`);
            max.title = 'Character cap for this element\'s text; blank = no limit.';
            max.addEventListener('change', () => commitMaxLength(node.id, max.value));
            maxLabel.append(maxText, max);
            extras.append(maxLabel);
        }
        return extras;
    }

    /**
     * Builds the indented children container for a block: child blocks, the
     * "+ Add element" button, and the container-level drop target.
     *
     * @param {object} node Template node.
     * @param {number} depth Node depth (root = 1).
     * @returns {Element} Children container element.
     */
    function buildChildrenContainer(node, depth) {
        const container = document.createElement('div');
        container.className = 'bc-task-sb-children';
        container.setAttribute('role', 'group');
        container.setAttribute('aria-label', `Child elements of ${node.name || 'unnamed element'}`);

        for (const child of node.children) {
            container.append(buildBlock(child, depth + 1, node, container));
        }

        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'bc-task-sb-add-child';
        add.textContent = '+ Add element';
        add.setAttribute('aria-label', `Add child element to ${node.name || 'unnamed element'}`);
        add.title = 'Add a child element (you can rename it immediately).';
        add.addEventListener('click', () => addChildElement(node.id));
        container.append(add);

        container.addEventListener('dragover', (event) => onContainerDragOver(event, node.id, container));
        container.addEventListener('drop', (event) => onContainerDrop(event, node.id));
        container.addEventListener('dragleave', (event) => onContainerDragLeave(event, container));
        return container;
    }

    /**
     * Builds one block (header + body + children) for a template node.
     *
     * @param {object} node Template node.
     * @param {number} depth Node depth (root = 1).
     * @param {object|null} parentNode Parent node (null for the root).
     * @param {Element|null} containerEl Owning children container (null for the root).
     * @returns {Element} Block element.
     */
    function buildBlock(node, depth, parentNode, containerEl) {
        const loc = locate(currentStructure.template, node.id);

        const block = document.createElement('div');
        block.className = `bc-task-sb-block bc-task-sb-depth-${Math.min(depth - 1, MAX_DEPTH_CLASS)}`;
        block.setAttribute('role', 'treeitem');
        block.setAttribute('aria-level', String(depth));
        block.setAttribute('data-node-id', node.id);

        const body = document.createElement('div');
        body.className = 'bc-task-sb-block-body';
        body.append(buildAttributes(node), buildExtras(node), buildChildrenContainer(node, depth));

        block.append(buildHeader(node, loc, block), body);

        if (parentNode && containerEl) {
            block.addEventListener('dragover', (event) => onBlockDragOver(event, node, block, containerEl));
            block.addEventListener('drop', (event) => onBlockDrop(event, parentNode.id, node, block));
        }
        return block;
    }

    // -----------------------------------------------------------------------
    // Render pipeline
    // -----------------------------------------------------------------------

    /**
     * Rebuilds the block canvas from the committed template and honors any
     * pending focus request.
     *
     * @returns {void}
     */
    function renderCanvas() {
        capturedFocus = null;
        const rootNode = normalizeTemplate(currentStructure.template)[0];
        canvas.replaceChildren(buildBlock(rootNode, 1, null, null));
        flushFocus();
    }

    /**
     * Re-renders the read-only JSON skeleton preview of the committed tree.
     *
     * @returns {void}
     */
    function renderPreview() {
        previewPre.textContent = JSON.stringify(buildJsonModel(currentStructure.template), null, 2);
    }

    /**
     * Re-renders the format label in the toolbar.
     *
     * @returns {void}
     */
    function renderFormatLabel() {
        formatLabel.textContent = `Format preview: ${currentStructure.format.toUpperCase()}`;
    }

    /**
     * Full re-render of the mode-independent parts (canvas, preview, label,
     * mode controls). Never touches the textarea buffer.
     *
     * @returns {void}
     */
    function renderAll() {
        renderModeVisibility();
        updateModeButtons();
        renderResetButton();
        renderCanvas();
        renderPreview();
        renderFormatLabel();
    }

    renderAll();

    return {
        element: root,
        /**
         * Re-renders from host-pushed (server-confirmed) structure. A dirty
         * text-mode draft is never clobbered: the buffer survives and the
         * 'server updated' badge appears instead. Never fires onCommit.
         *
         * @param {{format?: string, template?: object[]}} next New structure props.
         * @returns {void}
         */
        setStructure(next) {
            const format = typeof next?.format === 'string' && next.format ? next.format : currentStructure.format;
            const template = Array.isArray(next?.template) && next.template.length > 0
                ? normalizeTemplate(next.template)
                : currentStructure.template;
            currentStructure = { format, template };
            nameEditId = null;
            focusRequest = null;
            if (mode === 'text') {
                if (textDirty) {
                    showSyncBadge();
                } else {
                    syncTextarea();
                    hideSyncBadge();
                }
            } else {
                hideSyncBadge();
            }
            renderAll();
        },
        /**
         * Returns a deep clone of the last committed structure.
         *
         * @returns {{format: string, template: object[]}} Committed `{ format, template }`.
         */
        getValue() {
            return structuredClone(currentStructure);
        },
        /**
         * Clears timers and releases the DOM. All listeners live on owned
         * elements, so there is nothing else to detach.
         *
         * @returns {void}
         */
        dispose() {
            clearTimeout(validationTimer);
            clearTimeout(resetTimer);
            validationTimer = null;
            resetTimer = null;
            dragState = null;
            focusRequest = null;
            capturedFocus = null;
            nameEditId = null;
            root.replaceChildren();
        },
    };
}
