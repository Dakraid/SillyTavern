'use strict';

/**
 * @file Registry of REAL page modules for the 8-page guided task wizard.
 *
 * Pages land incrementally (Steps 11c+). This module returns the
 * `{ pageKey → pageModule }` overrides handed to
 * {@link TaskWizardController}; any page without a real module keeps its
 * read-only placeholder, so the flow stays fully navigable while pages are
 * being implemented.
 *
 * Page-module contract: `{ render(container, snapshot, actions) → Element|null, dispose?() }`.
 * `snapshot` is the `TaskWizardState#getSnapshot()` payload; `actions` is
 * the controller's bound actions facade (update/refresh/goToPage/runPass/
 * resumePass/cancel/runPostProcess/runPromptAssist/getReview).
 */

// Real page factories are imported and wired here as each page lands.

import { createCardsPage } from './cardsPage.js';
import { createPromptSettingsPage } from './promptSettingsPage.js';

/**
 * Builds the page-module overrides for the guided task wizard.
 *
 * @returns {Object<string, {render: Function, dispose?: Function}>} Overrides keyed by page key.
 */
export function createWizardPageOverrides() {
    return {
        cards: createCardsPage(),
        prompt: createPromptSettingsPage(),
    };
}
