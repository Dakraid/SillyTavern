'use strict';

/**
 * @file Combine + post-merge prompt preset management.
 *
 * Persists user prompt presets for the Stage 1 combine prompt and the
 * Stage 3 post-merge prompt. Each preset set supports lookup, save, delete,
 * and rendering into a `<select>` dropdown. Presets are prompt-only (not full
 * config) to match current behavior.
 */

import { saveSettingsDebounced } from '../../../script.js';
import { power_user } from '../../power-user.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { escapeHtml } from '../../utils.js';
import { normalizeName } from '../helpers.js';

/**
 * Gets persisted group-card combine prompt presets.
 *
 * @returns {Array<{ name: string, prompt: string }>} Prompt presets.
 */
export function getGroupCardCombinePromptPresets() {
    if (!Array.isArray(power_user.group_card_combine_prompt_presets)) {
        power_user.group_card_combine_prompt_presets = [];
    }

    return power_user.group_card_combine_prompt_presets;
}

/**
 * Finds a prompt preset by name.
 *
 * @param {string} name Preset name.
 * @param {Array<{ name: string, prompt: string }>} [presets] Prompt presets.
 * @returns {number} Preset index, or -1.
 */
export function findGroupCardCombinePromptPresetIndex(
    name,
    presets = getGroupCardCombinePromptPresets(),
) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return -1;
    }

    return presets.findIndex(
        (preset) => normalizeName(preset?.name) === normalizedName,
    );
}

/**
 * Saves a named prompt preset, optionally overwriting an existing preset.
 *
 * @param {string} name Preset name.
 * @param {string} prompt Preset prompt.
 * @param {object} [options] Save dependencies.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @returns {Promise<{ name: string, prompt: string }|null>} Saved preset, or null when cancelled.
 */
export async function saveGroupCardCombinePromptPreset(
    name,
    prompt,
    { toaster = globalThis.toastr } = {},
) {
    const trimmedName = String(name ?? '').trim();

    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', 'Combine into Group Card');
        return null;
    }

    const presets = getGroupCardCombinePromptPresets();
    const existingIndex = findGroupCardCombinePromptPresetIndex(
        trimmedName,
        presets,
    );
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        const overwrite = await callGenericPopup(
            `Overwrite prompt preset "${escapeHtml(trimmedName)}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: 'Overwrite',
                cancelButton: 'Cancel',
            },
        );

        if (overwrite !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }

        presets[existingIndex] = savedPreset;
    } else {
        presets.push(savedPreset);
    }

    saveSettingsDebounced();
    return savedPreset;
}

/**
 * Deletes a prompt preset by index.
 *
 * @param {number} presetIndex Preset index.
 * @returns {boolean} True if deleted.
 */
export function deleteGroupCardCombinePromptPreset(presetIndex) {
    const presets = getGroupCardCombinePromptPresets();

    if (
        !Number.isInteger(presetIndex) ||
		presetIndex < 0 ||
		presetIndex >= presets.length
    ) {
        return false;
    }

    presets.splice(presetIndex, 1);
    saveSettingsDebounced();
    return true;
}

/**
 * Populates the combine prompt preset selector.
 *
 * @param {JQuery<HTMLElement>} presetSelect Preset select element.
 * @param {number|string} [selectedIndex] Selected preset index.
 */
export function renderGroupCardCombinePromptPresetSelect(
    presetSelect,
    selectedIndex = '',
) {
    const presets = getGroupCardCombinePromptPresets();
    presetSelect.empty();
    presetSelect.append($('<option></option>').val('').text('— Load preset —'));

    presets.forEach((preset, index) => {
        presetSelect.append(
            $('<option></option>').val(String(index)).text(preset.name),
        );
    });

    presetSelect.val(selectedIndex === '' ? '' : String(selectedIndex));
}

/**
 * Gets persisted group-card post-merge prompt presets.
 *
 * @returns {Array<{ name: string, prompt: string }>} Prompt presets.
 */
export function getGroupCardPostMergePromptPresets() {
    if (!Array.isArray(power_user.group_card_post_merge_prompt_presets)) {
        power_user.group_card_post_merge_prompt_presets = [];
    }

    return power_user.group_card_post_merge_prompt_presets;
}

/**
 * Finds a post-merge prompt preset by name.
 *
 * @param {string} name Preset name.
 * @param {Array<{ name: string, prompt: string }>} [presets] Prompt presets.
 * @returns {number} Preset index, or -1.
 */
export function findGroupCardPostMergePromptPresetIndex(
    name,
    presets = getGroupCardPostMergePromptPresets(),
) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return -1;
    }

    return presets.findIndex(
        (preset) => normalizeName(preset?.name) === normalizedName,
    );
}

/**
 * Saves a named post-merge prompt preset, optionally overwriting an existing preset.
 *
 * @param {string} name Preset name.
 * @param {string} prompt Preset prompt.
 * @param {object} [options] Save dependencies.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @returns {Promise<{ name: string, prompt: string }|null>} Saved preset, or null when cancelled.
 */
export async function saveGroupCardPostMergePromptPreset(
    name,
    prompt,
    { toaster = globalThis.toastr } = {},
) {
    const trimmedName = String(name ?? '').trim();

    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', 'Combine into Group Card');
        return null;
    }

    const presets = getGroupCardPostMergePromptPresets();
    const existingIndex = findGroupCardPostMergePromptPresetIndex(
        trimmedName,
        presets,
    );
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        const overwrite = await callGenericPopup(
            `Overwrite prompt preset "${escapeHtml(trimmedName)}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: 'Overwrite',
                cancelButton: 'Cancel',
            },
        );

        if (overwrite !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }

        presets[existingIndex] = savedPreset;
    } else {
        presets.push(savedPreset);
    }

    saveSettingsDebounced();
    return savedPreset;
}

/**
 * Deletes a post-merge prompt preset by index.
 *
 * @param {number} presetIndex Preset index.
 * @returns {boolean} True if deleted.
 */
export function deleteGroupCardPostMergePromptPreset(presetIndex) {
    const presets = getGroupCardPostMergePromptPresets();

    if (
        !Number.isInteger(presetIndex) ||
		presetIndex < 0 ||
		presetIndex >= presets.length
    ) {
        return false;
    }

    presets.splice(presetIndex, 1);
    saveSettingsDebounced();
    return true;
}

/**
 * Populates the post-merge prompt preset selector.
 *
 * @param {JQuery<HTMLElement>} presetSelect Preset select element.
 * @param {number|string} [selectedIndex] Selected preset index.
 */
export function renderGroupCardPostMergePromptPresetSelect(
    presetSelect,
    selectedIndex = '',
) {
    const presets = getGroupCardPostMergePromptPresets();
    presetSelect.empty();
    presetSelect.append($('<option></option>').val('').text('— Load preset —'));

    presets.forEach((preset, index) => {
        presetSelect.append(
            $('<option></option>').val(String(index)).text(preset.name),
        );
    });

    presetSelect.val(selectedIndex === '' ? '' : String(selectedIndex));
}
