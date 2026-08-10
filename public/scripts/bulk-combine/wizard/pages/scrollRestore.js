'use strict';

/**
 * @file Scroll-position capture/restore for wizard pages that rebuild via
 * `host.replaceChildren(root)`. State-driven re-renders (task event
 * stream snapshots) would otherwise reset every scrollable region to the
 * top.
 *
 * Elements opt in via `data-scroll-key`; editable controls that already
 * carry `data-field-key` (draft-tracked textareas) are covered too —
 * `data-scroll-key` wins when both are present. Keys are stable across
 * rebuilds, so a position recorded on a detached element can be re-applied
 * to its replacement.
 *
 * The traversal walks `.children` recursively instead of
 * `querySelectorAll` so the helpers also run under the light fake DOM used
 * by the Node unit tests, and every read is guarded (missing scroll
 * properties are treated as 0, never thrown).
 */

/**
 * Reads the scroll key of one element (`data-scroll-key` ?? `data-field-key`).
 *
 * @param {object} element Candidate element.
 * @returns {string|null} Key, or null when the element carries none.
 */
function scrollKeyOf(element) {
    if (typeof element?.getAttribute !== 'function') {
        return null;
    }
    const key = element.getAttribute('data-scroll-key') ?? element.getAttribute('data-field-key');
    return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * Reads a scroll offset defensively (absent/non-finite/negative → 0).
 *
 * @param {unknown} value Candidate offset.
 * @returns {number} Positive offset, or 0.
 */
function scrollOffset(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Visits every descendant of `host` (the host itself is excluded).
 *
 * @param {object} host Root element.
 * @param {(element: object) => void} visit Visitor.
 * @returns {void}
 */
function walkDescendants(host, visit) {
    const stack = Array.from(host?.children ?? []);
    while (stack.length > 0) {
        const element = stack.pop();
        visit(element);
        stack.push(...Array.from(element?.children ?? []));
    }
}

/**
 * Captures the scroll position of every keyed descendant that is
 * currently scrolled. Elements at offset 0 are omitted (restoring them
 * would be a no-op).
 *
 * @param {object} host Root element about to be rebuilt.
 * @returns {Map<string, {top: number, left: number}>} Saved positions by scroll key.
 */
export function captureScroll(host) {
    const saved = new Map();
    if (!host || typeof host !== 'object') {
        return saved;
    }
    walkDescendants(host, (element) => {
        const key = scrollKeyOf(element);
        if (key === null) {
            return;
        }
        const top = scrollOffset(element.scrollTop);
        const left = scrollOffset(element.scrollLeft);
        if (top > 0 || left > 0) {
            saved.set(key, { top, left });
        }
    });
    return saved;
}

/**
 * Re-applies positions saved by `captureScroll` to the matching rebuilt
 * elements. Assignments are guarded so non-scrollable stand-ins (test
 * fakes, detached nodes) never throw.
 *
 * @param {object} host Rebuilt root element.
 * @param {Map<string, {top: number, left: number}>} saved Positions from `captureScroll`.
 * @returns {void}
 */
export function restoreScroll(host, saved) {
    if (!host || typeof host !== 'object'
        || !saved || typeof saved.has !== 'function' || typeof saved.get !== 'function') {
        return;
    }
    walkDescendants(host, (element) => {
        const key = scrollKeyOf(element);
        if (key === null || !saved.has(key)) {
            return;
        }
        const { top, left } = saved.get(key);
        try {
            if (top > 0) {
                element.scrollTop = top;
            }
            if (left > 0) {
                element.scrollLeft = left;
            }
        } catch {
            // Not a scrollable element in this environment — ignore.
        }
    });
}
