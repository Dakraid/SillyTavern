'use strict';

/**
 * @file Prompt-preset store for the durable Bulk Combine task wizard.
 *
 * Replaces the legacy `PresetManager.js` (deleted in Step 13b). Presets are
 * prompt-only (`{ name, prompt }`) and live in a NEW store,
 * `power_user.bulk_combine_task_prompt_presets`, keyed by prompt field:
 * `{ main: [...], secondPass: [...], summary: [...], post: [...] }`
 * (mirrors `task.prompts` fields).
 *
 * The two legacy preset lists
 * (`power_user.group_card_combine_prompt_presets` → `main`,
 * `power_user.group_card_post_merge_prompt_presets` → `post`) are converted
 * ONE-WAY by `migrateLegacyPromptPresets()`: merged into the new store
 * without clobbering existing entries, then the legacy keys are deleted and
 * a migrated flag is set. The legacy keys are never read again afterwards;
 * the migration runs lazily on first preset access.
 *
 * Node-safe: the only browser imports are `saveSettingsDebounced`
 * (`script.js`) and `power_user` (`power-user.js`).
 */

import { saveSettingsDebounced } from '../../../script.js';
import { power_user } from '../../power-user.js';

/** @type {string} `power_user` key holding the new preset store. */
const STORE_KEY = 'bulk_combine_task_prompt_presets';
/** @type {string} `power_user` key flagging the legacy migration as done. */
const MIGRATED_KEY = 'bulk_combine_task_prompt_presets_migrated';
/** @type {string} Legacy `power_user` key: Stage 1 combine prompt presets. */
const LEGACY_COMBINE_KEY = 'group_card_combine_prompt_presets';
/** @type {string} Legacy `power_user` key: Stage 3 post-merge prompt presets. */
const LEGACY_POST_MERGE_KEY = 'group_card_post_merge_prompt_presets';

/** @type {string[]} Canonical prompt fields (mirrors `task.prompts`). */
const PROMPT_FIELDS = ['main', 'secondPass', 'summary', 'post'];

/** @type {string} Toastr title for preset feedback. */
const TOAST_TITLE = 'Combine into Group Card';

/**
 * Normalizes a preset name for duplicate checks (trimmed lowercase).
 *
 * @param {unknown} name Name to normalize.
 * @returns {string} Normalized name.
 */
function normalizePresetName(name) {
    return String(name ?? '').trim().toLowerCase();
}

/**
 * Reads a record defensively (null/array/non-object → null).
 *
 * @param {unknown} value Candidate.
 * @returns {object|null} Record, or null.
 */
function recordOrNull(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Ensures the store exists with all canonical field arrays, without
 * clobbering any already-persisted entries.
 *
 * @returns {object} The preset store record.
 */
function ensureStore() {
    if (recordOrNull(power_user[STORE_KEY]) === null) {
        power_user[STORE_KEY] = {};
    }
    const store = power_user[STORE_KEY];
    for (const field of PROMPT_FIELDS) {
        if (!Array.isArray(store[field])) {
            store[field] = [];
        }
    }
    return store;
}

/**
 * Merges one legacy preset list into a target field list. Existing new-store
 * entries win on name collisions (case-insensitive); malformed entries
 * (non-objects, empty names) are skipped.
 *
 * @param {Array<{name: string, prompt: string}>} target Target field list.
 * @param {unknown} legacyList Legacy preset list candidate.
 * @returns {void}
 */
function mergeLegacyList(target, legacyList) {
    if (!Array.isArray(legacyList)) {
        return;
    }
    for (const entry of legacyList) {
        const name = String(entry?.name ?? '').trim();
        if (!name) {
            continue;
        }
        const normalized = normalizePresetName(name);
        if (target.some((preset) => normalizePresetName(preset?.name) === normalized)) {
            continue;
        }
        target.push({ name, prompt: String(entry?.prompt ?? '') });
    }
}

/**
 * One-way, idempotent migration of the legacy prompt presets into the new
 * store. Runs at most once (guarded by the migrated flag): legacy combine
 * presets map to `main`, legacy post-merge presets map to `post`, and the
 * two legacy keys are deleted after the copy. `secondPass`/`summary` have
 * no legacy source and stay empty.
 *
 * @returns {boolean} True when the migration ran, false when already migrated.
 */
export function migrateLegacyPromptPresets() {
    if (power_user[MIGRATED_KEY] === true) {
        return false;
    }
    const store = ensureStore();
    mergeLegacyList(store.main, power_user[LEGACY_COMBINE_KEY]);
    mergeLegacyList(store.post, power_user[LEGACY_POST_MERGE_KEY]);
    delete power_user[LEGACY_COMBINE_KEY];
    delete power_user[LEGACY_POST_MERGE_KEY];
    power_user[MIGRATED_KEY] = true;
    saveSettingsDebounced();
    return true;
}

/**
 * Returns the preset list for a field, running the lazy one-way legacy
 * migration on first access and lazily creating the field array.
 *
 * @param {string} field Prompt field (`main`, `secondPass`, `summary`, `post`).
 * @returns {Array<{name: string, prompt: string}>} Preset list (live reference).
 */
function presetsFor(field) {
    migrateLegacyPromptPresets();
    const store = ensureStore();
    const key = String(field ?? '');
    if (!Array.isArray(store[key])) {
        store[key] = [];
    }
    return store[key];
}

/**
 * Gets the prompt presets for a field.
 *
 * @param {string} field Prompt field.
 * @returns {Array<{name: string, prompt: string}>} Preset list.
 */
export function getPromptPresets(field) {
    return presetsFor(field);
}

/**
 * Finds a prompt preset by name (case-insensitive).
 *
 * @param {string} field Prompt field.
 * @param {string} name Preset name.
 * @returns {number} Preset index, or -1.
 */
export function findPromptPresetIndex(field, name) {
    const normalized = normalizePresetName(name);
    if (!normalized) {
        return -1;
    }
    return presetsFor(field).findIndex((preset) => normalizePresetName(preset?.name) === normalized);
}

/**
 * Saves a named prompt preset for a field, overwriting an existing preset
 * with the same name. On an overwrite collision the injected
 * `confirmOverwrite(name)` is awaited and the save is cancelled unless it
 * resolves `true` (the legacy confirm-overwrite idiom, kept out of the
 * store so the module stays Node-safe). When no `confirmOverwrite` is
 * provided the overwrite proceeds directly (plain store semantics).
 *
 * @param {string} field Prompt field.
 * @param {string} name Preset name.
 * @param {string} prompt Preset prompt.
 * @param {object} [options] Save dependencies.
 * @param {(name: string) => (boolean|Promise<boolean>)} [options.confirmOverwrite] Overwrite confirmation.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @returns {Promise<{name: string, prompt: string}|null>} Saved preset, or null when cancelled.
 */
export async function savePromptPreset(field, name, prompt, { confirmOverwrite, toaster = globalThis.toastr } = {}) {
    const trimmedName = String(name ?? '').trim();
    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', TOAST_TITLE);
        return null;
    }

    const presets = presetsFor(field);
    const normalized = normalizePresetName(trimmedName);
    const existingIndex = presets.findIndex((preset) => normalizePresetName(preset?.name) === normalized);
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        if (typeof confirmOverwrite === 'function') {
            const overwrite = await confirmOverwrite(trimmedName);
            if (overwrite !== true) {
                return null;
            }
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
 * @param {string} field Prompt field.
 * @param {number} index Preset index.
 * @returns {boolean} True if deleted.
 */
export function deletePromptPreset(field, index) {
    const presets = presetsFor(field);

    if (!Number.isInteger(index) || index < 0 || index >= presets.length) {
        return false;
    }

    presets.splice(index, 1);
    saveSettingsDebounced();
    return true;
}
