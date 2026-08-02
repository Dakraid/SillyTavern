'use strict';

/**
 * @file Placeholder page modules for the 8-page guided task wizard.
 *
 * Each placeholder renders the page heading (focus target, `tabindex="-1"`),
 * a muted "implemented in a later step" note, and a small READ-ONLY summary
 * derived from the current task snapshot — so navigation, state, and the
 * rail are fully testable before the real pages land.
 *
 * Placeholders NEVER fetch or execute: they render only from the state
 * snapshot passed to {@link render}.
 */

/**
 * Counts pass items by status.
 *
 * @param {object} [pass] Pass record (`{ items }`).
 * @returns {Object<string, number>} Status counts.
 */
function countItemStatuses(pass) {
    const counts = {};
    for (const item of Object.values(pass?.items ?? {})) {
        const status = item?.status ?? 'pending';
        counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
}

/**
 * Formats item status counts as a compact line.
 *
 * @param {Object<string, number>} counts Status counts.
 * @returns {string} Formatted counts, or an empty-dash when there are none.
 */
function formatCounts(counts) {
    const parts = Object.entries(counts).map(([status, count]) => `${status}: ${count}`);
    return parts.length > 0 ? parts.join(' · ') : 'no items yet';
}

/**
 * Builds the read-only summary lines for a page key from the snapshot.
 *
 * @param {string} key Page key.
 * @param {object} state State snapshot (`{ task, pageStates, currentPage }`).
 * @returns {string[]} Summary lines.
 */
function buildSummaryLines(key, state) {
    const task = state?.task ?? {};
    const sources = Array.isArray(task.sources) ? task.sources : [];
    const settings = task.settings ?? {};

    switch (key) {
        case 'cards': {
            const names = sources.map((source) => source?.name).filter(Boolean);
            return [
                `${sources.length} source card snapshot(s) stored in this task.`,
                names.length > 0 ? `Sources: ${names.join(', ')}` : 'No sources stored yet.',
            ];
        }
        case 'prompt':
            return [
                `Main prompt: ${(task.prompts?.main?.text ?? '').length} character(s).`,
                `Mode: ${settings.mode ?? 'individual'} · Concurrency limit: ${settings.concurrency ?? 1} · Destination: ${settings.destination ?? 'card'}.`,
            ];
        case 'transform1':
        case 'transform2':
        case 'summary': {
            const pass = task.passes?.[key] ?? {};
            return [
                `Pass status: ${pass.status ?? 'pending'}.`,
                `Items: ${formatCounts(countItemStatuses(pass))}.`,
            ];
        }
        case 'post': {
            const post = task.post ?? {};
            return [
                `Post-processing status: ${post.status ?? 'not run'} (mode: ${settings.postProcessingMode ?? 'replace'}).`,
            ];
        }
        case 'review': {
            const review = (state?.pageStates ?? []).find((page) => page.key === 'review');
            return [`Review page status: ${review?.status ?? 'not_started'}.`];
        }
        case 'avatar': {
            const artifactKeys = Object.keys(task.artifacts ?? {});
            return [
                artifactKeys.length > 0
                    ? `Created artifacts recorded: ${artifactKeys.join(', ')}.`
                    : 'No artifacts created yet.',
            ];
        }
        default:
            return [];
    }
}

/**
 * Creates a placeholder page module for the controller's page registry.
 * Contract: `render(container, state)` replaces the container content and
 * returns the element that should receive focus (the page heading).
 *
 * @param {object} options Page identity.
 * @param {string} options.key Page key (matches `TASK_WIZARD_PAGES`).
 * @param {string} options.title Page title.
 * @returns {{key: string, title: string, render: (container: Element, state: object) => Element}} Page module.
 */
export function createPlaceholderPage({ key, title }) {
    return {
        key,
        title,
        /**
         * Renders the placeholder page into the canvas container.
         *
         * @param {Element} container Canvas container.
         * @param {object} state Current state snapshot.
         * @returns {Element} The page heading (focus target).
         */
        render(container, state) {
            const root = document.createElement('div');
            root.className = 'bc-task-page';

            const heading = document.createElement('h2');
            heading.className = 'bc-task-page-title';
            heading.tabIndex = -1;
            heading.textContent = title;

            const note = document.createElement('p');
            note.className = 'bc-task-page-note';
            note.textContent = 'This page is implemented in a later step. Navigation and saved task state are already live.';

            const summary = document.createElement('div');
            summary.className = 'bc-task-page-summary';
            for (const line of buildSummaryLines(key, state)) {
                const row = document.createElement('p');
                row.className = 'bc-task-page-summary-line';
                row.textContent = line;
                summary.append(row);
            }

            root.append(heading, note, summary);
            container.replaceChildren(root);
            return heading;
        },
    };
}
