'use strict';

/**
 * @file Transform/Summary result inspector (pages 3–5) for the 8-page Bulk
 * Combine guided task wizard. One factory serves the three per-item passes:
 * `createTransformPage({ passKey: 'transform1' | 'transform2' | 'summary', title })`.
 *
 * Layout: a toolbar on top (Run/Resume, Regenerate all, Cancel, queue
 * totals), then two columns. LEFT: a compact item status list — one row per
 * source key with avatar thumbnail, name, and status badge, behind a
 * name/status filter. Clicking a row selects it (closure state, local
 * re-render — NEVER a server PATCH) and updates the RIGHT detail inspector:
 * character avatar left of a large editable output textbox, a read-only
 * character-count validation row (`output.length` only — no token API), the
 * per-item regeneration-hint textarea (with the server-set `hintApplied`
 * badge), the item error when failed, and a Regenerate button.
 *
 * Execution semantics (mirroring `src/util/bulk-combine/task-runner.js`):
 * - Run → `actions.runPass(passKey, { completionSettings })` (default scope
 *   `missing`: every item without a succeeded result).
 * - Regenerate ONE item → `actions.runPass(passKey, { itemKeys: [key], completionSettings })`.
 * - Regenerate ALL → `actions.runPass(passKey, { scope: 'all', completionSettings })`.
 * - Resume (pass status `interrupted`) → `actions.resumePass(passKey)`.
 * - Cancel (only while running) → `actions.cancel()`.
 * All fire-and-forget (202): progress arrives over the task event stream
 * and re-renders this page; the runner checkpoints `pass.status` and
 * `task.execution`, so "running" is read from the snapshot.
 *
 * The `regenHint` is an editable per-item note; the runner does NOT inject
 * it into individual-mode prompts. `hintApplied` is derived server-side
 * (true once a single-item regeneration ran with a non-empty hint) and
 * shown as a badge.
 *
 * Continue computes the next NON-disabled page after this one from
 * `snapshot.pageStates` (first entry with a higher index whose status is
 * not 'disabled'); when none exists it falls back to Review (page 7).
 *
 * Page-module contract: `render(container, snapshot, actions) → Element`
 * (the page heading, used as the focus target). The page rebuilds via
 * `container.replaceChildren` on every render; listeners live only on the
 * replaced children. Uncommitted output/hint edits are held in a closure
 * draft map (`input` updates the draft, `change` sends a sparse PATCH, and
 * re-renders always prefer the draft) plus a focus/selection restore, so
 * state-driven re-renders never clobber an in-progress edit.
 *
 * Rendering NEVER executes: only the explicit toolbar/inspector buttons
 * fire actions. Plain DOM only (no jQuery) so the page runs under the Node
 * unit-test environment with light DOM fakes.
 */

import { getThumbnailUrl } from '../../../../script.js';
import { resolveCompletionSettings } from '../../services/resolveCompletionSettings.js';

/**
 * Pass keys this factory serves.
 *
 * @type {ReadonlyArray<string>}
 */
const PASS_KEYS = Object.freeze(['transform1', 'transform2', 'summary']);

/**
 * Valid pass-level statuses (from `newPass`/the task runner).
 *
 * @type {ReadonlyArray<string>}
 */
const PASS_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'partial', 'failed', 'interrupted']);

/**
 * Valid per-item statuses (from `newItem`/the task runner: items are
 * queued while waiting on the concurrency limit, skipped on partial
 * cancels, and interrupted when the server stops mid-item).
 *
 * @type {ReadonlyArray<string>}
 */
const ITEM_STATUSES = Object.freeze(['pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'interrupted']);

/** @type {number} Fallback Continue target (the Review page). */
const REVIEW_PAGE_INDEX = 7;

const RUN_TITLE = 'Run this pass for every card without a successful result. Fire-and-forget: progress arrives over the task event stream.';
const RESUME_TITLE = 'Resume the interrupted pass (runs every card without a successful result).';
const RUNNING_TITLE = 'This pass is already running.';
const REGEN_ALL_TITLE = 'Re-run every card, including cards with a successful result.';
const CANCEL_TITLE = 'Cancel the running pass.';
const NO_MODEL_TITLE = 'Select a connection profile or preset on the Prompt & Settings page first.';
const NO_MODEL_NOTE = 'No chat completion model is resolved for this task — select a connection profile or preset on the Prompt & Settings page.';
const STALE_NOTE = 'Inputs for this pass changed since it ran — results may be outdated. Re-run to refresh.';
const CONTINUE_RUNNING_TITLE = 'This pass is still running.';
const CONTINUE_UNSETTLED_TITLE = 'Run this pass to completion (full or partial) before continuing.';
const CONTINUE_STALE_TITLE = 'Inputs changed since this pass ran — re-run it before continuing.';
const READ_ONLY_NOTE = 'This task is completed — it is read-only. Duplicate it from Task History to keep iterating.';
const HINT_NOTE = 'A note attached to this item. Recorded as applied when a single-item regeneration runs with it.';
const HINT_APPLIED_TITLE = 'Set server-side: the last single-item regeneration ran with a non-empty hint.';
const EMPTY_LIST_NOTE = 'No source cards — add characters on the Cards page.';

/**
 * Reads a record defensively (null/array/non-object → empty object).
 *
 * @param {unknown} value Candidate.
 * @returns {object} Record (possibly empty).
 */
function recordOf(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Reads a string defensively.
 *
 * @param {unknown} value Candidate.
 * @returns {string} String (possibly empty).
 */
function stringOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Sends a sparse optimistic PATCH through the actions facade. Never throws:
 * failures are logged and reported as `false` so callers can keep the draft.
 *
 * @param {object} actions Actions facade.
 * @param {string} passKey Pass key (for log context).
 * @param {object} patch Sparse task patch.
 * @returns {Promise<boolean>} True when the patch was accepted.
 */
function applyPatch(actions, passKey, patch) {
    let result;
    try {
        result = actions?.update?.(patch);
    } catch (error) {
        console.error(`transformPage[${passKey}]: failed to update the task.`, error);
        return Promise.resolve(false);
    }
    return Promise.resolve(result).then(
        () => true,
        (error) => {
            console.error(`transformPage[${passKey}]: failed to update the task.`, error);
            return false;
        },
    );
}

/**
 * Builds a text button with a tooltip and accessible name.
 *
 * @param {object} options Button options.
 * @param {string} options.className CSS class.
 * @param {string} options.label Visible label.
 * @param {string} [options.title] Tooltip / disabled explanation.
 * @param {boolean} [options.disabled] Whether the button is disabled.
 * @param {() => void} options.onClick Click handler.
 * @returns {Element} Button element.
 */
function buildButton({ className, label, title, disabled, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (title) {
        button.title = title;
    }
    button.disabled = disabled === true;
    button.addEventListener('click', () => onClick());
    return button;
}

/**
 * Creates a Transform/Summary result-inspector page module for the
 * controller's page registry.
 *
 * @param {object} options Factory options.
 * @param {string} options.passKey Pass key (`transform1` | `transform2` | `summary`).
 * @param {string} options.title Page title (heading + rail label).
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createTransformPage({ passKey, title } = {}) {
    const pass = PASS_KEYS.includes(passKey) ? passKey : 'transform1';
    const pageTitle = stringOf(title).trim() || 'Transform';

    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /**
     * Uncommitted textarea text, keyed by `data-field-key`
     * (`output:<sourceKey>` / `hint:<sourceKey>`). Updated on `input`,
     * committed on `change`, restored across rebuilds so re-renders never
     * clobber typing.
     *
     * @type {Map<string, string>}
     */
    const drafts = new Map();
    /** @type {string|null} Selected inspector item (a source key). */
    let selectedKey = null;
    /** @type {string} Item-list filter query — survives re-renders. */
    let filterQuery = '';
    /**
     * Elements built this render, keyed by `data-field-key` — used to
     * restore focus/selection after a rebuild (the fake DOM has no
     * querySelector).
     *
     * @type {Map<string, Element>}
     */
    let fieldRefs = new Map();
    /**
     * In-flight item-field PATCH promises. Run/Resume/Regenerate await
     * them so the server records edits (especially `regenHint`) BEFORE the
     * pass starts — firing a run while a hint save is in flight would race.
     *
     * @type {Set<Promise<unknown>>}
     */
    const pendingCommits = new Set();
    /**
     * Whether the task is completed (read-only rendering): set on every
     * render from the snapshot.
     *
     * @type {boolean}
     */
    let readOnlyMode = false;

    /** @returns {object} Current task record (defensive). */
    function taskOf() {
        return recordOf(latestSnapshot?.task);
    }

    /** @returns {object[]} Source records in array order. */
    function sourcesOf() {
        return Array.isArray(taskOf().sources) ? taskOf().sources : [];
    }

    /** @returns {object} This pass's record (defensive). */
    function passOf() {
        return recordOf(recordOf(taskOf().passes)[pass]);
    }

    /**
     * Normalized pass status (unknown/absent → 'pending').
     *
     * @returns {string} Pass status.
     */
    function passStatus() {
        const status = stringOf(passOf().status);
        return PASS_STATUSES.includes(status) ? status : 'pending';
    }

    /**
     * Whether the pass is currently running: the pass record says so, or
     * the task execution record points at this pass.
     *
     * @returns {boolean} True while running.
     */
    function isRunning() {
        const execution = recordOf(taskOf().execution);
        return passStatus() === 'running' || (execution.status === 'running' && execution.pass === pass);
    }

    /**
     * Reads one item record defensively, normalized for display.
     *
     * @param {string} key Source key.
     * @returns {{status: string, output: string, error: string, regenHint: string, hintApplied: boolean}} Item record.
     */
    function itemOf(key) {
        const item = recordOf(recordOf(passOf().items)[key]);
        const status = stringOf(item.status);
        return {
            status: ITEM_STATUSES.includes(status) ? status : 'pending',
            output: stringOf(item.output),
            error: stringOf(item.error),
            regenHint: stringOf(item.regenHint),
            hintApplied: item.hintApplied === true,
        };
    }

    /**
     * Resolves the completion settings for Run/Regenerate. Pure and total;
     * the try/catch is belt-and-braces around an injected dependency.
     *
     * @returns {object} Sanitized completion settings (possibly model-less).
     */
    function resolvedCompletion() {
        try {
            return recordOf(resolveCompletionSettings(taskOf()));
        } catch (error) {
            console.error(`transformPage[${pass}]: failed to resolve completion settings.`, error);
            return {};
        }
    }

    /** @returns {boolean} Whether a model resolved (Run preflight). */
    function hasModel() {
        return stringOf(resolvedCompletion().model).trim().length > 0;
    }

    /** @returns {string[]} Source keys in array order. */
    function sourceKeys() {
        return sourcesOf().map((source) => stringOf(source?.key));
    }

    /**
     * Effective selection: the closure-selected key when it still names a
     * source, else the first source key (null when there are no sources).
     *
     * @returns {string|null} Selected source key.
     */
    function effectiveSelectedKey() {
        const keys = sourceKeys();
        if (selectedKey !== null && keys.includes(selectedKey)) {
            return selectedKey;
        }
        return keys[0] ?? null;
    }

    /**
     * Queue totals: succeeded items over total sources.
     *
     * @returns {{succeeded: number, total: number}} Totals.
     */
    function queueTotals() {
        const keys = sourceKeys();
        const succeeded = keys.filter((key) => itemOf(key).status === 'succeeded').length;
        return { succeeded, total: keys.length };
    }

    /**
     * Finds the source record backing a key.
     *
     * @param {string} key Source key.
     * @returns {object|null} Source record, or null.
     */
    function sourceFor(key) {
        return sourcesOf().find((source) => stringOf(source?.key) === key) ?? null;
    }

    /**
     * Computes the Continue target: the first page AFTER this one (by
     * `pageStates` index) whose status is not 'disabled'; falls back to
     * Review (page 7) when every later page is disabled or `pageStates` is
     * missing/unusable.
     *
     * @returns {{index: number, title: string}} Continue target.
     */
    function continueTarget() {
        const states = Array.isArray(latestSnapshot?.pageStates) ? latestSnapshot.pageStates : [];
        const currentIndex = states.find((state) => state?.key === pass)?.index ?? null;
        const next = currentIndex === null
            ? null
            : states.find((state) => Number.isSafeInteger(state?.index)
                && state.index > currentIndex
                && state?.status !== 'disabled') ?? null;
        if (next) {
            return { index: next.index, title: stringOf(next.title).trim() || 'the next page' };
        }
        return { index: REVIEW_PAGE_INDEX, title: 'Review' };
    }

    // ------------------------------------------------------------------
    // Fire-and-forget execution entry points (button clicks only)
    // ------------------------------------------------------------------

    /**
     * Fires a pass run. Pending output/hint commits are awaited FIRST so the
     * server records the edits before the run starts (a regeneration must
     * not race the hint save). Progress arrives over the task event stream
     * and re-renders this page; completion settings are resolved at click
     * time.
     *
     * @param {object} [options] Run options (`scope` / `itemKeys`).
     * @returns {Promise<void>}
     */
    async function fireRunPass(options = {}) {
        await Promise.all([...pendingCommits]).catch(() => {});
        let result;
        try {
            result = latestActions?.runPass?.(pass, { ...options, completionSettings: resolvedCompletion() });
        } catch (error) {
            console.error(`transformPage[${pass}]: failed to start the pass.`, error);
            return;
        }
        Promise.resolve(result).catch((error) => {
            console.error(`transformPage[${pass}]: pass run request failed.`, error);
        });
    }

    /**
     * Fires a pass resume (interrupted pass), awaiting pending commits
     * first (see {@link fireRunPass}).
     *
     * @returns {Promise<void>}
     */
    async function fireResume() {
        await Promise.all([...pendingCommits]).catch(() => {});
        let result;
        try {
            result = latestActions?.resumePass?.(pass);
        } catch (error) {
            console.error(`transformPage[${pass}]: failed to resume the pass.`, error);
            return;
        }
        Promise.resolve(result).catch((error) => {
            console.error(`transformPage[${pass}]: pass resume request failed.`, error);
        });
    }

    /**
     * Fires a task cancel.
     *
     * @returns {void}
     */
    function fireCancel() {
        let result;
        try {
            result = latestActions?.cancel?.();
        } catch (error) {
            console.error(`transformPage[${pass}]: failed to cancel the task.`, error);
            return;
        }
        Promise.resolve(result).catch((error) => {
            console.error(`transformPage[${pass}]: cancel request failed.`, error);
        });
    }

    // ------------------------------------------------------------------
    // Field builders
    // ------------------------------------------------------------------

    /**
     * Builds a draft-protected textarea: `input` updates the draft map,
     * `change` commits via the provided callback. The value is restored
     * from the draft across rebuilds.
     *
     * @param {object} options Textarea options.
     * @param {string} options.fieldKey Stable `data-field-key` for draft/focus tracking.
     * @param {string} options.value Snapshot value (used when no draft exists).
     * @param {number} options.rows Visible row count.
     * @param {string} options.ariaLabel Accessible name.
     * @param {string} options.className CSS class.
     * @param {(text: string) => void} options.onCommit Commit callback on `change`.
     * @param {() => void} [options.onInput] Extra `input` hook (e.g. live char count).
     * @returns {Element} Textarea element.
     */
    function buildTextarea({ fieldKey, value, rows, ariaLabel, className, onCommit, onInput }) {
        const textarea = document.createElement('textarea');
        textarea.className = className;
        textarea.rows = rows;
        textarea.setAttribute('data-field-key', fieldKey);
        textarea.setAttribute('aria-label', ariaLabel);
        textarea.readOnly = readOnlyMode === true;
        textarea.value = drafts.has(fieldKey) ? drafts.get(fieldKey) : value;
        textarea.addEventListener('input', () => {
            drafts.set(fieldKey, String(textarea.value ?? ''));
            onInput?.();
        });
        textarea.addEventListener('change', () => {
            const text = String(textarea.value ?? '');
            drafts.set(fieldKey, text);
            onCommit(text);
        });
        fieldRefs.set(fieldKey, textarea);
        return textarea;
    }

    /**
     * Commits one item field (`output` / `regenHint`) as a sparse PATCH.
     * The draft is kept until the patch resolves so a failed update never
     * loses typing; it is cleared on success when unchanged since.
     *
     * @param {string} key Source key.
     * @param {string} field Item field name.
     * @param {string} fieldKey Draft-map key.
     * @param {string} text Committed text.
     * @returns {void}
     */
    function commitItemField(key, field, fieldKey, text) {
        const commit = applyPatch(latestActions, pass, { passes: { [pass]: { items: { [key]: { [field]: text } } } } }).then((ok) => {
            if (ok && drafts.get(fieldKey) === text) {
                drafts.delete(fieldKey);
            }
        }).finally(() => {
            pendingCommits.delete(commit);
        });
        // Tracked: Run/Regenerate await outstanding commits so the server
        // records the edit before the pass starts.
        pendingCommits.add(commit);
    }

    /**
     * Builds a status badge pill (`.bc-task-status` family).
     *
     * @param {string} status Item status.
     * @returns {Element} Badge element.
     */
    function buildStatusBadge(status) {
        const badge = document.createElement('span');
        badge.className = `bc-task-status bc-task-status--${status}`;
        badge.textContent = status;
        return badge;
    }

    // ------------------------------------------------------------------
    // Toolbar
    // ------------------------------------------------------------------

    /**
     * Builds the top toolbar: Run (or Resume when the pass is interrupted),
     * Regenerate all, Cancel (only while running), queue totals, and a
     * running indicator. Run/Regenerate are disabled while running or when
     * no chat completion model is resolved.
     *
     * @returns {Element} Toolbar element.
     */
    function buildToolbar() {
        const running = isRunning();
        const model = hasModel();
        const interrupted = passStatus() === 'interrupted';
        const runLocked = running || !model || readOnlyMode;
        const runTitle = readOnlyMode ? READ_ONLY_NOTE : (!model ? NO_MODEL_TITLE : (running ? RUNNING_TITLE : (interrupted ? RESUME_TITLE : RUN_TITLE)));
        const { succeeded, total } = queueTotals();

        const bar = document.createElement('div');
        bar.className = 'bc-task-transform-toolbar';

        bar.append(buildButton({
            className: 'bc-task-transform-run',
            label: interrupted ? 'Resume' : 'Run',
            title: runTitle,
            disabled: runLocked,
            onClick: () => {
                if (interrupted) {
                    void fireResume();
                } else {
                    void fireRunPass();
                }
            },
        }));

        bar.append(buildButton({
            className: 'bc-task-transform-regen-all',
            label: 'Regenerate all',
            title: readOnlyMode ? READ_ONLY_NOTE : (!model ? NO_MODEL_TITLE : (running ? RUNNING_TITLE : REGEN_ALL_TITLE)),
            disabled: runLocked,
            onClick: () => void fireRunPass({ scope: 'all' }),
        }));

        bar.append(buildButton({
            className: 'bc-task-transform-cancel',
            label: 'Cancel',
            title: running ? CANCEL_TITLE : 'Nothing is running.',
            disabled: !running || readOnlyMode,
            onClick: fireCancel,
        }));

        const totals = document.createElement('span');
        totals.className = 'bc-task-transform-totals';
        totals.textContent = `${succeeded}/${total} succeeded`;
        bar.append(totals);

        if (running) {
            const indicator = document.createElement('span');
            indicator.className = 'bc-task-transform-running';
            indicator.setAttribute('role', 'status');
            const spinner = document.createElement('i');
            spinner.className = 'fa-solid fa-spinner fa-spin';
            spinner.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = 'Running…';
            indicator.append(spinner, label);
            bar.append(indicator);
        }

        return bar;
    }

    // ------------------------------------------------------------------
    // Item list (left column)
    // ------------------------------------------------------------------

    /**
     * Builds one item row (select button: avatar + name + status badge).
     *
     * @param {object} source Source record.
     * @returns {Element} Row button.
     */
    function buildItemRow(source) {
        const key = stringOf(source?.key);
        const name = stringOf(source?.name).trim() || 'Unnamed character';
        const item = itemOf(key);
        const selected = key === effectiveSelectedKey();

        const row = document.createElement('button');
        row.type = 'button';
        row.className = `bc-task-transform-item${selected ? ' selected' : ''}`;
        row.setAttribute('aria-pressed', String(selected));
        row.setAttribute('data-source-key', key);
        row.setAttribute('data-field-key', `item:${key}`);
        row.title = `Inspect ${name}`;

        const avatar = document.createElement('img');
        avatar.className = 'bc-task-transform-item-avatar';
        avatar.src = getThumbnailUrl('avatar', stringOf(source?.avatar));
        avatar.alt = '';

        const nameElement = document.createElement('span');
        nameElement.className = 'bc-task-transform-item-name';
        nameElement.textContent = name;
        nameElement.title = name;

        row.append(avatar, nameElement, buildStatusBadge(item.status));

        row.addEventListener('click', () => {
            if (selectedKey === key) {
                return;
            }
            selectedKey = key;
            renderPage();
        });
        fieldRefs.set(`item:${key}`, row);
        return row;
    }

    /**
     * Rebuilds just the item rows (used by the filter input so typing does
     * not re-render the whole page or lose focus).
     *
     * @param {Element} listElement Item list container.
     * @returns {void}
     */
    function renderItemRows(listElement) {
        const sources = sourcesOf();
        const query = filterQuery.trim().toLowerCase();
        const rows = sources
            .filter((source) => {
                if (!query) {
                    return true;
                }
                const name = stringOf(source?.name).trim() || 'Unnamed character';
                const status = itemOf(stringOf(source?.key)).status;
                return name.toLowerCase().includes(query) || status.includes(query);
            })
            .map((source) => buildItemRow(source));

        const notes = [];
        if (rows.length === 0) {
            const note = document.createElement('p');
            note.className = 'bc-task-transform-list-empty';
            note.textContent = sources.length === 0
                ? EMPTY_LIST_NOTE
                : 'No items match the filter.';
            notes.push(note);
        }

        listElement.replaceChildren(...rows, ...notes);
    }

    /**
     * Builds the left column: filter input + item status list.
     *
     * @returns {Element} List column section.
     */
    function buildListColumn() {
        const column = document.createElement('section');
        column.className = 'bc-task-transform-list-col';
        column.setAttribute('aria-label', 'Items');

        const filter = document.createElement('input');
        filter.type = 'search';
        filter.className = 'bc-task-transform-filter';
        filter.placeholder = 'Filter by name or status…';
        filter.setAttribute('aria-label', 'Filter items by name or status');
        filter.value = filterQuery;

        const list = document.createElement('div');
        list.className = 'bc-task-transform-item-list';

        filter.addEventListener('input', () => {
            filterQuery = String(filter.value ?? '');
            renderItemRows(list);
        });

        renderItemRows(list);

        column.append(filter, list);
        return column;
    }

    // ------------------------------------------------------------------
    // Inspector (right column)
    // ------------------------------------------------------------------

    /**
     * Builds the detail inspector for the selected item: name + status
     * badge header, avatar left of the large editable output textbox, a
     * read-only character-count row, the regeneration-hint textarea (with
     * the server-set applied badge), the item error when failed, and the
     * Regenerate button.
     *
     * @returns {Element} Inspector section.
     */
    function buildInspector() {
        const section = document.createElement('section');
        section.className = 'bc-task-transform-inspector';
        section.setAttribute('aria-label', 'Result inspector');

        const key = effectiveSelectedKey();
        if (key === null) {
            const empty = document.createElement('p');
            empty.className = 'bc-task-transform-inspector-empty';
            empty.textContent = 'Select an item on the left to inspect its result.';
            section.append(empty);
            return section;
        }

        const source = sourceFor(key);
        const name = stringOf(source?.name).trim() || 'Unnamed character';
        const item = itemOf(key);
        const running = isRunning();
        const model = hasModel();

        // Header: name + status badge.
        const header = document.createElement('div');
        header.className = 'bc-task-transform-inspector-header';
        const nameElement = document.createElement('h3');
        nameElement.className = 'bc-task-transform-inspector-name';
        nameElement.textContent = name;
        nameElement.title = name;
        header.append(nameElement, buildStatusBadge(item.status));
        section.append(header);

        // Main row: avatar left of the output textbox column.
        const main = document.createElement('div');
        main.className = 'bc-task-transform-inspector-main';

        const avatar = document.createElement('img');
        avatar.className = 'bc-task-transform-inspector-avatar';
        avatar.src = getThumbnailUrl('avatar', stringOf(source?.avatar));
        avatar.alt = name;
        avatar.title = name;

        const outputColumn = document.createElement('div');
        outputColumn.className = 'bc-task-transform-output-col';

        const outputFieldKey = `output:${key}`;
        const outputCount = document.createElement('p');
        outputCount.className = 'bc-task-transform-output-count';
        const effectiveOutput = drafts.has(outputFieldKey) ? drafts.get(outputFieldKey) : item.output;
        outputCount.textContent = `${effectiveOutput.length} character${effectiveOutput.length === 1 ? '' : 's'}`;

        const outputArea = buildTextarea({
            fieldKey: outputFieldKey,
            value: item.output,
            rows: 12,
            ariaLabel: `${name} output`,
            className: 'bc-task-transform-output',
            onCommit: (text) => commitItemField(key, 'output', outputFieldKey, text),
            onInput: () => {
                const length = String(outputArea.value ?? '').length;
                outputCount.textContent = `${length} character${length === 1 ? '' : 's'}`;
            },
        });

        outputColumn.append(outputArea, outputCount);
        main.append(avatar, outputColumn);
        section.append(main);

        // Regeneration hint (separate block; the applied badge is server-set).
        const hintBlock = document.createElement('div');
        hintBlock.className = 'bc-task-transform-hint-block';

        const hintHeader = document.createElement('div');
        hintHeader.className = 'bc-task-transform-hint-header';
        const hintLabel = document.createElement('span');
        hintLabel.className = 'bc-task-transform-label';
        hintLabel.textContent = 'Regeneration hint';
        hintLabel.title = HINT_NOTE;
        hintHeader.append(hintLabel);
        if (item.hintApplied) {
            const applied = document.createElement('span');
            applied.className = 'bc-task-transform-hint-applied';
            applied.textContent = 'Hint applied';
            applied.title = HINT_APPLIED_TITLE;
            hintHeader.append(applied);
        }

        const hintFieldKey = `hint:${key}`;
        const hintArea = buildTextarea({
            fieldKey: hintFieldKey,
            value: item.regenHint,
            rows: 3,
            ariaLabel: `${name} regeneration hint`,
            className: 'bc-task-transform-hint',
            onCommit: (text) => commitItemField(key, 'regenHint', hintFieldKey, text),
        });

        hintBlock.append(hintHeader, hintArea);
        section.append(hintBlock);

        // Item error (failed items only).
        if (item.status === 'failed' && item.error) {
            const error = document.createElement('p');
            error.className = 'bc-task-transform-error';
            error.setAttribute('role', 'alert');
            error.textContent = item.error;
            section.append(error);
        }

        // Inspector actions.
        const actions = document.createElement('div');
        actions.className = 'bc-task-transform-inspector-actions';
        actions.append(buildButton({
            className: 'bc-task-transform-regen',
            label: 'Regenerate',
            title: readOnlyMode ? READ_ONLY_NOTE : (!model ? NO_MODEL_TITLE : (running ? RUNNING_TITLE : `Re-run only ${name} with the current settings.`)),
            disabled: running || !model || readOnlyMode,
            onClick: () => void fireRunPass({ itemKeys: [key] }),
        }));
        section.append(actions);

        return section;
    }

    // ------------------------------------------------------------------
    // Footer
    // ------------------------------------------------------------------

    /**
     * Builds the footer with the Continue button (next non-disabled page,
     * Review fallback). Continue requires a SETTLED, NON-STALE pass:
     * pending/failed/interrupted/running passes — and stale results — must
     * be (re-)run first, so downstream pages never consume invalid output.
     *
     * @returns {Element} Footer element.
     */
    function buildFooter() {
        const target = continueTarget();
        const settled = ['succeeded', 'partial'].includes(passStatus());
        const staleness = recordOf(latestSnapshot?.derivedStaleness ?? taskOf().derivedStaleness);
        const stale = recordOf(staleness[pass]).stale === true;
        const running = isRunning();
        const canContinue = settled && !stale && !running;
        const title = running
            ? CONTINUE_RUNNING_TITLE
            : (!settled ? CONTINUE_UNSETTLED_TITLE : (stale ? CONTINUE_STALE_TITLE : `Go to ${target.title}.`));

        const footer = document.createElement('footer');
        footer.className = 'bc-task-transform-footer';
        footer.append(buildButton({
            className: 'bc-task-continue',
            label: `Continue to ${target.title}`,
            title,
            disabled: !canContinue,
            onClick: () => {
                if (canContinue) {
                    latestActions?.goToPage?.(target.index);
                }
            },
        }));
        return footer;
    }

    // ------------------------------------------------------------------
    // Render
    // ------------------------------------------------------------------

    /**
     * Rebuilds the whole page from the latest snapshot into the host.
     * Captures the focused field (by `data-field-key`) plus selection before
     * the rebuild and restores them afterwards, so state-driven re-renders
     * never clobber typing.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        readOnlyMode = taskOf().status === 'completed';

        // Selection persistence: fall back to the first available key when
        // the selected source disappeared (e.g. removed on the Cards page).
        selectedKey = effectiveSelectedKey();

        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        const activeKey = activeElement?.getAttribute?.('data-field-key') ?? null;
        const selectionStart = typeof activeElement?.selectionStart === 'number' ? activeElement.selectionStart : null;
        const selectionEnd = typeof activeElement?.selectionEnd === 'number' ? activeElement.selectionEnd : null;
        fieldRefs = new Map();

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-transform';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = pageTitle;

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'Select a card on the left to inspect, edit, or regenerate its result. Editing an output or hint saves on commit; running the queue never overwrites your uncommitted text.';

        root.append(heading, guidance, buildToolbar());

        if (readOnlyMode) {
            const readOnly = document.createElement('p');
            readOnly.className = 'bc-task-readonly-note';
            readOnly.setAttribute('role', 'status');
            readOnly.textContent = READ_ONLY_NOTE;
            root.append(readOnly);
        }

        if (!hasModel()) {
            const warning = document.createElement('p');
            warning.className = 'bc-task-transform-warning';
            warning.setAttribute('role', 'alert');
            warning.textContent = NO_MODEL_NOTE;
            root.append(warning);
        }

        const staleness = recordOf(latestSnapshot?.derivedStaleness ?? taskOf().derivedStaleness);
        const staleEntry = recordOf(staleness[pass]);
        if (staleEntry.stale === true) {
            const stale = document.createElement('p');
            stale.className = 'bc-task-transform-stale';
            stale.textContent = STALE_NOTE;
            const reasons = Array.isArray(staleEntry.reasons) ? staleEntry.reasons.filter((reason) => typeof reason === 'string' && reason) : [];
            if (reasons.length > 0) {
                stale.title = reasons.join('\n');
            }
            root.append(stale);
        }

        const layout = document.createElement('div');
        layout.className = 'bc-task-transform-layout';
        layout.append(buildListColumn(), buildInspector());
        root.append(layout, buildFooter());

        host.replaceChildren(root);

        if (activeKey && fieldRefs.has(activeKey)) {
            const element = fieldRefs.get(activeKey);
            element.focus?.();
            if (selectionStart !== null && typeof element.setSelectionRange === 'function') {
                try {
                    element.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
                } catch {
                    // Not a text-entry element in a real browser — focus is enough.
                }
            }
        }
        return heading;
    }

    return {
        key: pass,
        title: pageTitle,
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call; uncommitted drafts win over the
         * server values so re-renders never clobber an in-progress edit.
         *
         * @param {Element} container Canvas container.
         * @param {object} snapshot `TaskWizardState#getSnapshot()` payload.
         * @param {object} actions Controller actions facade.
         * @returns {Element|null} The page heading (focus target).
         */
        render(container, snapshot, actions) {
            if (container) {
                host = container;
            }
            latestSnapshot = snapshot ?? latestSnapshot;
            latestActions = actions ?? latestActions;
            if (!host) {
                return null;
            }
            return renderPage();
        },
        /**
         * Releases stored references and ephemeral UI state. No listeners
         * were added to external targets, so there is nothing else to detach.
         *
         * @returns {void}
         */
        dispose() {
            host = null;
            latestSnapshot = null;
            latestActions = null;
            drafts.clear();
            selectedKey = null;
            filterQuery = '';
            fieldRefs = new Map();
            pendingCommits.clear();
            readOnlyMode = false;
        },
    };
}
