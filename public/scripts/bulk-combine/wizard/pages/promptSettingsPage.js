'use strict';

/**
 * @file Prompt & Settings page (page 2) for the 8-page Bulk Combine guided
 * task wizard.
 *
 * Left workspace edits the main combine prompt (explicit Save button — the
 * prompt is durable task state, not a draft). Right workspace drives the
 * prompt assistant: a request textarea, "Suggest revision" (202 background
 * run via `actions.runPromptAssist`; the proposal arrives through later
 * snapshot re-renders), an inline rich diff (`diff_match_patch` when the
 * browser bundle exposes it, plain proposal text otherwise) with
 * Apply/Dismiss. Below the workspaces, a grouped settings drawer (native
 * `<details>` sections) edits connection, token windows, processing mode,
 * output/lorebook, and optional passes — every control PATCHes sparsely on
 * `change`. Each prompt field (main, second pass, summary, post-processing)
 * has a preset row (select + Apply/Save/Delete) backed by the new
 * `bulk_combine_task_prompt_presets` store (`services/promptPresets.js`);
 * the legacy preset lists are migrated into that store lazily on first
 * access.
 *
 * Page-module contract: `render(container, snapshot, actions) → Element`
 * (the page heading, used as the focus target). The page is a pure function
 * of the snapshot plus its closure-held ephemeral UI state (textarea drafts,
 * open drawer groups, the assist in-flight flag): every render clears the
 * container and rebuilds. Rendering NEVER executes work; the only execution
 * entry point is the Suggest button, and only on click.
 *
 * Plain DOM only (no jQuery, no innerHTML/querySelector/createTextNode) so
 * the page runs under the Node unit-test environment with light DOM fakes.
 */

import { extension_settings } from '../../../extensions.js';
import { openai_setting_names, openai_settings } from '../../../openai.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../popup.js';
import { CONNECT_API_MAP } from '../../../slash-commands.js';
import { escapeHtml } from '../../../utils.js';
import { deletePromptPreset, findPromptPresetIndex, getPromptPresets, savePromptPreset } from '../../services/promptPresets.js';
import { resolveApiEntry, resolveCompletionSettings } from '../../services/resolveCompletionSettings.js';

/** @type {string} Field key for the main prompt textarea. */
const MAIN_TEXT_FIELD = 'prompt:main:text';
/** @type {string} Field key for the assistant request textarea. */
const ASSIST_REQUEST_FIELD = 'assistant:main:request';

const ASSIST_IN_FLIGHT_TEXT = 'Generating a proposal — this runs in the background…';
const SUGGEST_TITLE = 'Ask the assistant to revise the combine prompt. Runs in the background.';
const SAVE_TITLE = 'Save the combine prompt to the task.';
const APPLY_TITLE = 'Replace the combine prompt with the proposal.';
const DISMISS_TITLE = 'Discard the proposal and the assistant request.';
const DISCARD_REQUEST_TITLE = 'Discard the pending assistant request.';
const CONTINUE_TITLE = 'Continue to Transform 1.';
const CONTINUE_SAVE_TITLE = 'Save the combine prompt first, then continue.';
const CONTINUE_EMPTY_TITLE = 'Enter and save a combine prompt first.';
const READ_ONLY_NOTE = 'This task is completed — it is read-only. Duplicate it from Task History to keep iterating.';
const UNRESOLVED_READOUT = 'Unresolved — select a connection profile or a chat completion preset.';
const TOAST_TITLE = 'Combine into Group Card';
const PRESET_LOAD_OPTION = '— Load preset —';
const PRESET_APPLY_TITLE = 'Load the selected preset into the prompt and save it to the task.';
const PRESET_SAVE_TITLE = 'Save the current prompt text as a named preset.';
const PRESET_DELETE_TITLE = 'Delete the selected preset.';

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
 * Reads a trimmed string defensively.
 *
 * @param {unknown} value Candidate.
 * @returns {string} String (possibly empty).
 */
function stringOf(value) {
    return typeof value === 'string' ? value : '';
}

/**
 * Sends a sparse optimistic PATCH through the actions facade. Failures are
 * logged, never thrown into render/click paths.
 *
 * @param {object} actions Actions facade.
 * @param {object} patch Sparse task patch.
 * @returns {void}
 */
function applyPatch(actions, patch) {
    let result;
    try {
        result = actions?.update?.(patch);
    } catch (error) {
        console.error('promptSettingsPage: failed to update the task.', error);
        return;
    }
    Promise.resolve(result).catch((error) => {
        console.error('promptSettingsPage: failed to update the task.', error);
    });
}

/**
 * Creates the Prompt & Settings page module for the controller's page
 * registry.
 *
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createPromptSettingsPage() {
    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /**
     * Uncommitted textarea text, keyed by `data-field-key`. Updated on
     * `input` (never PATCHed mid-typing), committed on `change`/Save, and
     * restored across rebuilds so re-renders never clobber typing.
     *
     * @type {Map<string, string>}
     */
    const draftValues = new Map();
    /**
     * Open settings-drawer groups, keyed by group key — survives rebuilds.
     *
     * @type {Set<string>}
     */
    const openGroups = new Set(['connection']);
    /**
     * Page-owned assist in-flight flag: set on Suggest click, cleared when a
     * proposal/error lands in the snapshot (or the request is cleared). The
     * persistent waiting state is DERIVED from the snapshot (a non-empty
     * `assistant.request` with no proposal/error yet), so re-opening the
     * page while an assist run is outstanding still shows the waiting state
     * — this flag only covers the launch window before the snapshot catches
     * up.
     *
     * @type {boolean}
     */
    let assistInFlight = false;
    /**
     * Last assist LAUNCH failure (runPromptAssist rejected): surfaced
     * inline, cleared on the next attempt or dismiss.
     *
     * @type {string}
     */
    let assistLaunchError = '';
    /**
     * Whether the task is completed (read-only rendering): set on every
     * render from the snapshot.
     *
     * @type {boolean}
     */
    let readOnlyMode = false;
    /**
     * Elements built this render, keyed by `data-field-key` — used to
     * restore focus/selection after a rebuild (the fake DOM has no
     * querySelector).
     *
     * @type {Map<string, Element>}
     */
    let fieldRefs = new Map();
    /**
     * Selected preset index per prompt field ('' = none) — survives rebuilds.
     *
     * @type {Map<string, number|string>}
     */
    const selectedPresets = new Map();

    /** @returns {object} Current task record (defensive). */
    function taskOf() {
        return recordOf(latestSnapshot?.task);
    }

    /** @returns {object} Current task settings (defensive). */
    function settingsOf() {
        return recordOf(taskOf().settings);
    }

    /**
     * Reads one prompt record (`{ text, assistant }`) defensively.
     *
     * @param {string} promptKey Prompt key (`main`, `secondPass`, …).
     * @returns {{text: string, assistant: object}} Prompt record.
     */
    function promptOf(promptKey) {
        const prompt = recordOf(recordOf(taskOf().prompts)[promptKey]);
        return { text: stringOf(prompt.text), assistant: recordOf(prompt.assistant) };
    }

    /**
     * Effective assistant request: the uncommitted draft wins over the
     * snapshot value (Suggest may be clicked before a blur-commit).
     *
     * @returns {string} Request text.
     */
    function effectiveAssistRequest() {
        return draftValues.has(ASSIST_REQUEST_FIELD)
            ? draftValues.get(ASSIST_REQUEST_FIELD)
            : stringOf(promptOf('main').assistant.request);
    }

    /**
     * Snapshot-derived assist waiting state: the server persisted a request
     * that has no proposal/error yet. Durable across page re-opens (unlike
     * the closure-only launch flag).
     *
     * @returns {boolean} True while an assist run is outstanding.
     */
    function assistWaitingFromSnapshot() {
        const assistant = promptOf('main').assistant;
        return stringOf(assistant.request).trim().length > 0
            && !stringOf(assistant.proposal)
            && !stringOf(assistant.error);
    }

    /**
     * Whether an assist proposal is outstanding (launch window or durable).
     *
     * @returns {boolean} True while waiting for a proposal.
     */
    function assistWaiting() {
        return assistInFlight || assistWaitingFromSnapshot();
    }

    /**
     * Resolves the current completion settings for readouts and assist runs.
     *
     * @returns {object} Sanitized completion settings.
     */
    function resolvedCompletion() {
        return resolveCompletionSettings(taskOf(), { apiMap: CONNECT_API_MAP });
    }

    /**
     * PATCHes one settings key sparsely.
     *
     * @param {string} key Settings key.
     * @param {unknown} value New value.
     * @returns {void}
     */
    function patchSettings(key, value) {
        applyPatch(latestActions, { settings: { [key]: value } });
    }

    /**
     * PATCHes one prompt's text sparsely.
     *
     * @param {string} promptKey Prompt key.
     * @param {string} text New text.
     * @returns {void}
     */
    function patchPromptText(promptKey, text) {
        applyPatch(latestActions, { prompts: { [promptKey]: { text } } });
    }

    // ------------------------------------------------------------------
    // Control builders
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
     * @param {(text: string) => void} [options.onCommit] Commit callback on `change`.
     * @param {() => void} [options.onInput] Extra `input` hook (e.g. enabling Save).
     * @returns {Element} Textarea element.
     */
    function buildTextarea({ fieldKey, value, rows, ariaLabel, className, onCommit, onInput }) {
        const textarea = document.createElement('textarea');
        textarea.className = className;
        textarea.rows = rows;
        textarea.setAttribute('data-field-key', fieldKey);
        textarea.setAttribute('aria-label', ariaLabel);
        textarea.readOnly = readOnlyMode === true;
        textarea.value = draftValues.has(fieldKey) ? draftValues.get(fieldKey) : value;
        textarea.addEventListener('input', () => {
            draftValues.set(fieldKey, String(textarea.value ?? ''));
            onInput?.();
        });
        textarea.addEventListener('change', () => {
            const text = String(textarea.value ?? '');
            if (onCommit) {
                draftValues.delete(fieldKey);
                onCommit(text);
            }
            // Without a commit callback (main prompt), the draft is kept so
            // the text survives re-renders until the explicit Save.
        });
        fieldRefs.set(fieldKey, textarea);
        return textarea;
    }

    /**
     * Shows the overwrite confirmation popup for a preset-name collision
     * (the legacy confirm-overwrite idiom).
     *
     * @param {string} name Preset name.
     * @returns {Promise<boolean>} True when the user confirms the overwrite.
     */
    async function confirmPresetOverwrite(name) {
        const result = await callGenericPopup(
            `Overwrite prompt preset "${escapeHtml(name)}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            { okButton: 'Overwrite', cancelButton: 'Cancel' },
        );
        return result === POPUP_RESULT.AFFIRMATIVE;
    }

    /**
     * Builds the prompt-preset row for one prompt field: a select of the
     * field's presets plus Apply (loads the preset into the textarea and
     * commits it through the field's normal prompt patch path), Save
     * (stores the current textarea text under a popup-asked name,
     * confirming overwrites), and Delete (removes the selected preset).
     * Backed by the new `promptPresets` store; the legacy preset lists are
     * migrated into it lazily on first store access.
     *
     * @param {object} options Row options.
     * @param {string} options.field Prompt field (`main`, `secondPass`, `summary`, `post`).
     * @param {string} options.label Human field label (lowercase, for accessible names).
     * @param {Element} options.textarea The field's textarea element.
     * @param {() => void} [options.onApplied] Extra hook after Apply commits.
     * @returns {Element} Preset row.
     */
    function buildPresetRow({ field, label, textarea, onApplied }) {
        const fieldKey = `prompt:${field}:text`;
        const presets = getPromptPresets(field);
        let selected = selectedPresets.get(field) ?? '';
        if (selected !== '' && (!Number.isInteger(selected) || selected < 0 || selected >= presets.length)) {
            selected = '';
            selectedPresets.set(field, '');
        }

        const row = document.createElement('div');
        row.className = 'bc-task-preset-row';

        const select = document.createElement('select');
        select.className = 'bc-task-select bc-task-preset-select';
        select.setAttribute('aria-label', `${label} presets`);
        select.setAttribute('data-field-key', `preset:${field}`);
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = PRESET_LOAD_OPTION;
        select.append(placeholder);
        presets.forEach((preset, index) => {
            const option = document.createElement('option');
            option.value = String(index);
            option.textContent = String(preset?.name ?? '');
            select.append(option);
        });
        select.value = selected === '' ? '' : String(selected);
        select.disabled = readOnlyMode === true;
        fieldRefs.set(`preset:${field}`, select);

        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'bc-task-preset-apply';
        applyButton.textContent = 'Apply';
        applyButton.title = PRESET_APPLY_TITLE;
        applyButton.setAttribute('aria-label', `Apply the selected ${label} preset`);
        applyButton.disabled = select.value === '' || readOnlyMode === true;

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'bc-task-preset-save';
        saveButton.textContent = 'Save';
        saveButton.title = PRESET_SAVE_TITLE;
        saveButton.setAttribute('aria-label', `Save the ${label} as a preset`);
        saveButton.disabled = readOnlyMode === true;

        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'bc-task-preset-delete';
        deleteButton.textContent = 'Delete';
        deleteButton.title = PRESET_DELETE_TITLE;
        deleteButton.setAttribute('aria-label', `Delete the selected ${label} preset`);
        deleteButton.disabled = select.value === '' || readOnlyMode === true;

        select.addEventListener('change', () => {
            const value = String(select.value ?? '');
            selectedPresets.set(field, value === '' ? '' : Number(value));
            applyButton.disabled = value === '' || readOnlyMode === true;
            deleteButton.disabled = value === '' || readOnlyMode === true;
        });

        applyButton.addEventListener('click', () => {
            const preset = getPromptPresets(field)[Number(select.value)];
            if (!preset) {
                return;
            }
            const text = String(preset.prompt ?? '');
            draftValues.delete(fieldKey);
            textarea.value = text;
            patchPromptText(field, text);
            onApplied?.();
            globalThis.toastr?.success?.(`Loaded prompt preset "${preset.name}".`, TOAST_TITLE);
        });

        saveButton.addEventListener('click', async () => {
            const prefill = select.value === '' ? '' : String(getPromptPresets(field)[Number(select.value)]?.name ?? '');
            const name = await callGenericPopup(
                `Save the current ${label} text as a prompt preset.`,
                POPUP_TYPE.INPUT,
                prefill,
                { okButton: 'Save', cancelButton: 'Cancel' },
            );
            if (!name || !String(name).trim()) {
                return;
            }
            const saved = await savePromptPreset(field, name, String(textarea.value ?? ''), { confirmOverwrite: confirmPresetOverwrite });
            if (!saved) {
                return;
            }
            selectedPresets.set(field, findPromptPresetIndex(field, saved.name));
            globalThis.toastr?.success?.(`Saved prompt preset "${saved.name}".`, TOAST_TITLE);
            renderPage();
        });

        deleteButton.addEventListener('click', () => {
            const index = Number(select.value);
            const preset = getPromptPresets(field)[index];
            if (!preset) {
                return;
            }
            if (deletePromptPreset(field, index)) {
                selectedPresets.set(field, '');
                globalThis.toastr?.success?.(`Deleted prompt preset "${preset.name}".`, TOAST_TITLE);
                renderPage();
            }
        });

        row.append(select, applyButton, saveButton, deleteButton);
        return row;
    }

    /**
     * Builds a labelled select control that commits on `change`.
     *
     * @param {object} options Select options.
     * @param {string} options.ariaLabel Accessible name.
     * @param {Array<{value: string, label: string}>} options.options Option list.
     * @param {string} options.value Selected value.
     * @param {(value: string) => void} options.onChange Commit callback.
     * @returns {Element} Select element.
     */
    function buildSelect({ ariaLabel, options, value, onChange }) {
        const select = document.createElement('select');
        select.className = 'bc-task-select';
        select.setAttribute('aria-label', ariaLabel);
        for (const { value: optionValue, label } of options) {
            const option = document.createElement('option');
            option.value = optionValue;
            option.textContent = label;
            select.append(option);
        }
        select.value = value;
        select.disabled = readOnlyMode === true;
        select.addEventListener('change', () => onChange(String(select.value ?? '')));
        return select;
    }

    /**
     * Builds a checkbox row (input + text label) that commits on `change`.
     *
     * @param {object} options Checkbox options.
     * @param {string} options.label Visible label.
     * @param {boolean} options.checked Current state.
     * @param {(checked: boolean) => void} options.onChange Commit callback.
     * @returns {Element} Label element wrapping the input.
     */
    function buildCheckbox({ label, checked, onChange }) {
        const wrapper = document.createElement('label');
        wrapper.className = 'bc-task-checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked === true;
        input.setAttribute('aria-label', label);
        input.disabled = readOnlyMode === true;
        input.addEventListener('change', () => onChange(input.checked === true));
        const text = document.createElement('span');
        text.className = 'bc-task-checkbox-label';
        text.textContent = label;
        wrapper.append(input, text);
        return wrapper;
    }

    /**
     * Builds a number input that commits on `change`.
     *
     * @param {object} options Input options.
     * @param {string} options.ariaLabel Accessible name.
     * @param {number|null} options.value Current value (null/blank shown empty).
     * @param {number} options.min Minimum value.
     * @param {boolean} [options.disabled] Disabled state.
     * @param {(raw: string) => void} options.onChange Commit callback with the raw string.
     * @returns {Element} Input element.
     */
    function buildNumberInput({ ariaLabel, value, min, disabled, onChange }) {
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'bc-task-number';
        input.setAttribute('aria-label', ariaLabel);
        input.setAttribute('min', String(min));
        input.value = value === null || value === undefined ? '' : String(value);
        input.disabled = disabled === true || readOnlyMode === true;
        input.addEventListener('change', () => onChange(String(input.value ?? '')));
        return input;
    }

    /**
     * Builds a settings field row (label + control + optional hint).
     *
     * @param {string} labelText Field label.
     * @param {Element} control Control element.
     * @param {string} [hintText] Explanatory hint.
     * @returns {Element} Field row.
     */
    function buildField(labelText, control, hintText) {
        const field = document.createElement('div');
        field.className = 'bc-task-field';
        const label = document.createElement('span');
        label.className = 'bc-task-field-label';
        label.textContent = labelText;
        field.append(label, control);
        if (hintText) {
            const hint = document.createElement('span');
            hint.className = 'bc-task-field-hint';
            hint.textContent = hintText;
            field.append(hint);
        }
        return field;
    }

    /**
     * Builds one settings-drawer group (native details/summary). Open state
     * is tracked in `openGroups` and restored across rebuilds.
     *
     * @param {string} key Group key.
     * @param {string} title Summary text.
     * @param {Element[]} children Group body children.
     * @returns {Element} Details element.
     */
    function buildGroup(key, title, children) {
        const details = document.createElement('details');
        details.className = 'bc-task-settings-group';
        details.open = openGroups.has(key);
        details.addEventListener('toggle', () => {
            if (details.open) {
                openGroups.add(key);
            } else {
                openGroups.delete(key);
            }
        });
        const summary = document.createElement('summary');
        summary.className = 'bc-task-settings-summary';
        summary.textContent = title;
        const body = document.createElement('div');
        body.className = 'bc-task-settings-body';
        body.append(...children);
        details.append(summary, body);
        return details;
    }

    // ------------------------------------------------------------------
    // Prompt workspace (main prompt + explicit Save)
    // ------------------------------------------------------------------

    /**
     * Builds the main-prompt workspace.
     *
     * @returns {Element} Workspace section.
     */
    function buildMainWorkspace() {
        const main = promptOf('main');

        const section = document.createElement('section');
        section.className = 'bc-task-workspace bc-task-workspace-main';
        section.setAttribute('aria-label', 'Combine prompt');

        const title = document.createElement('h3');
        title.className = 'bc-task-workspace-title';
        title.textContent = 'Combine prompt';

        const note = document.createElement('p');
        note.className = 'bc-task-workspace-note';
        note.textContent = 'Instructions used to rewrite each source card. Saved explicitly — typing is kept as a draft until you save.';

        const saveButton = document.createElement('button');
        saveButton.type = 'button';
        saveButton.className = 'bc-task-save-prompt';
        saveButton.textContent = 'Save prompt';
        saveButton.title = SAVE_TITLE;
        saveButton.disabled = !draftValues.has(MAIN_TEXT_FIELD) || readOnlyMode === true;

        const textarea = buildTextarea({
            fieldKey: MAIN_TEXT_FIELD,
            value: main.text,
            rows: 12,
            ariaLabel: 'Combine prompt',
            className: 'bc-task-prompt-textarea',
            onCommit: null,
            onInput: () => {
                saveButton.disabled = false;
            },
        });

        const presetRow = buildPresetRow({
            field: 'main',
            label: 'combine prompt',
            textarea,
            onApplied: () => {
                // Apply committed the prompt — there is no unsaved draft anymore.
                saveButton.disabled = true;
            },
        });

        saveButton.addEventListener('click', () => {
            const text = draftValues.has(MAIN_TEXT_FIELD) ? draftValues.get(MAIN_TEXT_FIELD) : main.text;
            draftValues.delete(MAIN_TEXT_FIELD);
            applyPatch(latestActions, { prompts: { main: { text } } });
        });

        const controls = document.createElement('div');
        controls.className = 'bc-task-prompt-actions';
        controls.append(saveButton);

        section.append(title, note, textarea, presetRow, controls);
        return section;
    }

    // ------------------------------------------------------------------
    // Assistant workspace (request → suggest → diff → apply/dismiss)
    // ------------------------------------------------------------------

    /**
     * Renders the inline diff between the current prompt and the proposal
     * using `diff_match_patch` when available. Falls back to plain proposal
     * text (no diff markup) when the library is missing or fails.
     *
     * @param {string} original Current prompt text.
     * @param {string} proposal Proposed prompt text.
     * @returns {Element} Diff container.
     */
    function buildDiffView(original, proposal) {
        const container = document.createElement('div');
        container.className = 'bc-task-proposal-diff';
        container.setAttribute('aria-label', 'Proposed changes');

        const appendPlain = () => {
            const span = document.createElement('span');
            span.textContent = proposal;
            container.append(span);
        };

        const DiffMatchPatch = globalThis.diff_match_patch;
        if (typeof DiffMatchPatch !== 'function') {
            appendPlain();
            return container;
        }

        let diffs;
        try {
            const dmp = new DiffMatchPatch();
            diffs = dmp.diff_main(original, proposal);
            dmp.diff_cleanupSemantic(diffs);
        } catch (error) {
            console.error('promptSettingsPage: failed to compute the proposal diff.', error);
            appendPlain();
            return container;
        }

        for (const [operation, text] of diffs) {
            if (!text) {
                continue;
            }
            let node;
            if (operation === 1) {
                node = document.createElement('ins');
                node.className = 'bc-task-diff-ins';
            } else if (operation === -1) {
                node = document.createElement('del');
                node.className = 'bc-task-diff-del';
            } else {
                node = document.createElement('span');
            }
            node.textContent = text;
            container.append(node);
        }
        return container;
    }

    /**
     * Builds the proposal block (diff + Apply/Dismiss) for a pending
     * assistant proposal.
     *
     * @param {object} assistant Assistant record from the snapshot.
     * @param {string} proposal Proposal text.
     * @returns {Element} Proposal section.
     */
    function buildProposalBlock(assistant, proposal) {
        const section = document.createElement('section');
        section.className = 'bc-task-proposal';
        section.setAttribute('aria-label', 'Assistant proposal');

        const title = document.createElement('h4');
        title.className = 'bc-task-proposal-title';
        title.textContent = 'Proposed revision';

        const diff = buildDiffView(promptOf('main').text, proposal);

        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'bc-task-apply-proposal';
        applyButton.textContent = 'Apply';
        applyButton.title = APPLY_TITLE;
        applyButton.disabled = readOnlyMode === true;
        applyButton.addEventListener('click', () => {
            applyPatch(latestActions, {
                prompts: {
                    main: {
                        text: proposal,
                        assistant: { ...assistant, applied: true },
                    },
                },
            });
        });

        const dismissButton = document.createElement('button');
        dismissButton.type = 'button';
        dismissButton.className = 'bc-task-dismiss-proposal';
        dismissButton.textContent = 'Dismiss';
        dismissButton.title = DISMISS_TITLE;
        dismissButton.disabled = readOnlyMode === true;
        dismissButton.addEventListener('click', () => {
            draftValues.delete(ASSIST_REQUEST_FIELD);
            applyPatch(latestActions, {
                prompts: {
                    main: {
                        assistant: { request: '', proposal: '', diff: '', applied: false, error: '' },
                    },
                },
            });
        });

        const actions = document.createElement('div');
        actions.className = 'bc-task-proposal-actions';
        actions.append(applyButton, dismissButton);

        section.append(title, diff, actions);
        return section;
    }

    /**
     * Starts a background prompt-assist run. The proposal arrives through
     * later snapshot re-renders; the page only tracks its in-flight flag.
     * Launch failures are surfaced inline (never console-only).
     *
     * @returns {void}
     */
    function startAssist() {
        const request = effectiveAssistRequest().trim();
        if (!request || assistWaiting()) {
            return;
        }
        assistInFlight = true;
        assistLaunchError = '';
        let result;
        try {
            result = latestActions?.runPromptAssist?.('main', {
                request,
                completionSettings: resolvedCompletion(),
            });
        } catch (error) {
            assistInFlight = false;
            assistLaunchError = String(error?.message ?? error) || 'Failed to start the prompt assist.';
            console.error('promptSettingsPage: failed to start the prompt assist.', error);
            renderPage();
            return;
        }
        Promise.resolve(result).catch((error) => {
            assistInFlight = false;
            assistLaunchError = String(error?.message ?? error) || 'Failed to start the prompt assist.';
            console.error('promptSettingsPage: failed to start the prompt assist.', error);
            renderPage();
        });
        // Re-render from the latest snapshot to surface the in-flight state.
        renderPage();
    }

    /**
     * Builds the assistant workspace (request, suggest, status/error,
     * proposal).
     *
     * @returns {Element} Workspace section.
     */
    function buildAssistWorkspace() {
        const assistant = promptOf('main').assistant;
        const proposal = stringOf(assistant.proposal);
        const error = stringOf(assistant.error);
        const waiting = assistWaiting();

        const section = document.createElement('section');
        section.className = 'bc-task-workspace bc-task-workspace-assist';
        section.setAttribute('aria-label', 'Prompt assistant');

        const title = document.createElement('h3');
        title.className = 'bc-task-workspace-title';
        title.textContent = 'Assistant request';

        const note = document.createElement('p');
        note.className = 'bc-task-workspace-note';
        note.textContent = 'Describe how the assistant should revise the combine prompt. The proposal shows up here as a diff you can apply or dismiss.';

        const suggestButton = document.createElement('button');
        suggestButton.type = 'button';
        suggestButton.className = 'bc-task-suggest';
        suggestButton.textContent = 'Suggest revision';
        suggestButton.title = SUGGEST_TITLE;
        suggestButton.disabled = waiting || readOnlyMode === true || effectiveAssistRequest().trim().length === 0;
        suggestButton.addEventListener('click', startAssist);

        const requestArea = buildTextarea({
            fieldKey: ASSIST_REQUEST_FIELD,
            value: stringOf(assistant.request),
            rows: 5,
            ariaLabel: 'Assistant request',
            className: 'bc-task-assist-textarea',
            onCommit: (text) => {
                applyPatch(latestActions, { prompts: { main: { assistant: { request: text } } } });
            },
            onInput: () => {
                suggestButton.disabled = waiting || readOnlyMode === true || String(requestArea.value ?? '').trim().length === 0;
            },
        });

        const controls = document.createElement('div');
        controls.className = 'bc-task-assist-actions';
        controls.append(suggestButton);

        section.append(title, note, requestArea, controls);

        if (assistLaunchError) {
            const launchError = document.createElement('p');
            launchError.className = 'bc-task-assist-error';
            launchError.setAttribute('role', 'alert');
            launchError.textContent = `Prompt assist could not start: ${assistLaunchError}`;
            section.append(launchError);
        }

        if (waiting) {
            const status = document.createElement('p');
            status.className = 'bc-task-assist-status';
            status.setAttribute('role', 'status');
            status.textContent = ASSIST_IN_FLIGHT_TEXT;
            section.append(status);

            // A durable pending request (e.g. the server never finished) can
            // be discarded so Suggest becomes available again.
            if (!assistInFlight && !readOnlyMode) {
                const discard = document.createElement('button');
                discard.type = 'button';
                discard.className = 'bc-task-discard-request';
                discard.textContent = 'Discard request';
                discard.title = DISCARD_REQUEST_TITLE;
                discard.addEventListener('click', () => {
                    draftValues.delete(ASSIST_REQUEST_FIELD);
                    assistLaunchError = '';
                    applyPatch(latestActions, {
                        prompts: {
                            main: {
                                assistant: { request: '', proposal: '', diff: '', applied: false, error: '' },
                            },
                        },
                    });
                });
                section.append(discard);
            }
        }

        if (error) {
            const errorBlock = document.createElement('p');
            errorBlock.className = 'bc-task-assist-error';
            errorBlock.setAttribute('role', 'alert');
            errorBlock.textContent = error;
            section.append(errorBlock);
        }

        if (proposal && assistant.applied !== true) {
            section.append(buildProposalBlock(assistant, proposal));
        }

        return section;
    }

    // ------------------------------------------------------------------
    // Settings drawer groups
    // ------------------------------------------------------------------

    /**
     * Lists chat-completion-capable connection profiles (text-generation
     * profiles cannot drive the chat-completions backend).
     *
     * @returns {object[]} Profile records.
     */
    function connectionProfiles() {
        const profiles = extension_settings?.connectionManager?.profiles;
        if (!Array.isArray(profiles)) {
            return [];
        }
        return profiles.filter((profile) => resolveApiEntry(profile?.api, CONNECT_API_MAP)?.selected === 'openai');
    }

    /**
     * Lists Chat Completion preset names (from `openai_setting_names`).
     *
     * @returns {string[]} Preset names.
     */
    function chatCompletionPresetNames() {
        if (!openai_setting_names || typeof openai_setting_names !== 'object' || !Array.isArray(openai_settings)) {
            return [];
        }
        return Object.keys(openai_setting_names);
    }

    /**
     * Builds the resolved-settings readout line for the Connection group.
     *
     * @returns {Element} Readout element.
     */
    function buildResolvedReadout() {
        const resolved = resolvedCompletion();
        const parts = [];
        if (resolved.model) {
            parts.push(`Model: ${resolved.model}`);
        }
        if (resolved.chat_completion_source) {
            parts.push(`Source: ${resolved.chat_completion_source}`);
        }
        if (resolved.max_context) {
            parts.push(`Context: ${resolved.max_context}`);
        }
        if (resolved.max_tokens) {
            parts.push(`Max output: ${resolved.max_tokens}`);
        }
        const readout = document.createElement('p');
        readout.className = 'bc-task-resolved-readout';
        readout.textContent = parts.length > 0 ? parts.join(' · ') : UNRESOLVED_READOUT;
        return readout;
    }

    /**
     * Builds the Connection group (profile, preset, resolved readout).
     *
     * @returns {Element} Settings group.
     */
    function buildConnectionGroup() {
        const settings = settingsOf();

        const profileSelect = buildSelect({
            ariaLabel: 'Connection profile',
            options: [
                { value: '', label: 'No profile (use a preset)' },
                ...connectionProfiles().map((profile) => ({
                    value: stringOf(profile?.id),
                    label: stringOf(profile?.name) || 'Unnamed profile',
                })),
            ],
            value: stringOf(settings.connectionProfile),
            onChange: (value) => patchSettings('connectionProfile', value || null),
        });

        const presetSelect = buildSelect({
            ariaLabel: 'Chat completion preset',
            options: [
                { value: '', label: 'No preset' },
                ...chatCompletionPresetNames().map((name) => ({ value: name, label: name })),
            ],
            value: stringOf(settings.preset),
            onChange: (value) => patchSettings('preset', value || null),
        });

        return buildGroup('connection', 'Connection', [
            buildField('Connection profile', profileSelect, 'Wins over the preset: model, source, and credentials come from the profile.'),
            buildField('Chat completion preset', presetSelect, 'Provides the model, sampling, and token windows the overrides below inherit from.'),
            buildResolvedReadout(),
        ]);
    }

    /**
     * Parses a token-window input: blank/0/invalid → null (inherit).
     *
     * @param {string} raw Raw input string.
     * @returns {number|null} Positive integer, or null.
     */
    function parseTokenWindow(raw) {
        const number = Number(raw);
        return Number.isFinite(number) && number > 0 ? Math.trunc(number) : null;
    }

    /**
     * Builds the Windows group (context/output token windows).
     *
     * @returns {Element} Settings group.
     */
    function buildWindowsGroup() {
        const settings = settingsOf();

        const contextInput = buildNumberInput({
            ariaLabel: 'Total context tokens',
            value: Number.isSafeInteger(settings.totalContextTokens) ? settings.totalContextTokens : null,
            min: 0,
            onChange: (raw) => patchSettings('totalContextTokens', parseTokenWindow(raw)),
        });

        const outputInput = buildNumberInput({
            ariaLabel: 'Output tokens',
            value: Number.isSafeInteger(settings.outputTokens) ? settings.outputTokens : null,
            min: 0,
            onChange: (raw) => patchSettings('outputTokens', parseTokenWindow(raw)),
        });

        return buildGroup('windows', 'Windows', [
            buildField('Total context tokens', contextInput, 'Empty or 0 inherits the preset context window.'),
            buildField('Output tokens', outputInput, 'Empty or 0 inherits the preset output length (max_tokens).'),
        ]);
    }

    /**
     * Builds one processing-mode radio option (title + explanation).
     *
     * @param {object} options Radio options.
     * @param {string} options.value Mode value.
     * @param {string} options.title Mode title.
     * @param {string} options.description Short explanation.
     * @param {boolean} options.checked Current selection.
     * @returns {Element} Label element wrapping the radio.
     */
    function buildModeOption({ value, title, description, checked }) {
        const wrapper = document.createElement('label');
        wrapper.className = 'bc-task-mode-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = 'bc-task-processing-mode';
        input.value = value;
        input.checked = checked === true;
        input.setAttribute('aria-label', title);
        input.addEventListener('change', () => patchSettings('mode', value));
        const text = document.createElement('span');
        text.className = 'bc-task-mode-text';
        const name = document.createElement('span');
        name.className = 'bc-task-mode-title';
        name.textContent = title;
        const detail = document.createElement('span');
        detail.className = 'bc-task-mode-description';
        detail.textContent = description;
        text.append(name, detail);
        wrapper.append(input, text);
        return wrapper;
    }

    /**
     * Builds the Processing group (mode radios + concurrency).
     *
     * @returns {Element} Settings group.
     */
    function buildProcessingGroup() {
        const settings = settingsOf();
        const mode = settings.mode === 'combined' ? 'combined' : 'individual';

        const concurrencyInput = buildNumberInput({
            ariaLabel: 'Concurrency',
            value: Number.isSafeInteger(settings.concurrency) ? settings.concurrency : 1,
            min: 1,
            disabled: mode !== 'individual',
            onChange: (raw) => {
                const number = Number(raw);
                if (Number.isSafeInteger(number) && number >= 1) {
                    patchSettings('concurrency', number);
                }
            },
        });
        if (concurrencyInput.disabled) {
            concurrencyInput.title = 'Concurrency only applies to individual mode.';
        }

        return buildGroup('processing', 'Processing', [
            buildModeOption({
                value: 'individual',
                title: 'Individual',
                description: 'Generate each card in its own request, then merge the results.',
                checked: mode === 'individual',
            }),
            buildModeOption({
                value: 'combined',
                title: 'Combined',
                description: 'Generate all cards together in a single request.',
                checked: mode === 'combined',
            }),
            buildField('Concurrency', concurrencyInput, 'Parallel requests in individual mode.'),
        ]);
    }

    /**
     * Builds the Output / Lorebook group (destination + XML options).
     *
     * @returns {Element} Settings group.
     */
    function buildOutputGroup() {
        const settings = settingsOf();
        const destination = settings.destination === 'lorebook' ? 'lorebook' : 'card';

        const destinationSelect = buildSelect({
            ariaLabel: 'Output destination',
            options: [
                { value: 'card', label: 'Character card' },
                { value: 'lorebook', label: 'Lorebook' },
            ],
            value: destination,
            onChange: (value) => patchSettings('destination', value === 'lorebook' ? 'lorebook' : 'card'),
        });

        return buildGroup('output', 'Output / Lorebook', [
            buildField('Destination', destinationSelect, 'Lorebook output adds a summary pass over the combined cards.'),
            buildCheckbox({
                label: 'XML tagging',
                checked: settings.xmlEnabled === true,
                onChange: (checked) => patchSettings('xmlEnabled', checked),
            }),
            buildCheckbox({
                label: 'Minify XML',
                checked: settings.xmlMinify === true,
                onChange: (checked) => patchSettings('xmlMinify', checked),
            }),
        ]);
    }

    /**
     * Wraps a prompt textarea with its label and a preset row in a hidable
     * row.
     *
     * @param {object} options Row options.
     * @param {string} options.label Row label.
     * @param {string} options.promptKey Prompt key (`secondPass`, `summary`, `post`).
     * @param {number} options.rows Visible row count.
     * @param {boolean} options.visible Whether the row is shown.
     * @param {string} [options.hintText] Explanatory hint.
     * @returns {Element} Row element.
     */
    function buildPromptRow({ label, promptKey, rows, visible, hintText }) {
        const textarea = buildTextarea({
            fieldKey: `prompt:${promptKey}:text`,
            value: promptOf(promptKey).text,
            rows,
            ariaLabel: label,
            className: 'bc-task-pass-textarea',
            onCommit: (text) => patchPromptText(promptKey, text),
        });
        const presetRow = buildPresetRow({ field: promptKey, label: label.toLowerCase(), textarea });
        const row = document.createElement('div');
        row.className = 'bc-task-field bc-task-pass-row';
        const labelElement = document.createElement('span');
        labelElement.className = 'bc-task-field-label';
        labelElement.textContent = label;
        row.append(labelElement, textarea, presetRow);
        if (hintText) {
            const hint = document.createElement('span');
            hint.className = 'bc-task-field-hint';
            hint.textContent = hintText;
            row.append(hint);
        }
        row.hidden = !visible;
        return row;
    }

    /**
     * Builds the Optional Passes group (second pass, post-processing,
     * lorebook summary).
     *
     * @returns {Element} Settings group.
     */
    function buildPassesGroup() {
        const settings = settingsOf();
        const secondPassEnabled = settings.secondPassEnabled === true;
        const postProcessingEnabled = settings.postProcessingEnabled === true;
        const lorebookDestination = settings.destination === 'lorebook';

        const secondPassToggle = buildCheckbox({
            label: 'Second pass',
            checked: secondPassEnabled,
            onChange: (checked) => patchSettings('secondPassEnabled', checked),
        });

        const secondPassRow = buildPromptRow({
            label: 'Second-pass instructions',
            promptKey: 'secondPass',
            rows: 4,
            visible: secondPassEnabled,
            hintText: 'A refinement pass over each first-pass result.',
        });

        const postToggle = buildCheckbox({
            label: 'Post-processing',
            checked: postProcessingEnabled,
            onChange: (checked) => patchSettings('postProcessingEnabled', checked),
        });

        const modeSelect = buildSelect({
            ariaLabel: 'Post-processing mode',
            options: [
                { value: 'replace', label: 'Replace' },
                { value: 'prepend', label: 'Prepend' },
                { value: 'append', label: 'Append' },
            ],
            value: ['replace', 'prepend', 'append'].includes(settings.postProcessingMode) ? settings.postProcessingMode : 'replace',
            onChange: (value) => patchSettings('postProcessingMode', value),
        });
        const modeRow = buildField('Post-processing mode', modeSelect);
        modeRow.hidden = !postProcessingEnabled;

        const postRow = buildPromptRow({
            label: 'Post-processing prompt',
            promptKey: 'post',
            rows: 4,
            visible: postProcessingEnabled,
        });

        const summaryRow = buildPromptRow({
            label: 'Summary prompt',
            promptKey: 'summary',
            rows: 4,
            visible: lorebookDestination,
            hintText: 'Summarizes the combined cards into a lorebook entry.',
        });

        return buildGroup('passes', 'Optional Passes', [
            secondPassToggle,
            secondPassRow,
            postToggle,
            modeRow,
            postRow,
            summaryRow,
        ]);
    }

    /**
     * Builds the settings drawer (all groups).
     *
     * @returns {Element} Settings section.
     */
    function buildSettings() {
        const section = document.createElement('section');
        section.className = 'bc-task-settings';
        section.setAttribute('aria-label', 'Generation settings');

        const title = document.createElement('h3');
        title.className = 'bc-task-settings-title';
        title.textContent = 'Settings';

        const note = document.createElement('p');
        note.className = 'bc-task-settings-note';
        note.textContent = 'Saved as you change them. Connection and windows decide how generation calls are made; passes shape the output.';

        section.append(
            title,
            note,
            buildConnectionGroup(),
            buildWindowsGroup(),
            buildProcessingGroup(),
            buildOutputGroup(),
            buildPassesGroup(),
        );
        return section;
    }

    // ------------------------------------------------------------------
    // Footer (Continue to Transform 1)
    // ------------------------------------------------------------------

    /**
     * Builds the footer with a validated Continue button: enabled when the
     * main prompt has text (an unsaved draft counts — it is committed
     * first), and always allowed for a completed task (pure navigation).
     *
     * @returns {Element} Footer element.
     */
    function buildFooter() {
        const savedText = promptOf('main').text;
        const draftText = draftValues.has(MAIN_TEXT_FIELD) ? draftValues.get(MAIN_TEXT_FIELD) : null;
        const effectiveText = (draftText ?? savedText).trim();
        const hasText = effectiveText.length > 0;
        const hasUnsavedDraft = draftText !== null && draftText !== savedText;

        const footer = document.createElement('footer');
        footer.className = 'bc-task-prompt-footer';

        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.className = 'bc-task-continue';
        continueButton.textContent = 'Continue to Transform 1';
        continueButton.disabled = !hasText;
        continueButton.title = !hasText
            ? CONTINUE_EMPTY_TITLE
            : (hasUnsavedDraft && !readOnlyMode ? CONTINUE_SAVE_TITLE : CONTINUE_TITLE);
        continueButton.addEventListener('click', () => {
            void (async () => {
                // Commit an unsaved prompt draft first so Transform 1 runs
                // against the text the user actually sees.
                if (!readOnlyMode && draftValues.has(MAIN_TEXT_FIELD)) {
                    const text = draftValues.get(MAIN_TEXT_FIELD);
                    draftValues.delete(MAIN_TEXT_FIELD);
                    await applyPatch(latestActions, { prompts: { main: { text } } });
                }
                latestActions?.goToPage?.(3);
            })();
        });
        footer.append(continueButton);
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
        readOnlyMode = latestSnapshot?.task?.status === 'completed';

        const assistant = promptOf('main').assistant;
        // The assist run is done (or abandoned) once a proposal/error lands
        // or the request is cleared; the launch window hands off to the
        // durable snapshot-derived waiting state.
        if (assistInFlight && (stringOf(assistant.proposal) || stringOf(assistant.error) || !effectiveAssistRequest().trim() || assistWaitingFromSnapshot())) {
            assistInFlight = false;
        }
        if (!assistWaitingFromSnapshot()) {
            // The server-side assist cycle settled (proposal/error/dismiss):
            // any stale launch error is superseded by the snapshot state.
            if (stringOf(assistant.proposal) || stringOf(assistant.error)) {
                assistLaunchError = '';
            }
        }

        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        const activeKey = activeElement?.getAttribute?.('data-field-key') ?? null;
        const selectionStart = typeof activeElement?.selectionStart === 'number' ? activeElement.selectionStart : null;
        const selectionEnd = typeof activeElement?.selectionEnd === 'number' ? activeElement.selectionEnd : null;
        fieldRefs = new Map();

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-prompt-settings';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = 'Prompt & Settings';

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'Edit the combine prompt, optionally let the assistant propose a revision, and choose how generation connects and runs. Settings save as you change them.';

        const workspaces = document.createElement('div');
        workspaces.className = 'bc-task-prompt-workspaces';
        workspaces.append(buildMainWorkspace(), buildAssistWorkspace());

        root.append(heading, guidance);
        if (readOnlyMode) {
            const readOnly = document.createElement('p');
            readOnly.className = 'bc-task-readonly-note';
            readOnly.setAttribute('role', 'status');
            readOnly.textContent = READ_ONLY_NOTE;
            root.append(readOnly);
        }
        root.append(workspaces, buildSettings(), buildFooter());
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
        key: 'prompt',
        title: 'Prompt & Settings',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call, and all listeners live on the
         * replaced elements (never on the container or external targets).
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
            draftValues.clear();
            selectedPresets.clear();
            openGroups.clear();
            openGroups.add('connection');
            assistInFlight = false;
            assistLaunchError = '';
            readOnlyMode = false;
            fieldRefs = new Map();
        },
    };
}
