'use strict';

/**
 * @file Stage 3 — Polish (Post-Merge).
 *
 * Implements the shared stage-module contract (`render`, `collectConfig`,
 * `validate`, `onEnter`, `onExit`). Renders a prominent skip banner (Stage 3
 * is optional), a post-merge prompt with preset toolbar, a mode selector
 * (replace / prepend / append), an Apply button that triggers the post-merge
 * LLM pass via `generateQuietPrompt`, and a before/after preview.
 *
 * The skip banner sets `postProcessResult` to the merged XML and jumps
 * directly to Stage 4. The Apply button runs the LLM pass, composes the
 * result according to the selected mode, stores it in the wizard state, and
 * enables the Next button.
 */

import { generateQuietPrompt, saveSettingsDebounced } from '../../../script.js';
import { power_user, DEFAULT_POST_MERGE_PROMPT } from '../../power-user.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import {
    deleteGroupCardPostMergePromptPreset,
    findGroupCardPostMergePromptPresetIndex,
    getGroupCardPostMergePromptPresets,
    renderGroupCardPostMergePromptPresetSelect,
    saveGroupCardPostMergePromptPreset,
} from '../services/PresetManager.js';

/** @type {string|null} Cached stage 3 template HTML. */
let stage3TemplateHtml = null;

/** Valid post-process modes. */
const VALID_MODES = ['replace', 'prepend', 'append'];

/**
 * Fetch and cache the stage 3 template.
 *
 * @returns {Promise<string>} Stage 3 template HTML.
 */
async function loadStage3Template() {
    if (stage3TemplateHtml) {
        return stage3TemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/stage3.html');
    stage3TemplateHtml = await response.text();
    return stage3TemplateHtml;
}

/**
 * Resolve a valid post-process mode from the config, falling back to
 * `'replace'`.
 *
 * @param {object} config Wizard config.
 * @returns {string} Valid mode (`replace`, `prepend`, or `append`).
 */
function resolveMode(config) {
    const mode = String(config?.postProcessMode ?? 'replace');
    return VALID_MODES.includes(mode) ? mode : 'replace';
}

/**
 * Toggle the wizard footer Next button disabled state.
 *
 * @param {JQuery<HTMLElement>} $content Popup content root.
 * @param {boolean} disabled Whether to disable.
 * @returns {void}
 */
function setNextDisabled($content, disabled) {
    $content
        .find('#bcw_btn_next')
        .toggleClass('disabled', disabled)
        .css('pointer-events', disabled ? 'none' : '')
        .attr('aria-disabled', disabled ? 'true' : 'false');
}

/**
 * Wire the post-merge prompt preset toolbar (load / save / delete / restore).
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 3 panel element.
 * @returns {void}
 */
function wirePresetControls($stage) {
    const $select = $stage.find('#bcw_postmerge_preset_select');
    const $save = $stage.find('#bcw_postmerge_preset_save');
    const $delete = $stage.find('#bcw_postmerge_preset_delete');
    const $restore = $stage.find('#bcw_postmerge_preset_restore');
    const $prompt = $stage.find('#bcw_postmerge_prompt');

    renderGroupCardPostMergePromptPresetSelect($select);

    $select.on('change', () => {
        const index = Number($select.val());
        const preset = getGroupCardPostMergePromptPresets()[index];
        if (preset) {
            $prompt.val(preset.prompt);
        }
    });

    $save.on('click', async () => {
        const currentIndex = Number($select.val());
        const currentPreset =
            getGroupCardPostMergePromptPresets()[currentIndex];
        const name = await callGenericPopup(
            'Enter a post-merge prompt preset name:',
            POPUP_TYPE.INPUT,
            currentPreset?.name ?? '',
            { okButton: 'Save', cancelButton: 'Cancel' },
        );
        if (!name || typeof name !== 'string') {
            return;
        }
        const saved = await saveGroupCardPostMergePromptPreset(
            name,
            String($prompt.val() ?? ''),
        );
        if (!saved) {
            return;
        }
        const savedIndex = findGroupCardPostMergePromptPresetIndex(saved.name);
        renderGroupCardPostMergePromptPresetSelect($select, savedIndex);
    });

    $delete.on('click', () => {
        const index = Number($select.val());
        if (deleteGroupCardPostMergePromptPreset(index)) {
            renderGroupCardPostMergePromptPresetSelect($select);
        }
    });

    $restore.on('click', () => {
        $prompt.val(DEFAULT_POST_MERGE_PROMPT);
    });
}

/**
 * Build the before/after preview into the preview container.
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 3 panel element.
 * @param {string} beforeXml Merged XML (read-only "before" content).
 * @param {string} afterXml Post-merge result ("after" content), or empty.
 * @returns {void}
 */
function buildPreview($stage, beforeXml, afterXml) {
    const $preview = $stage.find('#bcw_postmerge_preview');
    $preview.empty();

    // Before section.
    const $beforeSection = $('<div class="bcw-preview-section"></div>');
    $beforeSection.append(
        $('<small class="bcw-preview-label"></small>').text('Before (merged XML)'),
    );
    const $beforeArea = $(
        '<div class="bcw-preview-area bcw-preview-before"></div>',
    );
    $beforeArea.text(String(beforeXml ?? ''));
    $beforeSection.append($beforeArea);
    $preview.append($beforeSection);

    // After section.
    const $afterSection = $('<div class="bcw-preview-section"></div>');
    $afterSection.append(
        $('<small class="bcw-preview-label"></small>').text('After'),
    );
    const $afterArea = $('<div class="bcw-preview-area bcw-preview-after"></div>');
    if (afterXml) {
        $afterArea.text(String(afterXml));
    } else {
        $afterArea.html(
            '<small>Click "Apply Post-Merge" to run the post-merge pass.</small>',
        );
    }
    $afterSection.append($afterArea);
    $preview.append($afterSection);
}

/**
 * Show a loading spinner in the "after" preview area.
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 3 panel element.
 * @returns {void}
 */
function showAfterLoading($stage) {
    $stage.find('#bcw_postmerge_preview .bcw-preview-after').html(
        '<p><i class="fa-solid fa-spinner fa-spin"></i> Running post-merge pass…</p>',
    );
}

/**
 * Show an error message in the "after" preview area.
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 3 panel element.
 * @param {string} message Error message.
 * @returns {void}
 */
function showAfterError($stage, message) {
    const $after = $stage.find('#bcw_postmerge_preview .bcw-preview-after');
    $after.empty();
    $after.append(
        $('<p></p>')
            .css('color', 'var(--SmartThemeQuoteColor)')
            .text(message),
    );
}

/**
 * Run the post-merge LLM pass and compose the result based on the selected
 * mode.
 *
 * The quiet prompt is always built as `postMergePrompt + '\n\n' + mergedXml`.
 * The mode determines how the LLM output is composed with the merged XML:
 * replace (LLM output only), prepend (LLM output + merged), or append
 * (merged + LLM output).
 *
 * @param {JQuery<HTMLElement>} $content Popup content root.
 * @param {JQuery<HTMLElement>} $stage The Stage 3 panel element.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {Promise<boolean>} `true` on success.
 */
async function applyPostProcessing($content, $stage, wizardState) {
    const mode = String(
        $stage.find('input[name="bcw_postprocess_mode"]:checked').val() ??
            'replace',
    );
    const validMode = VALID_MODES.includes(mode) ? mode : 'replace';
    const prompt = String(
        $stage.find('#bcw_postmerge_prompt').val() ?? '',
    ).trim();

    if (!prompt) {
        globalThis.toastr?.warning?.(
            'Enter a post-merge prompt.',
            'Combine into Group Card',
        );
        return false;
    }

    const mergedXml = String(wizardState.state.mergedXml ?? '').trim();
    if (!mergedXml) {
        globalThis.toastr?.warning?.(
            'No merged XML to post-process.',
            'Combine into Group Card',
        );
        return false;
    }

    // Build the quiet prompt: postMergePrompt + '\n\n' + mergedXml.
    const quietPrompt = `${prompt}\n\n${mergedXml}`;

    showAfterLoading($stage);
    setNextDisabled($content, true);

    try {
        const generated = String(
            (await generateQuietPrompt({
                quietPrompt,
                quietToLoud: true,
                skipWIAN: true,
                quietName: 'System',
                removeReasoning: true,
            })) ?? '',
        ).trim();

        // Compose result based on mode.
        let result;
        if (validMode === 'prepend') {
            result = `${generated}\n\n${mergedXml}`;
        } else if (validMode === 'append') {
            result = `${mergedXml}\n\n${generated}`;
        } else {
            result = generated;
        }

        // Store in wizard state.
        wizardState.updateField('postProcessResult', result);
        wizardState.update({
            postProcessMode: validMode,
            postMergePrompt: prompt,
        });

        // Persist user preferences for the next run.
        power_user.group_card_post_process_mode = validMode;
        power_user.group_card_post_merge_prompt = prompt;
        saveSettingsDebounced();

        // Update preview + enable Next.
        buildPreview($stage, mergedXml, result);
        setNextDisabled($content, false);

        globalThis.toastr?.success?.(
            'Post-merge pass complete.',
            'Combine into Group Card',
        );
        return true;
    } catch (error) {
        console.error('[Stage3Polish] Post-merge failed:', error);
        showAfterError(
            $stage,
            `Post-merge failed: ${error?.message ?? 'Unknown error'}`,
        );
        setNextDisabled($content, true);
        globalThis.toastr?.error?.(
            error?.message ?? 'Post-merge pass failed.',
            'Combine into Group Card',
        );
        return false;
    }
}

/**
 * Skip the post-merge step: set the result to the merged XML and navigate
 * directly to Stage 4.
 *
 * @param {JQuery<HTMLElement>} $content Popup content root.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {Promise<void>}
 */
async function skipToStage4($content, wizardState) {
    wizardState.updateField(
        'postProcessResult',
        wizardState.state.mergedXml,
    );
    wizardState.update({ postProcessMode: 'replace' });
    wizardState.persist();

    // Lazy import to avoid a circular module dependency.
    const { WizardController } = await import('./WizardController.js');
    await WizardController.goToStage($content, wizardState, 4);
}

/**
 * Stage 3 controller object following the shared stage-module contract.
 */
export const Stage3Polish = {
    /**
     * Populate the Stage 3 panel DOM: load the template, populate the prompt,
     * wire preset controls, set the mode, inject the Apply button, build the
     * before/after preview, and wire all event handlers.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the panel is rendered.
     */
    async render(popupContent, wizardState) {
        const $content = $(popupContent);
        const $stage = $content.find('#bcw_stage_3');
        const html = await loadStage3Template();
        $stage.html(html);

        const config = wizardState.config;
        const mode = resolveMode(config);

        // Post-merge prompt: config → power_user default → built-in default.
        const promptDefault =
            power_user.group_card_post_merge_prompt ??
            DEFAULT_POST_MERGE_PROMPT;
        $stage.find('#bcw_postmerge_prompt').val(
            config?.postMergePrompt ?? promptDefault,
        );

        // Mode radio.
        $stage
            .find(`input[name="bcw_postprocess_mode"][value="${mode}"]`)
            .prop('checked', true);

        // Preset toolbar.
        wirePresetControls($stage);

        // Inject the Apply button (template has none).
        const $applyButton = $(
            '<div id="bcw_apply_postmerge" class="menu_button"></div>',
        ).text('Apply Post-Merge');
        $stage.find('.bcw-mode-selector').after($applyButton);

        // Before/after preview + Next button state.
        const mergedXml = String(wizardState.state.mergedXml ?? '');
        const existingResult = wizardState.state.postProcessResult ?? '';
        buildPreview($stage, mergedXml, existingResult);
        setNextDisabled($content, !existingResult);

        // Disable Apply when there is no merged XML.
        if (!mergedXml.trim()) {
            $applyButton
                .addClass('disabled')
                .css('pointer-events', 'none')
                .attr('aria-disabled', 'true');
        }

        // Wire mode radio change.
        $stage
            .find('input[name="bcw_postprocess_mode"]')
            .on('change', function () {
                const newMode = String($(this).val() ?? 'replace');
                wizardState.update({ postProcessMode: newMode });
                power_user.group_card_post_process_mode = newMode;
                saveSettingsDebounced();
            });

        // Wire skip banner (click + keyboard).
        const skipHandler = () => skipToStage4($content, wizardState);
        $stage
            .find('#bcw_polish_skip')
            .on('click', skipHandler)
            .on('keydown', function (event) {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    skipHandler();
                }
            });

        // Wire Apply button.
        $applyButton.on('click', async function () {
            const $btn = $(this);
            if ($btn.hasClass('disabled')) {
                return;
            }
            $btn
                .addClass('disabled')
                .css('pointer-events', 'none')
                .text('Processing…');
            try {
                await applyPostProcessing($content, $stage, wizardState);
            } finally {
                $btn
                    .removeClass('disabled')
                    .css('pointer-events', '')
                    .text('Apply Post-Merge');
            }
        });
    },

    /**
     * Called when Stage 3 becomes active. Auto-skips to Stage 4 when
     * post-merge is disabled in the config.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the entry hook completes.
     */
    async onEnter(popupContent, wizardState) {
        if (!wizardState.config.postMergeEnabled) {
            await skipToStage4($(popupContent), wizardState);
        }
    },

    /**
     * Read the Stage 3 form into the wizard state. Syncs `postMergePrompt`
     * and `postProcessMode` into the config. `postProcessResult` is already
     * set by {@link applyPostProcessing} or the skip banner.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {object} Config snapshot for external inspection.
     */
    collectConfig(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_3');
        const prompt = String(
            $stage.find('#bcw_postmerge_prompt').val() ?? '',
        ).trim();
        const mode = String(
            $stage.find('input[name="bcw_postprocess_mode"]:checked').val() ??
                'replace',
        );
        const validMode = VALID_MODES.includes(mode) ? mode : 'replace';

        // Sync config-level fields into wizard state.
        wizardState.update({
            postMergePrompt: prompt,
            postProcessMode: validMode,
        });

        return {
            postMergePrompt: prompt,
            postProcessMode: validMode,
            postProcessResult: wizardState.state.postProcessResult,
        };
    },

    /**
     * Require a non-empty `postProcessResult` (set by Apply or skip).
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {boolean} `true` when valid.
     */
    validate(popupContent, wizardState) {
        const result = wizardState.state.postProcessResult;
        if (!result || !String(result).trim()) {
            globalThis.toastr?.warning?.(
                'Apply the post-merge pass or skip this step.',
                'Combine into Group Card',
            );
            return false;
        }
        return true;
    },

    /**
     * Hook executed when leaving Stage 3. No active resources to clean up —
     * the post-merge pass is a single LLM call.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {void}
     */
    onExit(popupContent, wizardState) {
        // No-op: no SSE connections, intervals, or watchers to tear down.
    },
};
