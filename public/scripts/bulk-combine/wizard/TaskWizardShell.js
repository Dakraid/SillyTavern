'use strict';

/**
 * @file Popup shell for the 8-page Bulk Combine guided task wizard.
 *
 * Builds the two-column shell (persistent vertical workflow rail on the
 * left, wide content canvas on the right) plus the header row: task name
 * input, save/checkpoint indicator, execution-summary line, and the Task
 * History button.
 *
 * The shell is built in JS instead of a `templates/task-wizard.html`
 * fragment (deliverable allows either): the unit-test environment has no
 * HTML parser, so building DOM directly keeps production code and test code
 * on the same path. IDs follow the `bc_task_` convention, classes the
 * `bc-task-` convention (see styles.css).
 *
 * The shell performs no work itself; the controller binds all behavior.
 */

/**
 * Builds the wizard shell DOM.
 *
 * @returns {{
 *   root: Element,
 *   nameInput: Element,
 *   saveState: Element,
 *   executionSummary: Element,
 *   historyButton: Element,
 *   railHost: Element,
 *   canvas: Element,
 * }} Shell elements.
 */
export function buildTaskWizardShell() {
    const root = document.createElement('div');
    root.className = 'bc-task';

    // ------------------------------------------------------------------
    // Header: task name, save state, execution summary, Task History.
    // ------------------------------------------------------------------
    const header = document.createElement('div');
    header.className = 'bc-task-header';

    const nameLabel = document.createElement('label');
    nameLabel.className = 'bc-task-name-label';
    nameLabel.setAttribute('for', 'bc_task_name');
    nameLabel.textContent = 'Task';

    const nameInput = document.createElement('input');
    nameInput.id = 'bc_task_name';
    nameInput.className = 'bc-task-name text_pole';
    nameInput.type = 'text';
    nameInput.setAttribute('aria-label', 'Task name');
    nameInput.setAttribute('maxlength', '120');

    const saveState = document.createElement('span');
    saveState.id = 'bc_task_save_state';
    saveState.className = 'bc-task-save-state';
    saveState.setAttribute('role', 'status');
    saveState.setAttribute('aria-live', 'polite');

    const executionSummary = document.createElement('span');
    executionSummary.id = 'bc_task_execution';
    executionSummary.className = 'bc-task-execution';
    executionSummary.setAttribute('role', 'status');
    executionSummary.setAttribute('aria-live', 'polite');

    const historyButton = document.createElement('button');
    historyButton.id = 'bc_task_history';
    historyButton.className = 'menu_button bc-task-history';
    historyButton.type = 'button';
    historyButton.disabled = true;
    historyButton.setAttribute('aria-disabled', 'true');
    historyButton.title = 'Task History arrives in a later step; the task is already saved on the server.';

    const historyIcon = document.createElement('i');
    historyIcon.className = 'fa-solid fa-clock-rotate-left';
    historyIcon.setAttribute('aria-hidden', 'true');
    const historyText = document.createElement('span');
    historyText.textContent = 'Task History';
    historyButton.append(historyIcon, historyText);

    header.append(nameLabel, nameInput, saveState, executionSummary, historyButton);

    // ------------------------------------------------------------------
    // Main: vertical rail (left) + content canvas (right).
    // ------------------------------------------------------------------
    const main = document.createElement('div');
    main.className = 'bc-task-main';

    const railHost = document.createElement('div');
    railHost.id = 'bc_task_rail';
    railHost.className = 'bc-task-rail-host';

    const canvas = document.createElement('div');
    canvas.id = 'bc_task_canvas';
    canvas.className = 'bc-task-canvas';
    canvas.setAttribute('role', 'tabpanel');
    canvas.setAttribute('aria-live', 'off');

    main.append(railHost, canvas);
    root.append(header, main);

    return { root, nameInput, saveState, executionSummary, historyButton, railHost, canvas };
}
