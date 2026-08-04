'use strict';

/**
 * @file Controller for the 8-page Bulk Combine guided task wizard.
 *
 * Opens the two-column shell (vertical workflow rail + content canvas) via
 * `callGenericPopup`, wires the server-backed {@link TaskWizardState} to the
 * rail, header, and page modules, and enforces the core navigation
 * contract: selecting a page ONLY re-renders that page's module with the
 * current snapshot — navigation NEVER starts, resumes, or cancels
 * server-side execution.
 *
 * Closing the popup never cancels execution either: durable task work
 * continues server-side and the wizard re-opens from the task snapshot.
 *
 * Page modules are registered by key (`registerPage`); unregistered pages
 * fall back to read-only placeholders so the whole flow is navigable while
 * the real pages land in later steps. A page module exposes
 * `render(container, state)` (returning the focus target, usually the page
 * heading) and an optional `dispose()`.
 *
 * Plain DOM is used throughout (no jQuery) so the controller runs under the
 * Node unit-test environment with light DOM fakes.
 */

import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { createTaskClient } from '../services/TaskClient.js';
import { withResolvedWindowPersistence } from '../services/resolveCompletionSettings.js';
import {
    TASK_WIZARD_PAGES,
    TaskWizardState,
    pageIndexForKey,
} from './TaskWizardState.js';
import { createWorkflowRail } from '../components/WorkflowRail.js';
import { createPlaceholderPage } from './pages/placeholderPage.js';
import { createWizardPageOverrides } from './pages/index.js';
import { createTaskHistoryPanel } from '../components/TaskHistoryPanel.js';
import { buildTaskWizardShell } from './TaskWizardShell.js';

/**
 * Save/checkpoint indicator labels keyed by `TaskWizardState#syncState`.
 *
 * @type {Readonly<Object<string, string>>}
 */
const SYNC_STATE_LABELS = Object.freeze({
    saved: 'Saved',
    saving: 'Saving…',
    conflict: 'Update conflict — reloaded latest',
    error: 'Save failed',
});

/**
 * Builds the header execution-summary line from the task snapshot.
 *
 * @param {object} task Task snapshot.
 * @returns {string} Summary line (empty when idle).
 */
function describeExecution(task) {
    const execution = task?.execution ?? {};
    if (execution.status === 'running' && execution.pass) {
        const page = TASK_WIZARD_PAGES.find((entry) => entry.key === execution.pass);
        return `Running ${page?.title ?? execution.pass}…`;
    }
    if (execution.status === 'interrupted') {
        return 'Execution was interrupted — resume from the affected page.';
    }
    return '';
}

/**
 * Reports an error to the console and the user.
 *
 * @param {string} message User-facing message.
 * @param {unknown} error Caught error.
 * @returns {void}
 */
function reportError(message, error) {
    console.error(`TaskWizardController: ${message}`, error);
    globalThis.toastr?.error?.(message, 'Combine into Group Card');
}

/**
 * 8-page guided task wizard controller. One instance per open wizard.
 */
export class TaskWizardController {
    /** @type {import('../services/TaskClient.js').TaskClient} */
    #client;

    /** @type {(() => void)|null} Orchestrator callback that opens the Task History panel (wired by openTaskWizard). */
    #onOpenHistory = null;

    /** @type {Map<string, {render: Function, dispose?: Function}>} Page registry (key → module). */
    #pages = new Map();

    /** @type {TaskWizardState|null} */
    #state = null;

    /** @type {object|null} Bound actions facade handed to page modules. */
    #actions = null;

    /** @type {object|null} Rail component instance. */
    #rail = null;

    /** @type {object|null} Shell elements. */
    #shell = null;

    /** @type {object|null} Open popup instance. */
    #popup = null;

    /** @type {(() => void)|null} State subscription. */
    #unsubscribeState = null;

    /** @type {string|null} Active page key. */
    #activePageKey = null;

    /** @type {object|null} Active page module. */
    #activePageModule = null;

    /** @type {boolean} Focus the page heading after the next render (page change). */
    #focusPageOnNextRender = false;

    /** @type {boolean} Whether the controller is closed (idempotent close). */
    #closed = true;

    /**
     * @param {object} [options] Options.
     * @param {import('../services/TaskClient.js').TaskClient} [options.client] Task client (defaults to a new instance).
     * @param {Object<string, {render: Function, dispose?: Function}>} [options.pages] Page module overrides keyed by page key.
     * @param {() => void} [options.onOpenHistory] Opens the Task History panel (wired by openTaskWizard; the button is inert without it).
     */
    constructor({ client, pages, onOpenHistory } = {}) {
        this.#client = client ?? createTaskClient();
        this.#onOpenHistory = typeof onOpenHistory === 'function' ? onOpenHistory : null;
        for (const page of TASK_WIZARD_PAGES) {
            this.#pages.set(page.key, createPlaceholderPage({ key: page.key, title: page.title }));
        }
        for (const [key, module] of Object.entries(pages ?? {})) {
            this.registerPage(key, module);
        }
    }

    /** @returns {TaskWizardState|null} The wizard state (null when closed). */
    get state() {
        return this.#state;
    }

    /** @returns {string|null} Active page key. */
    get activePageKey() {
        return this.#activePageKey;
    }

    /**
     * Registers (or replaces) a page module for a known page key.
     *
     * @param {string} key Page key (one of `TASK_WIZARD_PAGES`).
     * @param {{render: Function, dispose?: Function}} module Page module.
     * @returns {void}
     */
    registerPage(key, module) {
        if (!TASK_WIZARD_PAGES.some((page) => page.key === key)) {
            throw new Error(`TaskWizardController: unknown page key "${key}".`);
        }
        if (typeof module?.render !== 'function') {
            throw new Error('TaskWizardController: page modules must expose render(container, state).');
        }
        this.#pages.set(key, module);
    }

    /**
     * Opens the wizard for a task: initializes state, connects task events,
     * opens the popup, and renders the task's current page. Resolves when
     * the popup closes.
     *
     * @param {string|object} taskOrId Task id or freshly created task object.
     * @returns {Promise<void>}
     */
    async open(taskOrId) {
        if (!this.#closed) {
            await this.close();
        }
        this.#closed = false;

        this.#state = new TaskWizardState({ client: this.#client });
        await this.#state.init(taskOrId);
        this.#actions = this.#buildActions();

        this.#shell = buildTaskWizardShell();
        this.#bindHeader();

        this.#rail = createWorkflowRail({ onSelect: (pageKey) => void this.#navigate(pageKey) });
        this.#rail.render(this.#shell.railHost, this.#railProps());

        this.#unsubscribeState = this.#state.subscribe((snapshot) => this.#onStateChange(snapshot));
        this.#renderCurrentPage();
        this.#syncHeader();
        this.#state.connectEvents();

        await callGenericPopup(this.#shell.root, POPUP_TYPE.DISPLAY, '', {
            wide: true,
            wider: true,
            large: true,
            allowVerticalScrolling: true,
            onOpen: (popup) => {
                this.#popup = popup;
            },
            // Popup-initiated close (X / Escape): clear the ref first so
            // close() does not re-complete an already-closing popup.
            onClose: () => {
                this.#popup = null;
                void this.close();
            },
        });
    }

    /**
     * Closes the wizard: unsubscribes task events, disposes the active page,
     * and closes the popup. Closing NEVER cancels server-side execution.
     * Idempotent.
     *
     * @returns {Promise<void>}
     */
    async close() {
        if (this.#closed) {
            return;
        }
        this.#closed = true;

        this.#unsubscribeState?.();
        this.#unsubscribeState = null;

        this.#state?.dispose();

        this.#activePageModule?.dispose?.();
        this.#activePageModule = null;
        this.#activePageKey = null;

        this.#rail?.destroy();
        this.#rail = null;

        const popup = this.#popup;
        this.#popup = null;
        if (popup) {
            await popup.completeCancelled();
        }

        this.#state = null;
        this.#actions = null;
        this.#shell = null;
    }

    /**
     * Builds the actions facade passed to page modules as the third
     * `render` argument. Page modules execute ONLY through this facade —
     * they never hold the client or state directly. Execution methods are
     * fire-and-forget (progress arrives via the task event stream); UI
     * mutations go through `update` (optimistic PATCH).
     *
     * @returns {object} Actions facade.
     */
    #buildActions() {
        return Object.freeze({
            /** Optimistic PATCH with conflict recovery. */
            update: (patch) => this.#state.update(patch),
            /** Re-fetch the authoritative snapshot + notify. */
            refresh: () => this.#state.refresh(),
            /** Ungated page move (Continue buttons); rail clicks stay gated. */
            goToPage: (index) => this.#state.setPage(index),
            /** Rail-gated navigation used by page shortcuts. */
            navigate: (pageKey) => this.#navigate(pageKey),
            /** Fire-and-forget pass start (202). */
            runPass: (passKey, options) => this.#client.runPass(this.#state.taskId, passKey, options),
            /** Fire-and-forget pass resume (202). */
            resumePass: (passKey) => this.#client.resumePass(this.#state.taskId, passKey),
            /** Cancel running work for the task. */
            cancel: () => this.#client.cancelTask(this.#state.taskId),
            /** Cancel one card's in-flight generation (rest of the run continues). */
            cancelItem: (passKey, itemKey) => this.#client.cancelTask(this.#state.taskId, { passKey, itemKey }),
            /** Fire-and-forget post-process run (202). */
            runPostProcess: () => this.#client.runPostProcess(this.#state.taskId),
            /** Fire-and-forget prompt-assist proposal (202). */
            runPromptAssist: (promptKey, options) => this.#client.runPromptAssist(this.#state.taskId, promptKey, options),
            /** Assembled review payload. */
            getReview: () => this.#client.getReview(this.#state.taskId),
        });
    }

    /**
     * Navigates to a page by key: re-renders the page module with the
     * current snapshot after persisting the new page position. Pure
     * navigation — no execution entry point is ever called from here.
     *
     * @param {string} pageKey Target page key.
     * @returns {Promise<void>}
     */
    async #navigate(pageKey) {
        if (this.#closed || !this.#state) {
            return;
        }
        const index = pageIndexForKey(pageKey);
        const pageState = this.#state.pageStates.find((page) => page.key === pageKey);
        if (!index || !pageState || pageState.status === 'disabled') {
            return;
        }
        if (index > this.#state.furthestPage) {
            return;
        }

        this.#focusPageOnNextRender = true;
        try {
            await this.#state.setPage(index);
        } catch (error) {
            this.#focusPageOnNextRender = false;
            reportError('Failed to save the page position.', error);
        }
    }

    /**
     * Re-renders rail, header, and the current page on every state change.
     *
     * @param {object} snapshot State snapshot.
     * @returns {void}
     */
    #onStateChange(snapshot) {
        if (this.#closed || !this.#shell) {
            return;
        }
        this.#rail?.update({
            pages: snapshot.pageStates,
            currentPage: snapshot.currentPage,
            furthestPage: snapshot.furthestPage,
        });
        this.#syncHeader(snapshot);
        this.#renderCurrentPage();
    }

    /**
     * Renders the current page's module into the canvas and moves focus to
     * the page heading after a page change (accessibility contract).
     *
     * @returns {void}
     */
    #renderCurrentPage() {
        if (!this.#shell || !this.#state) {
            return;
        }
        const snapshot = this.#state.getSnapshot();
        const pageState = snapshot.pageStates[snapshot.currentPage - 1] ?? snapshot.pageStates[0];
        const module = this.#pages.get(pageState.key);
        if (!module) {
            return;
        }

        if (this.#activePageKey !== pageState.key) {
            this.#activePageModule?.dispose?.();
        }

        this.#shell.canvas.setAttribute('aria-label', pageState.title);
        const heading = module.render(this.#shell.canvas, snapshot, this.#actions) ?? null;
        this.#activePageKey = pageState.key;
        this.#activePageModule = module;

        if (this.#focusPageOnNextRender) {
            this.#focusPageOnNextRender = false;
            heading?.focus?.();
        }
    }

    /**
     * Syncs the header indicators (save state, execution summary) with the
     * snapshot. The task-name input is intentionally NOT re-synced on every
     * change so in-progress edits are never clobbered.
     *
     * @param {object} [snapshot] State snapshot (defaults to current).
     * @returns {void}
     */
    #syncHeader(snapshot) {
        if (!this.#shell || !this.#state) {
            return;
        }
        const snap = snapshot ?? this.#state.getSnapshot();
        this.#shell.saveState.textContent = SYNC_STATE_LABELS[snap.syncState] ?? '';
        this.#shell.saveState.className = `bc-task-save-state bc-task-save-state--${snap.syncState}`;
        this.#shell.executionSummary.textContent = describeExecution(snap.task);
    }

    /**
     * Binds the header controls: the task-name input (renames via PATCH on
     * change) and the Task History button (delegates to the orchestrator's
     * onOpenHistory callback; inert when none was provided).
     *
     * @returns {void}
     */
    #bindHeader() {
        this.#shell.nameInput.value = this.#state.task?.name ?? '';
        this.#shell.nameInput.addEventListener('change', () => {
            const name = String(this.#shell.nameInput.value ?? '').trim();
            if (name && name !== this.#state?.task?.name) {
                this.#state.update({ name }).catch((error) => reportError('Failed to rename the task.', error));
            }
        });
        this.#shell.historyButton.addEventListener('click', () => {
            if (this.#closed || !this.#state) {
                return;
            }
            this.#onOpenHistory?.();
        });
    }

    /**
     * Builds the rail props from the current state.
     *
     * @returns {{pages: Array, currentPage: number, furthestPage: number}} Rail props.
     */
    #railProps() {
        return {
            pages: this.#state.pageStates,
            currentPage: this.#state.currentPage,
            furthestPage: this.#state.furthestPage,
        };
    }
}

/**
 * Opens the Task History panel in a popup. Open/New close the popup (and
 * run `onReopen`, e.g. to close the wizard behind it) before opening the
 * chosen (or a freshly created) task in the wizard — closing NEVER cancels
 * running server-side execution, so background work keeps going across the
 * switch.
 *
 * @param {object} options Options.
 * @param {import('../services/TaskClient.js').TaskClient} options.client Task client.
 * @param {string|number|null} [options.currentTaskId] Task marked as Current in the list.
 * @param {Object<string, {render: Function, dispose?: Function}>} [options.pages] Page overrides forwarded to the reopened wizard.
 * @param {() => void} [options.onReopen] Runs after the popup closes, before the wizard reopens.
 * @param {() => void} [options.onClosed] Runs when the history popup closes for any reason.
 * @returns {Promise<*>} The popup's result promise (settles on close).
 */
function openHistoryPopup({ client, currentTaskId = null, pages, onReopen, onClosed }) {
    /** @type {object|null} Open Task History panel instance. */
    let historyPanel = null;
    /** @type {object|null} Open Task History popup instance. */
    let historyPopup = null;

    /**
     * Closes the Task History popup (if open) and disposes the panel.
     * Idempotent; the popup's onClose re-dispose is a guarded no-op.
     *
     * @returns {void}
     */
    function closeHistoryPanel() {
        const popup = historyPopup;
        const panel = historyPanel;
        historyPopup = null;
        historyPanel = null;
        panel?.dispose?.();
        if (popup) {
            void popup.completeCancelled?.();
        }
    }

    historyPanel = createTaskHistoryPanel({
        client,
        currentTaskId,
        onOpenTask: (id) => {
            closeHistoryPanel();
            onReopen?.();
            void openTaskWizard(id, { client, pages });
        },
        onNewTask: () => {
            closeHistoryPanel();
            onReopen?.();
            void (async () => {
                let fresh;
                try {
                    fresh = await client.createTask({ name: 'New Combine Task' });
                } catch (error) {
                    reportError('Failed to create a new task.', error);
                    return;
                }
                void openTaskWizard(fresh, { client, pages });
            })();
        },
    });
    const host = document.createElement('div');
    historyPanel.render(host);
    return callGenericPopup(host, POPUP_TYPE.DISPLAY, 'Task History', {
        wide: true,
        allowVerticalScrolling: true,
        onOpen: (popup) => { historyPopup = popup; },
        onClose: () => {
            historyPanel?.dispose?.();
            historyPanel = null;
            historyPopup = null;
            onClosed?.();
        },
    });
}

/**
 * Convenience entry point: opens the guided task wizard for a task.
 *
 * Wires the header Task History button: it opens the durable-task panel in a
 * nested popup, and its Open/New actions close this wizard and reopen it for
 * the chosen (or a freshly created) task — closing NEVER cancels running
 * server-side execution, so background work keeps going across the switch.
 *
 * @param {string|object} taskOrId Task id or freshly created task object.
 * @param {object} [options] Options forwarded to the controller.
 * @param {import('../services/TaskClient.js').TaskClient} [options.client] Task client.
 * @param {Object<string, {render: Function, dispose?: Function}>} [options.pages] Page module overrides keyed by page key.
 * @returns {Promise<TaskWizardController>} The controller (after the popup closes).
 */
export async function openTaskWizard(taskOrId, { client, pages } = {}) {
    const resolvedClient = client ?? createTaskClient();
    /** @type {TaskWizardController} */
    let controller;
    /** @type {boolean} Re-entry guard while the history popup is open. */
    let historyOpen = false;

    /**
     * Opens the Task History panel in a nested popup. Open/New close this
     * wizard and reopen it for the chosen (or a fresh) task.
     *
     * @returns {void}
     */
    function openHistoryPanel() {
        if (historyOpen) {
            return;
        }
        historyOpen = true;
        void openHistoryPopup({
            client: resolvedClient,
            currentTaskId: controller?.state?.taskId ?? null,
            pages,
            onReopen: () => { void controller.close(); },
            onClosed: () => { historyOpen = false; },
        });
    }

    controller = new TaskWizardController({
        client: resolvedClient,
        pages: pages ?? createWizardPageOverrides(),
        onOpenHistory: openHistoryPanel,
    });
    await controller.open(taskOrId);
    return controller;
}

/**
 * Standalone entry point: opens the Task History panel popup without a
 * wizard behind it (e.g. from the character-list button bar). Open/New
 * close the popup and open the chosen (or a fresh) task in the wizard.
 *
 * @param {object} [options] Options.
 * @param {import('../services/TaskClient.js').TaskClient} [options.client] Task client (defaults to a window-persistence-resolved one).
 * @returns {Promise<*>} Resolves when the history popup closes.
 */
export function openTaskHistoryPopup({ client } = {}) {
    const resolvedClient = client ?? withResolvedWindowPersistence(createTaskClient());
    return openHistoryPopup({ client: resolvedClient });
}
