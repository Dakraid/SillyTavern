'use strict';

/**
 * @file Stage indicator bar (stepper).
 *
 * Horizontal bar of 5 stage nodes with Font Awesome icons, connected by
 * lines. Nodes render in upcoming / active / completed states. Completed
 * nodes are marked `.clickable` for backward navigation (the
 * {@link module:bulk-combine/wizard/WizardController} binds the click
 * handler). Uses `role="tablist"` / `role="tab"`.
 *
 * The wizard shell template (`wizard.html`) already contains the full stepper
 * markup, so {@link updateStepper} is the primary entry point.
 * {@link renderStepper} builds the markup from scratch when the container is
 * empty (programmatic use).
 */

/**
 * Ordered list of wizard stages with their icons and labels.
 *
 * @type {readonly {id: number, icon: string, label: string}[]}
 */
export const STAGES = Object.freeze([
    { id: 1, icon: 'fa-users', label: 'Characters' },
    { id: 2, icon: 'fa-bolt', label: 'Generate' },
    { id: 3, icon: 'fa-wand-magic-sparkles', label: 'Polish' },
    { id: 4, icon: 'fa-clipboard-check', label: 'Review' },
    { id: 5, icon: 'fa-image', label: 'Avatar Studio' },
]);

const STAGE_MIN = 1;
const STAGE_MAX = 5;

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
 * Build the full stepper markup (nodes + connecting lines) into an empty
 * container. Matches the structure in `wizard.html`.
 *
 * @param {JQuery<HTMLElement>} $container Empty stepper host.
 * @returns {void}
 */
function buildStepperHtml($container) {
    $container.empty();
    STAGES.forEach((stageInfo, index) => {
        if (index > 0) {
            $container.append($('<div></div>').addClass('bcw-stepper-line'));
        }
        $container.append(
            $('<div></div>')
                .addClass('bcw-stepper-node')
                .attr('data-stage', String(stageInfo.id))
                .attr('role', 'tab')
                .attr('aria-selected', 'false')
                .attr('tabindex', '0')
                .append(
                    $('<i></i>').addClass(
                        `fa-solid ${stageInfo.icon} bcw-stepper-icon`,
                    ),
                )
                .append(
                    $('<span></span>')
                        .addClass('bcw-stepper-label')
                        .attr('data-i18n', stageInfo.label)
                        .text(stageInfo.label),
                ),
        );
    });
}

/**
 * Update the active/completed/clickable states on existing stepper nodes
 * without rebuilding the DOM. Call after every stage transition.
 *
 * Nodes with `data-stage` less than `currentStage` become `.completed` and
 * `.clickable`. The node equal to `currentStage` becomes `.active`. The
 * connecting line after a completed node becomes `.completed` (solid).
 *
 * @param {JQuery<HTMLElement>|HTMLElement} container Stepper host element.
 * @param {number} currentStage Active stage index (1–5).
 * @returns {void}
 */
export function updateStepper(container, currentStage) {
    const $container = $(container);
    const stage = clampStage(currentStage);

    $container.find('.bcw-stepper-node').each(function () {
        const $node = $(this);
        const nodeStage = Number($node.attr('data-stage'));
        $node.removeClass('active completed clickable');
        $node.attr('aria-selected', 'false');

        if (nodeStage < stage) {
            $node.addClass('completed clickable');
        } else if (nodeStage === stage) {
            $node.addClass('active');
            $node.attr('aria-selected', 'true');
        }
    });

    // Line index i sits between node (i+1) and node (i+2). It is completed
    // when the node before it (stage i+1) is completed.
    $container.find('.bcw-stepper-line').each(function (index) {
        const $line = $(this);
        $line.removeClass('completed');
        if (index + 1 < stage) {
            $line.addClass('completed');
        }
    });
}

/**
 * Render the stepper into a container. If the container already contains
 * `.bcw-stepper-node` elements (template-loaded), only the states are
 * updated. Otherwise the full markup is built first.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} container Stepper host element.
 * @param {number} currentStage Active stage index (1–5).
 * @returns {void}
 */
export function renderStepper(container, currentStage) {
    const $container = $(container);
    if ($container.find('.bcw-stepper-node').length === 0) {
        buildStepperHtml($container);
    }
    updateStepper($container, currentStage);
}
