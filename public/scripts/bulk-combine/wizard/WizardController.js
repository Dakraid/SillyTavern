'use strict';

/**
 * @file Main wizard orchestrator.
 *
 * Opens the combine popup via `callGenericPopup`, loads the wizard shell
 * template, drives stage transitions, binds footer button handlers, and
 * delegates rendering to the individual stage modules. Stages 2–5 show
 * placeholder content until their respective tasks implement them.
 *
 * All methods are static; the controller is a stateless coordinator that
 * threads the shared {@link WizardState} and popup content element through
 * the stage modules.
 */

import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import { WizardState } from './WizardState.js';
import { Stage1Characters } from './Stage1Characters.js';
import { Stage2Results } from './Stage2Results.js';
import { Stage3Polish } from './Stage3Polish.js';
import { Stage4Review } from './Stage4Review.js';
import { Stage5Avatar } from './Stage5Avatar.js';
import { updateStepper } from '../components/Stepper.js';

const STAGE_MIN = 1;
const STAGE_MAX = 5;

/** @type {string|null} Cached wizard shell template HTML. */
let wizardTemplateHtml = null;

/**
 * Per-stage footer configuration: Back visibility, Next button label/i18n
 * key, and Save-As-Is visibility.
 *
 * @type {Record<number, {back: boolean, nextLabel: string, nextI18n: string, saveAsIs: boolean}>}
 */
const STAGE_FOOTER = {
    1: { back: false, nextLabel: 'Generate', nextI18n: 'Generate', saveAsIs: false },
    2: { back: true, nextLabel: 'Apply Processing', nextI18n: 'Apply Processing', saveAsIs: true },
    3: { back: true, nextLabel: 'Apply Changes', nextI18n: 'Apply Changes', saveAsIs: false },
    4: { back: true, nextLabel: 'Continue to Avatar', nextI18n: 'Continue to Avatar', saveAsIs: false },
    5: { back: true, nextLabel: 'Create Character', nextI18n: 'Create Character', saveAsIs: false },
};

/**
 * Clamp a stage candidate to a valid integer in the 1–5 range.
 *
 * @param {unknown} stage Stage candidate.
 * @returns {number} Clamped stage.
 */
function clampStage(stage) {
    const n = Number(stage);
    if (!Number.isFinite(n)) {
        return STAGE_MIN;
    }
    return Math.max(STAGE_MIN, Math.min(STAGE_MAX, Math.round(n)));
}

/**
 * Fetch and cache the wizard shell template.
 *
 * @returns {Promise<string>} Wizard shell template HTML.
 */
async function loadWizardTemplate() {
    if (wizardTemplateHtml) {
        return wizardTemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/wizard.html');
    wizardTemplateHtml = await response.text();
    return wizardTemplateHtml;
}

/**
 * Update the footer button labels and visibility for the given stage.
 *
 * @param {JQuery<HTMLElement>} $content Popup content element.
 * @param {number} stage Target stage.
 * @returns {void}
 */
function updateFooter($content, stage) {
    const footer = STAGE_FOOTER[stage] ?? STAGE_FOOTER[STAGE_MIN];
    $content.find('#bcw_btn_back').prop('hidden', !footer.back);
    $content.find('#bcw_btn_save_as_is').prop('hidden', !footer.saveAsIs);
    $content.find('#bcw_btn_next')
        .attr('data-i18n', footer.nextI18n)
        .text(footer.nextLabel);
}

/**
 * Bind the footer action buttons once, on popup open. The handlers read the
 * current stage from the wizard state so they stay correct across transitions.
 *
 * @param {JQuery<HTMLElement>} $content Popup content element.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {import('../../popup.js').Popup} popup Popup instance (for close).
 * @returns {void}
 */
function bindFooter($content, wizardState, popup) {
    $content.find('#bcw_btn_back').on('click', async () => {
        const target = clampStage(wizardState.stage - 1);
        if (target < wizardState.stage) {
            await WizardController.goToStage($content, wizardState, target);
        }
    });

    $content.find('#bcw_btn_cancel').on('click', async () => {
        await popup.completeCancelled();
    });

    $content.find('#bcw_btn_save_as_is').on('click', async () => {
        // Stage 2 "Save As Is" skips post-processing to the review stage.
        if (wizardState.stage === 2) {
            if (!Stage2Results.validate($content, wizardState)) {
                return;
            }
            Stage2Results.collectConfig($content, wizardState);
            wizardState.persist();
        }
        await WizardController.goToStage($content, wizardState, 4);
    });

    $content.find('#bcw_btn_next').on('click', async () => {
        const stage = wizardState.stage;
        if (stage === 1) {
            if (!Stage1Characters.validate($content, wizardState)) {
                return;
            }
            const config = Stage1Characters.collectConfig(
                $content,
                wizardState,
            );
            wizardState.update(config);
            wizardState.persist();
        } else if (stage === 2) {
            if (!Stage2Results.validate($content, wizardState)) {
                return;
            }
            Stage2Results.collectConfig($content, wizardState);
            wizardState.persist();
            const skipPostProcess = Boolean(
                $content.find('#bcw_skip_postprocess').prop('checked'),
            );
            await WizardController.goToStage(
                $content,
                wizardState,
                skipPostProcess ? 4 : 3,
            );
            return;
        } else if (stage === 3) {
            if (!Stage3Polish.validate($content, wizardState)) {
                return;
            }
            Stage3Polish.collectConfig($content, wizardState);
            wizardState.persist();
        } else if (stage === 4) {
            if (!Stage4Review.validate($content, wizardState)) {
                return;
            }
            Stage4Review.collectConfig($content, wizardState);
            wizardState.persist();
        } else if (stage === 5) {
            if (!Stage5Avatar.validate($content, wizardState)) {
                return;
            }
            Stage5Avatar.collectConfig($content, wizardState);
            wizardState.persist();
            WizardController.setNextButtonDisabled($content, true);
            const created = await Stage5Avatar.createCharacter(
                $content,
                wizardState,
            );
            WizardController.setNextButtonDisabled($content, false);
            if (created) {
                await popup.completeAffirmative();
            }
            return;
        }
        const next = clampStage(stage + 1);
        if (next <= stage) {
            return;
        }
        await WizardController.goToStage($content, wizardState, next);
    });
}

/**
 * Bind stepper-node clicks for backward navigation to completed stages.
 * Uses event delegation so it survives stage-panel re-rendering.
 *
 * @param {JQuery<HTMLElement>} $content Popup content element.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {void}
 */
function bindStepperNav($content, wizardState) {
    $content.on('click', '.bcw-stepper-node', function () {
        const $node = $(this);
        if (!$node.hasClass('clickable')) {
            return;
        }
        const target = clampStage($node.attr('data-stage'));
        if (target < wizardState.stage) {
            WizardController.goToStage($content, wizardState, target);
        }
    });
}

/**
 * Top-level wizard controller. All methods are static.
 */
export class WizardController {
    /**
     * Open the wizard popup for the given characters.
     *
     * @param {number[]} selectedCharacterIds Characters selected in the bulk overlay.
     * @param {object} [rerunConfig] Optional re-run configuration.
     * @returns {Promise<void>} Resolves when the wizard popup closes.
     */
    static async open(selectedCharacterIds, rerunConfig) {
        const wizardState = new WizardState();
        wizardState.init(selectedCharacterIds, rerunConfig);

        if (wizardState.state.selectedCharacterIds.length < 2) {
            globalThis.toastr?.warning?.(
                'Select at least two valid characters.',
                'Combine into Group Card',
            );
            return;
        }

        // Keep sessionStorage in sync for accidental-close recovery.
        wizardState.subscribe(() => wizardState.persist());
        wizardState.persist();

        const html = await loadWizardTemplate();

        await callGenericPopup(html, POPUP_TYPE.CONFIRM, '', {
            okButton: false,
            cancelButton: false,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onOpen: async (popup) => {
                const $content = $(popup.dlg);
                await WizardController.goToStage($content, wizardState, wizardState.stage);
                bindFooter($content, wizardState, popup);
                bindStepperNav($content, wizardState);
            },
        });
    }

    /**
     * Transition to a specific stage: update state, show/hide panels, update
     * the stepper and footer, and render the target stage content.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @param {number} stage Target stage index (1–5).
     * @returns {Promise<void>} Resolves when the stage transition completes.
     */
    static async goToStage(popupContent, wizardState, stage) {
        const $content = $(popupContent);
        const clamped = clampStage(stage);
        wizardState.updateField('stage', clamped);

        // Show/hide stage panels.
        $content.find('.bcw-stage').removeClass('active').prop('hidden', true);
        const $activePanel = $content.find(`#bcw_stage_${clamped}`);
        $activePanel.addClass('active').prop('hidden', false);

        // Update stepper + footer.
        updateStepper($content.find('#bcw_stepper'), clamped);
        updateFooter($content, clamped);

        // Render stage content.
        if (clamped === 1) {
            await Stage1Characters.render($content, wizardState);
        } else if (clamped === 2) {
            await Stage2Results.render($content, wizardState);
            await Stage2Results.onEnter($content, wizardState);
        } else if (clamped === 3) {
            await Stage3Polish.render($content, wizardState);
            await Stage3Polish.onEnter($content, wizardState);
        } else if (clamped === 4) {
            await Stage4Review.render($content, wizardState);
            await Stage4Review.onEnter($content, wizardState);
        } else if (clamped === 5) {
            await Stage5Avatar.render($content, wizardState);
            await Stage5Avatar.onEnter($content, wizardState);
        }
    }

    /**
     * Toggle the primary Next/Generate button's disabled state.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {boolean} disabled Whether the button should be disabled.
     * @returns {void}
     */
    static setNextButtonDisabled(popupContent, disabled) {
        const $next = $(popupContent).find('#bcw_btn_next');
        $next
            .toggleClass('disabled', disabled)
            .css('pointer-events', disabled ? 'none' : '')
            .attr('aria-disabled', disabled ? 'true' : 'false');
    }
}
