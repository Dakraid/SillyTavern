'use strict';

/**
 * @file Task History panel for the 8-page Bulk Combine guided task wizard.
 *
 * Management surface for durable combine tasks (SPEC: duplicate / archive /
 * delete history; inactive unarchived tasks are auto-deleted server-side
 * after 7 days, archived tasks are exempt). The panel lists the task
 * summaries from `client.listTasks()` and wires row actions to the
 * TaskClient methods: Open (delegated to the `onOpenTask` callback),
 * Duplicate, Archive/Unarchive (toggled by the archived flag), and Delete
 * behind an inline in-row confirm (never `window.confirm`). A "New task"
 * button delegates creation to the `onNewTask` callback. Both callbacks
 * are wired by the orchestrator (closing/reopening the wizard popup).
 *
 * Rendering contract: plain DOM only (no jQuery, no `querySelector`, no
 * `createTextNode`) so the panel runs under the Node unit-test environment
 * with light DOM fakes. Every render rebuilds via
 * `container.replaceChildren(...)`; listeners live only on the replaced
 * children; all mutable state is closure-held. The first render starts one
 * `listTasks()` fetch (deduplicated while in flight) and every successful
 * mutation re-fetches the list. Failures surface inline (`role="alert"`)
 * with a manual Retry — the panel never throws. The 7-day expiry is
 * enforced by the server; the panel only displays tasks and never prunes
 * client-side.
 *
 * Styling lives in `components/TaskHistoryPanel.css` (`.bc-task-history-*`,
 * SmartTheme variables only); the orchestrator adds the `@import` line to
 * `public/style.css` when wiring the header button.
 */

/**
 * Human-readable labels for the task/execution status hint. Unknown values
 * fall back to a capitalized raw status.
 *
 * @type {Readonly<Object<string, string>>}
 */
const STATUS_LABELS = Object.freeze({
    draft: 'Draft',
    pending: 'Pending',
    queued: 'Queued',
    running: 'Running',
    interrupted: 'Interrupted',
    succeeded: 'Succeeded',
    failed: 'Failed',
    skipped: 'Skipped',
    idle: 'Idle',
});

const NEW_TASK_TITLE = 'Start a fresh combine task.';
const OPEN_TITLE = 'Open this task in the wizard.';
const DUPLICATE_TITLE = 'Create a copy of this task.';
const ARCHIVE_TITLE = 'Archive this task. Archived tasks are kept beyond the 7-day cleanup.';
const UNARCHIVE_TITLE = 'Return this task to the active list.';
const DELETE_TITLE = 'Delete this task permanently.';
const CONFIRM_DELETE_TITLE = 'Permanently delete this task.';
const CONFIRM_CANCEL_TITLE = 'Keep this task.';
const RETRY_TITLE = 'Try loading the task list again.';
const RETENTION_NOTE = 'Inactive tasks are removed after 7 days. Archived tasks are kept.';
const EMPTY_NOTE = 'Archived tasks are kept indefinitely; other tasks are removed after 7 days of inactivity.';

/**
 * Extracts a displayable message from an unknown thrown value.
 *
 * @param {unknown} error Thrown value.
 * @returns {string} Human-readable message.
 */
function messageOf(error) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return message || 'Something went wrong. Please try again.';
}

/**
 * Normalizes a raw `listTasks()` summary into the shape the panel renders.
 * Tolerates partial/malformed entries so one bad record never breaks the
 * whole list. The archived flag accepts both the summary's `archivedAt`
 * timestamp (what the server returns) and a boolean `archived` field.
 *
 * @param {object} raw Raw summary entry.
 * @returns {{id: string, name: string, status: string, executionStatus: string, archived: boolean, updatedAt: string}} Normalized summary.
 */
function normalizeSummary(raw) {
    const summary = raw !== null && typeof raw === 'object' ? raw : {};
    return {
        id: String(summary.id ?? ''),
        name: typeof summary.name === 'string' && summary.name.trim() ? summary.name : 'Untitled task',
        status: typeof summary.status === 'string' ? summary.status : '',
        executionStatus: typeof summary.execution?.status === 'string' ? summary.execution.status : '',
        archived: summary.archived === true || (typeof summary.archivedAt === 'string' && summary.archivedAt.length > 0),
        updatedAt: typeof summary.updatedAt === 'string' ? summary.updatedAt : '',
    };
}

/**
 * Resolves the status hint for a summary. A non-idle execution status (from
 * a full task record) wins; otherwise the task-level status is used — that
 * is the only status the `listTasks()` summary endpoint provides.
 *
 * @param {object} summary Normalized summary.
 * @returns {{key: string, label: string}} Status key + display label.
 */
function statusOf(summary) {
    const raw = summary.executionStatus && summary.executionStatus !== 'idle'
        ? summary.executionStatus
        : summary.status;
    if (!raw) {
        return { key: 'unknown', label: 'Unknown' };
    }
    return { key: raw, label: STATUS_LABELS[raw] ?? raw.charAt(0).toUpperCase() + raw.slice(1) };
}

/**
 * Formats an ISO timestamp for the last-updated line.
 *
 * @param {string} iso ISO timestamp (may be empty/garbage).
 * @returns {string} Localized date/time, or 'unknown'.
 */
function formatTimestamp(iso) {
    const time = typeof iso === 'string' ? Date.parse(iso) : NaN;
    return Number.isNaN(time) ? 'unknown' : new Date(time).toLocaleString();
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
 * Creates the Task History panel component.
 *
 * @param {object} options Options.
 * @param {object} options.client TaskClient instance (`listTasks`, `duplicateTask`, `archiveTask`, `unarchiveTask`, `deleteTask`).
 * @param {(id: string) => void} [options.onOpenTask] Opens a task in the wizard (orchestrator wires popup close/reopen).
 * @param {() => void} [options.onNewTask] Starts a fresh task (orchestrator wires create+open).
 * @param {string|number|null} [options.currentTaskId] Task currently open in the wizard; marked with a badge and given no Open button.
 * @returns {{render: (container: Element) => Element|null, refresh: () => Promise<void>, dispose: () => void}} Panel instance.
 */
export function createTaskHistoryPanel({ client, onOpenTask, onNewTask, currentTaskId } = {}) {
    /** @type {Element|null} Host container; null after dispose. */
    let host = null;
    /** @type {boolean} Whether the initial fetch has been kicked off. */
    let started = false;
    /** @type {boolean} Whether a fetch is in flight. */
    let loading = false;
    /** @type {boolean} Whether a list has ever loaded successfully. */
    let loaded = false;
    /** @type {string} Last failure message ('' when healthy). */
    let error = '';
    /** @type {Array<object>} Normalized task summaries. */
    let tasks = [];
    /** @type {Promise<void>|null} In-flight fetch (dedupe guard). */
    let inFlight = null;
    /** @type {Set<string>} Task ids with a mutation in flight (double-click guard). */
    const pendingIds = new Set();
    /** @type {string|null} Task id showing the inline delete confirm. */
    let confirmDeleteId = null;

    /**
     * Whether a summary is the task currently open in the wizard.
     *
     * @param {object} summary Normalized summary.
     * @returns {boolean} True when it matches `currentTaskId`.
     */
    function isCurrent(summary) {
        return currentTaskId !== null && currentTaskId !== undefined && String(currentTaskId) === summary.id;
    }

    /**
     * Rebuilds the panel DOM from closure state. No-op after dispose.
     *
     * @returns {void}
     */
    function paint() {
        if (!host) {
            return;
        }
        host.replaceChildren(buildRoot());
    }

    /**
     * Performs the deduplicated list fetch and applies the result.
     *
     * @returns {Promise<void>} Settles when the fetch has been applied.
     */
    async function doFetch() {
        try {
            if (!client || typeof client.listTasks !== 'function') {
                throw new Error('Task client is unavailable.');
            }
            const list = await client.listTasks();
            tasks = (Array.isArray(list) ? list : []).map(normalizeSummary);
            loaded = true;
            error = '';
        } catch (fetchError) {
            error = messageOf(fetchError);
        } finally {
            loading = false;
            inFlight = null;
            paint();
        }
    }

    /**
     * (Re-)fetches the task list. Concurrent calls share the in-flight
     * fetch, so double retries and action-triggered refreshes never stack
     * requests.
     *
     * @returns {Promise<void>} Settles when the fetch has been applied.
     */
    function refresh() {
        if (inFlight) {
            return inFlight;
        }
        loading = true;
        paint();
        inFlight = doFetch();
        return inFlight;
    }

    /**
     * Runs a row mutation (duplicate/archive/unarchive/delete), then
     * refreshes the list. Failures surface as an inline alert while the
     * last known list stays visible. Guards against double-clicks per task.
     *
     * @param {string} taskId Task id.
     * @param {() => Promise<unknown>} perform Client mutation.
     * @returns {Promise<void>} Settles when the action + refresh finished.
     */
    async function runTaskAction(taskId, perform) {
        if (pendingIds.has(taskId)) {
            return;
        }
        pendingIds.add(taskId);
        error = '';
        paint();
        try {
            await perform();
            await refresh();
        } catch (actionError) {
            error = messageOf(actionError);
        } finally {
            pendingIds.delete(taskId);
            paint();
        }
    }

    /**
     * Delegates Open to the orchestrator callback. Callback failures are
     * logged, never thrown back into the panel.
     *
     * @param {string} taskId Task id.
     * @returns {void}
     */
    function openTask(taskId) {
        try {
            onOpenTask?.(taskId);
        } catch (callbackError) {
            console.error('TaskHistoryPanel: onOpenTask callback failed.', callbackError);
        }
    }

    /**
     * Delegates New task to the orchestrator callback.
     *
     * @returns {void}
     */
    function startNewTask() {
        try {
            onNewTask?.();
        } catch (callbackError) {
            console.error('TaskHistoryPanel: onNewTask callback failed.', callbackError);
        }
    }

    /**
     * Builds the row action cluster (Open/Duplicate/Archive/Delete).
     *
     * @param {object} summary Normalized summary.
     * @returns {Element} Actions container.
     */
    function buildActions(summary) {
        const actions = document.createElement('div');
        actions.className = 'bc-task-history-actions';
        const pending = pendingIds.has(summary.id);

        if (!isCurrent(summary)) {
            actions.append(buildButton({
                className: 'bc-task-history-action bc-task-history-open',
                label: 'Open',
                title: OPEN_TITLE,
                disabled: pending,
                onClick: () => openTask(summary.id),
            }));
        }
        actions.append(buildButton({
            className: 'bc-task-history-action bc-task-history-duplicate',
            label: 'Duplicate',
            title: DUPLICATE_TITLE,
            disabled: pending,
            onClick: () => void runTaskAction(summary.id, () => client.duplicateTask(summary.id)),
        }));
        actions.append(buildButton({
            className: 'bc-task-history-action bc-task-history-archive',
            label: summary.archived ? 'Unarchive' : 'Archive',
            title: summary.archived ? UNARCHIVE_TITLE : ARCHIVE_TITLE,
            disabled: pending,
            onClick: () => void runTaskAction(
                summary.id,
                () => summary.archived ? client.unarchiveTask(summary.id) : client.archiveTask(summary.id),
            ),
        }));
        actions.append(buildButton({
            className: 'bc-task-history-action bc-task-history-delete',
            label: 'Delete',
            title: DELETE_TITLE,
            disabled: pending,
            onClick: () => {
                confirmDeleteId = summary.id;
                paint();
            },
        }));
        return actions;
    }

    /**
     * Builds the inline delete confirm cluster that replaces the row
     * actions while a delete is pending confirmation.
     *
     * @param {object} summary Normalized summary.
     * @returns {Element} Confirm container.
     */
    function buildConfirm(summary) {
        const confirm = document.createElement('div');
        confirm.className = 'bc-task-history-confirm';

        const text = document.createElement('span');
        text.className = 'bc-task-history-confirm-text';
        text.textContent = 'Delete this task? This cannot be undone.';

        confirm.append(text, buildButton({
            className: 'bc-task-history-action bc-task-history-confirm-delete',
            label: 'Delete',
            title: CONFIRM_DELETE_TITLE,
            onClick: () => {
                confirmDeleteId = null;
                void runTaskAction(summary.id, () => client.deleteTask(summary.id));
            },
        }), buildButton({
            className: 'bc-task-history-action bc-task-history-confirm-cancel',
            label: 'Cancel',
            title: CONFIRM_CANCEL_TITLE,
            onClick: () => {
                confirmDeleteId = null;
                paint();
            },
        }));
        return confirm;
    }

    /**
     * Builds one task row: name (+ Current/Archived badges), status hint,
     * last-updated, and the action/confirm cluster.
     *
     * @param {object} summary Normalized summary.
     * @returns {Element} Row element.
     */
    function buildRow(summary) {
        const status = statusOf(summary);

        const row = document.createElement('li');
        row.className = 'bc-task-history-row';
        row.setAttribute('data-task-id', summary.id);
        row.setAttribute('data-status', status.key);

        const main = document.createElement('div');
        main.className = 'bc-task-history-row-main';

        const nameLine = document.createElement('div');
        nameLine.className = 'bc-task-history-name-line';
        const name = document.createElement('span');
        name.className = 'bc-task-history-name';
        name.textContent = summary.name;
        nameLine.append(name);
        if (isCurrent(summary)) {
            const current = document.createElement('span');
            current.className = 'bc-task-history-current';
            current.textContent = 'Current';
            nameLine.append(current);
        }
        if (summary.archived) {
            const archived = document.createElement('span');
            archived.className = 'bc-task-history-archived';
            archived.textContent = 'Archived';
            nameLine.append(archived);
        }

        const meta = document.createElement('div');
        meta.className = 'bc-task-history-meta';
        const pill = document.createElement('span');
        pill.className = 'bc-task-history-pill';
        pill.setAttribute('data-status', status.key);
        pill.textContent = status.label;
        const updated = document.createElement('time');
        updated.className = 'bc-task-history-updated';
        if (summary.updatedAt) {
            updated.setAttribute('datetime', summary.updatedAt);
        }
        updated.textContent = `Updated ${formatTimestamp(summary.updatedAt)}`;
        meta.append(pill, updated);

        main.append(nameLine, meta);
        row.append(main, confirmDeleteId === summary.id ? buildConfirm(summary) : buildActions(summary));
        return row;
    }

    /**
     * Builds the first-load error view with a manual Retry.
     *
     * @returns {Element} Error view element.
     */
    function buildErrorView() {
        const view = document.createElement('div');
        view.className = 'bc-task-history-error';
        view.setAttribute('role', 'alert');

        const text = document.createElement('p');
        text.className = 'bc-task-history-error-text';
        text.textContent = `Could not load the task list. ${error}`;

        view.append(text, buildButton({
            className: 'bc-task-history-action bc-task-history-retry',
            label: 'Retry',
            title: RETRY_TITLE,
            onClick: () => {
                error = '';
                void refresh();
            },
        }));
        return view;
    }

    /**
     * Builds the inline alert shown above the (stale) list when an action
     * or refresh fails after a successful load.
     *
     * @param {string} message Failure message.
     * @returns {Element} Alert element.
     */
    function buildAlert(message) {
        const alert = document.createElement('div');
        alert.className = 'bc-task-history-alert';
        alert.setAttribute('role', 'alert');
        alert.textContent = message;
        return alert;
    }

    /**
     * Builds the empty state.
     *
     * @returns {Element} Empty-state element.
     */
    function buildEmpty() {
        const empty = document.createElement('div');
        empty.className = 'bc-task-history-empty';

        const text = document.createElement('p');
        text.className = 'bc-task-history-empty-text';
        text.textContent = 'No saved tasks yet. Start a new task and it will show up here.';

        const note = document.createElement('p');
        note.className = 'bc-task-history-empty-note';
        note.textContent = EMPTY_NOTE;

        empty.append(text, note);
        return empty;
    }

    /**
     * Builds the full panel DOM from closure state.
     *
     * @returns {Element} Panel root.
     */
    function buildRoot() {
        const root = document.createElement('div');
        root.className = 'bc-task-history';
        root.tabIndex = -1;

        const toolbar = document.createElement('div');
        toolbar.className = 'bc-task-history-toolbar';
        const title = document.createElement('h3');
        title.className = 'bc-task-history-title';
        title.textContent = 'Task History';
        toolbar.append(title, buildButton({
            className: 'bc-task-history-new',
            label: 'New task',
            title: NEW_TASK_TITLE,
            onClick: () => startNewTask(),
        }));

        const note = document.createElement('p');
        note.className = 'bc-task-history-note';
        note.textContent = RETENTION_NOTE;

        root.append(toolbar, note);

        if (loading && !loaded) {
            const status = document.createElement('div');
            status.className = 'bc-task-history-loading';
            status.setAttribute('role', 'status');
            status.textContent = 'Loading tasks…';
            root.append(status);
        } else if (!loaded && error) {
            root.append(buildErrorView());
        } else {
            if (error) {
                root.append(buildAlert(error));
            }
            if (tasks.length > 0) {
                const list = document.createElement('ul');
                list.className = 'bc-task-history-list';
                for (const summary of tasks) {
                    list.append(buildRow(summary));
                }
                root.append(list);
            } else {
                root.append(buildEmpty());
            }
        }
        return root;
    }

    /**
     * Renders (or re-renders) the panel into the container. Idempotent:
     * rebuilds via `container.replaceChildren` from closure state; the
     * initial fetch is kicked off exactly once per panel instance.
     *
     * @param {Element} container Host element.
     * @returns {Element|null} The panel root (tabIndex -1 focus target).
     */
    function render(container) {
        host = container;
        if (!started) {
            started = true;
            void refresh();
        } else {
            paint();
        }
        return host.children.length ? host.children[0] : null;
    }

    /**
     * Detaches the panel: pending fetch resolutions no longer repaint the
     * container. Safe to call multiple times.
     *
     * @returns {void}
     */
    function dispose() {
        host = null;
        confirmDeleteId = null;
    }

    return { render, refresh, dispose };
}
