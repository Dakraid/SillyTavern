'use strict';

/**
 * @file Stage 4 — Review.
 *
 * Final review of the generated group character: editable name, description,
 * first message, and an alternate-greetings editor with add/remove/reorder.
 * No generation here; this stage only shapes the artifact before avatar work.
 *
 * Data flow:
 *   render()        → loads template, extracts review data from the
 *                     post-processed XML (or merged-XML fallback), populates
 *                     editable fields + greetings editor. User edits made
 *                     before a re-render (back-navigation) are captured and
 *                     preserved.
 *   onEnter()       → safety-net: renders when the stage was not yet populated.
 *   validate()      → requires non-empty name + description.
 *   collectConfig() → reads all fields, stores into wizardState as
 *                     finalName / finalDescription / finalFirstMes /
 *                     finalAlternateGreetings for downstream stages.
 *   onExit()        → no-op (DOM capture in render handles preservation).
 */

import { getSortableDelay } from '../../utils.js';
import {
    parseGreetingsFromGeneratedOutput,
    extractFirstMessage,
    stripGreetingBlocks,
    minifyXml,
} from '../../group-card-xml-parser.js';
import { buildDynamicSummaryDescription } from '../helpers.js';

/** @type {string|null} Cached stage 4 template HTML. */
let stage4TemplateHtml = null;

/** jQuery $.data key for the render-context flag on the stage panel. */
const CONTEXT_KEY = 'bcw-stage4-context';

/**
 * Fetch and cache the stage 4 template.
 *
 * @returns {Promise<string>} Stage 4 template HTML.
 */
async function loadStage4Template() {
    if (stage4TemplateHtml) {
        return stage4TemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/stage4.html');
    stage4TemplateHtml = await response.text();
    return stage4TemplateHtml;
}

/**
 * Extract review data from the post-processed XML (or merged-XML fallback).
 *
 * Description: strips greeting blocks, applies dynamic-summary reduction and
 * minification when configured. First message and alternate greetings are
 * parsed from `<greeting>` tags, falling back to `<first_mes>`.
 *
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {{ description: string, firstMes: string, alternateGreetings: string[] }} Review data.
 */
function extractReviewData(wizardState) {
    const config = wizardState.config;
    const sourceXml = String(
        wizardState.state.postProcessResult ||
            wizardState.state.mergedXml ||
            '',
    );

    let description = stripGreetingBlocks(sourceXml);

    if (config.dynamicLorebook) {
        const fallbackTags =
            Array.isArray(config.summaryFallbackTags) &&
            config.summaryFallbackTags.length > 0
                ? config.summaryFallbackTags
                : ['summary'];
        description = buildDynamicSummaryDescription(description, fallbackTags);
    }

    if (config.minify) {
        description = minifyXml(description, {
            compact: !config.minifySingleLine,
            singleLine: Boolean(config.minifySingleLine),
        });
    }

    const greetings = parseGreetingsFromGeneratedOutput(sourceXml);
    const firstMes =
        greetings.first_mes || extractFirstMessage(description);
    const alternateGreetings = greetings.alternate_greetings;

    return { description, firstMes, alternateGreetings };
}

/**
 * Read the current field values from an already-rendered stage panel.
 * Returns `null` when the panel has not been rendered (no name field).
 *
 * @param {JQuery<HTMLElement>} $stage Stage 4 panel.
 * @returns {{ name: string, description: string, firstMes: string, alternateGreetings: string[] }|null} Captured values.
 */
function captureExistingValues($stage) {
    const $name = $stage.find('#bcw_review_name');
    if ($name.length === 0) {
        return null;
    }

    const alternateGreetings = [];
    $stage.find('.bcw-greeting-input').each(function () {
        alternateGreetings.push(String($(this).val() ?? ''));
    });

    return {
        name: String($name.val() ?? ''),
        description: String(
            $stage.find('#bcw_review_description').val() ?? '',
        ),
        firstMes: String($stage.find('#bcw_review_first_mes').val() ?? ''),
        alternateGreetings,
    };
}

/**
 * Retrieve previously-stored review data from the wizard state top-level
 * fields, if present.
 *
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {{ name: string, description: string, firstMes: string, alternateGreetings: string[] }|null} Stored data, or null.
 */
function getStoredReviewData(wizardState) {
    const state = wizardState.state;
    if (
        typeof state.finalName !== 'string' &&
        typeof state.finalDescription !== 'string'
    ) {
        return null;
    }

    return {
        name: String(state.finalName ?? ''),
        description: String(state.finalDescription ?? ''),
        firstMes: String(state.finalFirstMes ?? ''),
        alternateGreetings: Array.isArray(state.finalAlternateGreetings)
            ? state.finalAlternateGreetings.map((g) => String(g ?? ''))
            : [],
    };
}

/**
 * Persist review data as top-level wizard state fields so downstream stages
 * and re-renders can access them.
 *
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {{ name: string, description: string, firstMes: string, alternateGreetings: string[] }} data Review data.
 * @returns {void}
 */
function storeReviewData(wizardState, data) {
    wizardState.updateField('finalName', data.name);
    wizardState.updateField('finalDescription', data.description);
    wizardState.updateField('finalFirstMes', data.firstMes);
    wizardState.updateField('finalAlternateGreetings', [
        ...data.alternateGreetings,
    ]);
}

/**
 * Create a single greeting row with drag handle, editable textarea, and
 * remove button.
 *
 * @param {string} text Initial greeting text.
 * @returns {JQuery<HTMLElement>} Greeting row element.
 */
function createGreetingRow(text) {
    const $row = $('<div class="bcw-greeting-row"></div>').css({
        display: 'flex',
        'align-items': 'flex-start',
        gap: '0.4em',
        'margin-bottom': '0.4em',
    });

    const $handle = $('<span></span>')
        .addClass('bcw-greeting-handle fa-solid fa-grip-vertical')
        .css({ cursor: 'grab', 'padding-top': '0.5em', opacity: '0.6' });

    const $textarea = $(
        '<textarea class="text_pole bcw-greeting-input" rows="3"></textarea>',
    )
        .val(text)
        .css({ flex: '1' });

    const $remove = $('<span></span>')
        .addClass('bcw-greeting-remove fa-solid fa-xmark')
        .css({ cursor: 'pointer', 'padding-top': '0.5em', opacity: '0.6' })
        .attr('title', 'Remove greeting')
        .attr('aria-label', 'Remove greeting');

    $remove.on('click', () => {
        $row.remove();
    });

    $row.append($handle, $textarea, $remove);
    return $row;
}

/**
 * Populate the editable fields and greetings list from review data.
 *
 * @param {JQuery<HTMLElement>} $stage Stage 4 panel.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {{ name: string, description: string, firstMes: string, alternateGreetings: string[] }} data Review data.
 * @returns {void}
 */
function populateFields($stage, wizardState, data) {
    $stage
        .find('#bcw_review_name')
        .val(data.name || wizardState.config.groupName || '');
    $stage.find('#bcw_review_description').val(data.description);
    $stage.find('#bcw_review_first_mes').val(data.firstMes);

    const $list = $stage.find('#bcw_greetings_list');
    $list.empty();
    data.alternateGreetings.forEach((greeting) => {
        $list.append(createGreetingRow(greeting));
    });
}

/**
 * Wire the add-greeting button and drag-reorder on the greetings list.
 *
 * @param {JQuery<HTMLElement>} $stage Stage 4 panel.
 * @returns {void}
 */
function bindGreetingsEditor($stage) {
    const $addBtn = $stage.find('#bcw_add_greeting');
    const $list = $stage.find('#bcw_greetings_list');

    $addBtn.off('click.bcw-stage4').on('click.bcw-stage4', () => {
        $list.append(createGreetingRow(''));
    });

    if (typeof $list.sortable === 'function') {
        $list.sortable({
            items: '.bcw-greeting-row',
            handle: '.bcw-greeting-handle',
            delay: getSortableDelay(),
            placeholder: 'bcw-greeting-row-placeholder',
            forcePlaceholderSize: true,
            tolerance: 'pointer',
        });
    }
}

/**
 * Read all greeting textareas in DOM order.
 *
 * @param {JQuery<HTMLElement>} $stage Stage 4 panel.
 * @returns {string[]} Greeting strings in display order.
 */
function readGreetingInputs($stage) {
    const greetings = [];
    $stage.find('.bcw-greeting-input').each(function () {
        greetings.push(String($(this).val() ?? ''));
    });
    return greetings;
}

/**
 * Stage 4 controller object following the shared stage-module contract.
 */
export const Stage4Review = {
    /**
     * Load the Stage 4 template, extract review data from the generated XML,
     * and populate all editable fields. User edits made before a re-render
     * (e.g. back-navigation) are captured and preserved.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the panel is rendered.
     */
    async render(popupContent, wizardState) {
        const $content = $(popupContent);
        const $stage = $content.find('#bcw_stage_4');

        // Capture user edits before re-rendering (back-navigation safety).
        const captured = captureExistingValues($stage);

        const html = await loadStage4Template();
        $stage.html(html);

        // Data-source priority: captured DOM edits > stored state > XML extraction.
        const data =
            captured ??
            getStoredReviewData(wizardState) ??
            extractReviewData(wizardState);

        populateFields($stage, wizardState, data);
        bindGreetingsEditor($stage);

        // Persist so re-renders and downstream stages have the data.
        storeReviewData(wizardState, {
            name: String($stage.find('#bcw_review_name').val() ?? ''),
            description: String(
                $stage.find('#bcw_review_description').val() ?? '',
            ),
            firstMes: String(
                $stage.find('#bcw_review_first_mes').val() ?? '',
            ),
            alternateGreetings: readGreetingInputs($stage),
        });

        $stage.data(CONTEXT_KEY, { rendered: true });
    },

    /**
     * Safety-net hook: populate from XML when the stage was not yet rendered.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the stage is ready.
     */
    async onEnter(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_4');
        if ($stage.find('#bcw_review_name').length > 0) {
            return;
        }
        await Stage4Review.render(popupContent, wizardState);
    },

    /**
     * Require a non-empty name and description.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {boolean} `true` when the form is valid.
     */
    validate(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_4');
        const name = String($stage.find('#bcw_review_name').val() ?? '').trim();
        const description = String(
            $stage.find('#bcw_review_description').val() ?? '',
        ).trim();

        if (!name || !description) {
            globalThis.toastr?.warning?.(
                'Character name and description are required.',
                'Combine into Group Card',
            );
            return false;
        }
        return true;
    },

    /**
     * Read all Stage 4 fields, store them into wizard state, and return a
     * config patch for the controller.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {{ finalName: string, finalDescription: string, finalFirstMes: string, finalAlternateGreetings: string[] }} Config patch.
     */
    collectConfig(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_4');

        const finalName = String(
            $stage.find('#bcw_review_name').val() ?? '',
        ).trim();
        const finalDescription = String(
            $stage.find('#bcw_review_description').val() ?? '',
        );
        const finalFirstMes = String(
            $stage.find('#bcw_review_first_mes').val() ?? '',
        );
        const finalAlternateGreetings = readGreetingInputs($stage)
            .map((g) => g.trim())
            .filter((g) => g.length > 0);

        wizardState.updateField('finalName', finalName);
        wizardState.updateField('finalDescription', finalDescription);
        wizardState.updateField('finalFirstMes', finalFirstMes);
        wizardState.updateField(
            'finalAlternateGreetings',
            finalAlternateGreetings,
        );

        return {
            finalName,
            finalDescription,
            finalFirstMes,
            finalAlternateGreetings,
        };
    },

    /**
     * Hook executed when leaving Stage 4. No cleanup needed — DOM capture
     * in {@link Stage4Review.render render} handles edit preservation on
     * re-entry.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {void}
     */
    onExit(popupContent, wizardState) {
        // Intentionally empty — render captures existing DOM values on re-entry.
    },
};
