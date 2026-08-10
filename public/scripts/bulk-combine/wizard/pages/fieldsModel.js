'use strict';

/**
 * @file Shared model for the adjustable captured-fields feature: the four
 * optional core fields a combine pass may capture per source card
 * (`name` + `description` are always captured implicitly and are not
 * listed here).
 *
 * Task contract (see SPEC
 * `2026-08-10_10-32-SPEC-bulk-combine-field-capture-scroll-refusal-retry-xml-minify.md`):
 * `task.settings.fields` is a string-array subset of the optional keys
 * (absent on legacy tasks → all four); `task.sourceFields[sourceKey]` is
 * a per-card override array (absent/non-array → inherit the task
 * default). Both wizard pages rendering these controls share this module
 * so labels, canonical order, and inherit semantics stay identical.
 */

/**
 * The optional capturable fields in canonical order.
 *
 * @type {ReadonlyArray<Readonly<{key: string, label: string}>>}
 */
export const CAPTURABLE_FIELDS = Object.freeze([
    Object.freeze({ key: 'personality', label: 'Personality' }),
    Object.freeze({ key: 'scenario', label: 'Scenario' }),
    Object.freeze({ key: 'first_mes', label: 'First message' }),
    Object.freeze({ key: 'mes_example', label: 'Example messages' }),
]);

/**
 * All four optional keys in canonical order (the default/legacy selection).
 *
 * @type {ReadonlyArray<string>}
 */
export const ALL_CAPTURABLE_KEYS = Object.freeze(CAPTURABLE_FIELDS.map(({ key }) => key));

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
 * Resolves the effective optional selection for a raw fields value:
 * non-array (absent/legacy/invalid) → all four; array → its members in
 * canonical order (junk keys dropped, duplicates removed).
 *
 * @param {unknown} raw Raw fields value (`settings.fields` or an override).
 * @returns {string[]} Effective optional keys in canonical order.
 */
export function effectiveOptionalFields(raw) {
    if (!Array.isArray(raw)) {
        return [...ALL_CAPTURABLE_KEYS];
    }
    const selected = new Set(raw);
    return ALL_CAPTURABLE_KEYS.filter((key) => selected.has(key));
}

/**
 * Reads the per-card override for a source key.
 *
 * @param {object} [task] Task record.
 * @param {string} sourceKey Source key.
 * @returns {string[]|null} The stored override array, or null when the card
 * inherits the task default (absent/non-array entry).
 */
export function sourceFieldsOverride(task, sourceKey) {
    const override = recordOf(task?.sourceFields)[sourceKey];
    return Array.isArray(override) ? override : null;
}

/**
 * Resolves a card's effective selection: the override wins; otherwise the
 * task default (`settings.fields`, itself defaulting to all four).
 *
 * @param {object} [task] Task record.
 * @param {string} sourceKey Source key.
 * @returns {string[]} Effective optional keys in canonical order.
 */
export function effectiveSourceFields(task, sourceKey) {
    const override = sourceFieldsOverride(task, sourceKey);
    return effectiveOptionalFields(override ?? recordOf(task?.settings).fields);
}
