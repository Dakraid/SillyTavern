'use strict';

/**
 * @file Vertical workflow rail for the 8-page Bulk Combine guided task
 * wizard.
 *
 * Pure DOM component (no fetch, no execution): it renders the 8 pages with
 * title + status badge, active highlight, disabled/skipped styling, and
 * full keyboard/ARIA support (`role="tablist"` with manual activation —
 * arrow keys move focus, Enter/Space activate via the native button click).
 *
 * Selection is reported through the `onSelect(pageKey)` callback; the
 * controller decides whether navigation is allowed. The rail itself never
 * triggers any work.
 */

/**
 * Human-readable labels for page statuses.
 *
 * @type {Readonly<Object<string, string>>}
 */
export const RAIL_STATUS_LABELS = Object.freeze({
    not_started: 'Not started',
    ready: 'Ready',
    running: 'Running',
    complete: 'Complete',
    stale: 'Stale',
    interrupted: 'Interrupted',
    failed: 'Failed',
    skipped: 'Skipped',
    disabled: 'Disabled',
});

/**
 * Creates the workflow rail component.
 *
 * @param {object} [options] Options.
 * @param {(pageKey: string) => void} [options.onSelect] Selection callback.
 * @returns {{render: (container: Element, props: object) => void, update: (props: object) => void, destroy: () => void}} Rail instance.
 */
export function createWorkflowRail({ onSelect } = {}) {
    /** @type {Element|null} */
    let container = null;
    /** @type {{pages: Array, currentPage: number, furthestPage: number}} */
    let props = { pages: [], currentPage: 1, furthestPage: 1 };
    /** @type {Array<{page: object, item: Element, disabled: boolean}>} */
    let entries = [];

    /**
     * Whether a page is not selectable: conditionally disabled, or beyond
     * the furthest page reached so far.
     *
     * @param {object} page Page state (`{ index, status }`).
     * @returns {boolean} True when the rail item is disabled.
     */
    function isDisabled(page) {
        return page.status === 'disabled' || page.index > props.furthestPage;
    }

    /**
     * Moves focus to the given entry index (roving tabindex).
     *
     * @param {number} targetIndex Entry index within {@link entries}.
     * @returns {void}
     */
    function focusEntry(targetIndex) {
        entries.forEach((entry, index) => {
            entry.item.tabIndex = index === targetIndex ? 0 : -1;
        });
        entries[targetIndex]?.item.focus();
    }

    /**
     * Finds the next enabled entry in a direction, wrapping around.
     *
     * @param {number} fromIndex Current focused entry index (-1 for none).
     * @param {number} delta Direction (+1 / -1).
     * @returns {number|null} Target entry index, or null when all disabled.
     */
    function findEnabled(fromIndex, delta) {
        if (entries.length === 0 || entries.every((entry) => entry.disabled)) {
            return null;
        }
        let index = fromIndex;
        for (let step = 0; step < entries.length; step++) {
            index = (index + delta + entries.length) % entries.length;
            if (!entries[index].disabled) {
                return index;
            }
        }
        return null;
    }

    /**
     * Arrow-key navigation across enabled rail items (manual activation:
     * moving focus never selects; Enter/Space activate the focused button).
     *
     * @param {KeyboardEvent} event Key event.
     * @returns {void}
     */
    function onKeydown(event) {
        const currentIndex = entries.findIndex((entry) => entry.item === event.target);
        let targetIndex = null;

        if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            targetIndex = findEnabled(currentIndex, 1);
        } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            targetIndex = findEnabled(currentIndex, -1);
        } else if (event.key === 'Home') {
            targetIndex = findEnabled(-1, 1);
        } else if (event.key === 'End') {
            targetIndex = findEnabled(0, -1);
        }

        if (targetIndex !== null) {
            event.preventDefault();
            focusEntry(targetIndex);
        }
    }

    /**
     * Builds one rail item button for a page.
     *
     * @param {object} page Page state (`{ key, title, index, status }`).
     * @returns {Element} Rail item button.
     */
    function buildItem(page) {
        const disabled = isDisabled(page);
        const selected = page.index === props.currentPage;
        const statusLabel = RAIL_STATUS_LABELS[page.status] ?? page.status;

        const item = document.createElement('button');
        item.type = 'button';
        item.className = `bc-task-rail-item bc-task-rail-item--${page.status}`;
        item.setAttribute('role', 'tab');
        item.setAttribute('data-page-key', page.key);
        item.setAttribute('aria-selected', selected ? 'true' : 'false');
        item.setAttribute('aria-disabled', disabled ? 'true' : 'false');
        item.setAttribute('aria-label', `${page.index}. ${page.title}: ${statusLabel}`);
        item.disabled = disabled;
        item.tabIndex = selected && !disabled ? 0 : -1;
        if (selected) {
            item.classList.add('active');
        }

        const number = document.createElement('span');
        number.className = 'bc-task-rail-number';
        number.textContent = String(page.index);

        const title = document.createElement('span');
        title.className = 'bc-task-rail-title';
        title.textContent = page.title;

        const badge = document.createElement('span');
        badge.className = `bc-task-status bc-task-status--${page.status}`;
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = statusLabel;

        item.append(number, title, badge);
        item.addEventListener('click', () => {
            if (!disabled) {
                onSelect?.(page.key);
            }
        });
        return item;
    }

    /**
     * Renders (or re-renders) the rail.
     *
     * @param {Element} [nextContainer] Host container (required on first render).
     * @param {object} [nextProps] Rail props (`{ pages, currentPage, furthestPage }`).
     * @returns {void}
     */
    function render(nextContainer, nextProps) {
        if (nextContainer) {
            container = nextContainer;
        }
        if (!container) {
            return;
        }
        props = { ...props, ...nextProps };
        entries = [];

        const root = document.createElement('div');
        root.className = 'bc-task-rail';
        root.setAttribute('role', 'tablist');
        root.setAttribute('aria-orientation', 'vertical');
        root.setAttribute('aria-label', 'Combine workflow pages');

        for (const page of props.pages) {
            const item = buildItem(page);
            entries.push({ page, item, disabled: isDisabled(page) });
            root.append(item);
        }
        root.addEventListener('keydown', onKeydown);

        container.replaceChildren(root);
    }

    return {
        render,
        /**
         * Re-renders into the existing container with merged props.
         *
         * @param {object} nextProps Rail props.
         * @returns {void}
         */
        update(nextProps) {
            render(null, nextProps);
        },
        /**
         * Detaches the rail from its container.
         *
         * @returns {void}
         */
        destroy() {
            container?.replaceChildren();
            container = null;
            entries = [];
        },
    };
}
