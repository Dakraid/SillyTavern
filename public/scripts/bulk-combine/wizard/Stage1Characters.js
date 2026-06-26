'use strict';

/**
 * @file Stage 1 — Character Selection & Setup.
 *
 * Implements the shared stage-module contract (`render`, `collectConfig`,
 * `validate`, `onEnter`, `onExit`). Renders the draggable character card
 * strip with add/remove via search, the group name input, the combine prompt
 * with a preset toolbar, and a collapsible Advanced Options section
 * (included fields, concurrency, lorebook, fallback tags, minify, crop).
 *
 * Card order determines avatar cell order in Stage 5.
 */

import {
    characters,
    getThumbnailUrl,
    unshallowCharacter,
} from '../../../script.js';
import { callGenericPopup, POPUP_TYPE } from '../../popup.js';
import {
    DEFAULT_GROUP_CARD_COMBINE_PROMPT,
    power_user,
} from '../../power-user.js';
import {
    OPTIONAL_CHARACTER_FIELDS,
    getCharacterName,
    normalizeName,
} from '../helpers.js';
import {
    deleteGroupCardCombinePromptPreset,
    findGroupCardCombinePromptPresetIndex,
    getGroupCardCombinePromptPresets,
    renderGroupCardCombinePromptPresetSelect,
    saveGroupCardCombinePromptPreset,
} from '../services/PresetManager.js';
import { attachDragHandlers, createCharacterCard } from '../components/CharacterCard.js';
import { initCollapsible } from '../components/CollapsibleSection.js';

/** @type {string|null} Cached stage 1 template HTML. */
let stage1TemplateHtml = null;

/** Valid crop strategy values (must match the stage1.html options). */
const VALID_CROP_STRATEGIES = Object.freeze([
    'attention',
    'entropy',
    'center',
    'top',
    'face',
]);

/** Maximum number of entries shown in the available-character list. */
const AVAILABLE_LIST_LIMIT = 50;

/**
 * Fetch and cache the stage 1 template.
 *
 * @returns {Promise<string>} Stage 1 template HTML.
 */
async function loadStage1Template() {
    if (stage1TemplateHtml) {
        return stage1TemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/stage1.html');
    stage1TemplateHtml = await response.text();
    return stage1TemplateHtml;
}

/**
 * Clamp a concurrency value to a valid integer in the 1–50 range.
 *
 * @param {unknown} value Concurrency candidate.
 * @returns {number} Clamped concurrency.
 */
function clampConcurrency(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.round(n))) : 10;
}

/**
 * Clamp a crop padding value to a valid integer in the 0–50 range.
 *
 * @param {unknown} value Crop padding candidate.
 * @returns {number} Clamped crop padding.
 */
function clampCropPadding(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(50, Math.round(n))) : 15;
}

/**
 * Map the lorebook booleans to the radio-group mode.
 *
 * @param {object} config Wizard config.
 * @returns {'dynamic'|'static'|'none'} Lorebook mode.
 */
function resolveLorebookMode(config) {
    if (config?.dynamicLorebook) {
        return 'dynamic';
    }
    if (config?.createLorebook) {
        return 'static';
    }
    return 'none';
}

/**
 * Parse a comma-separated tag string into a clean list.
 *
 * @param {unknown} value Input value.
 * @returns {string[]} Parsed tags.
 */
function parseFallbackTags(value) {
    return String(value ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
}

/**
 * Create a clickable available-character list item.
 *
 * @param {object} character Character object.
 * @param {number} id Character id.
 * @returns {JQuery<HTMLElement>} Available-character item element.
 */
function createAvailableCharacterItem(character, id) {
    const name = getCharacterName(character);
    const avatarUrl = getThumbnailUrl('avatar', character?.avatar ?? '');
    return $('<div></div>')
        .addClass('bcw-available-character')
        .css({
            display: 'flex',
            alignItems: 'center',
            gap: '0.5em',
            padding: '0.3em 0.5em',
            cursor: 'pointer',
            borderRadius: '6px',
        })
        .attr('data-character-id', String(id))
        .attr('role', 'button')
        .attr('tabindex', '0')
        .attr('title', `Add ${name}`)
        .append(
            $('<img>')
                .addClass('avatar')
                .attr('alt', name)
                .attr('src', avatarUrl),
        )
        .append($('<span></span>').addClass('name').text(name))
        .append($('<i></i>').addClass('fa-solid fa-plus bcw-add-icon'));
}

/**
 * Wire the combine prompt preset toolbar (load / save / delete / restore).
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 1 panel element.
 * @returns {void}
 */
function wirePresetControls($stage) {
    const $select = $stage.find('#bcw_prompt_preset_select');
    const $save = $stage.find('#bcw_prompt_preset_save');
    const $delete = $stage.find('#bcw_prompt_preset_delete');
    const $restore = $stage.find('#bcw_prompt_preset_restore');
    const $prompt = $stage.find('#bcw_prompt');

    renderGroupCardCombinePromptPresetSelect($select);

    $select.on('change', () => {
        const index = Number($select.val());
        const preset = getGroupCardCombinePromptPresets()[index];
        if (preset) {
            $prompt.val(preset.prompt);
        }
    });

    $save.on('click', async () => {
        const currentIndex = Number($select.val());
        const currentPreset = getGroupCardCombinePromptPresets()[currentIndex];
        const name = await callGenericPopup(
            'Enter a prompt preset name:',
            POPUP_TYPE.INPUT,
            currentPreset?.name ?? '',
            { okButton: 'Save', cancelButton: 'Cancel' },
        );
        if (!name || typeof name !== 'string') {
            return;
        }
        const saved = await saveGroupCardCombinePromptPreset(
            name,
            String($prompt.val() ?? ''),
        );
        if (!saved) {
            return;
        }
        const savedIndex = findGroupCardCombinePromptPresetIndex(saved.name);
        renderGroupCardCombinePromptPresetSelect($select, savedIndex);
    });

    $delete.on('click', () => {
        const index = Number($select.val());
        if (deleteGroupCardCombinePromptPreset(index)) {
            renderGroupCardCombinePromptPresetSelect($select);
        }
    });

    $restore.on('click', () => {
        $prompt.val(DEFAULT_GROUP_CARD_COMBINE_PROMPT);
    });
}

/**
 * Populate and wire the collapsible Advanced Options section from the config.
 *
 * @param {JQuery<HTMLElement>} $stage The Stage 1 panel element.
 * @param {object} config Wizard config.
 * @returns {void}
 */
function wireAdvancedOptions($stage, config) {
    // Included fields
    const selectedOptional = Array.isArray(config?.selectedOptionalFields)
        ? config.selectedOptionalFields
        : ['personality'];
    $stage.find('#bcw_included_fields input[type="checkbox"]').each(function () {
        const field = String($(this).attr('data-field') ?? '');
        $(this).prop('checked', selectedOptional.includes(field));
    });

    // Concurrency
    $stage.find('#bcw_concurrency').val(String(clampConcurrency(config?.concurrency)));

    // Lorebook radio group
    const lorebookMode = resolveLorebookMode(config);
    $stage
        .find(`input[name="bcw_lorebook"][value="${lorebookMode}"]`)
        .prop('checked', true);

    // Summary fallback tags
    const tags = Array.isArray(config?.summaryFallbackTags)
        ? config.summaryFallbackTags
        : ['summary'];
    $stage.find('#bcw_fallback_tags').val(tags.join(', '));

    // XML minify + single-line sub-option
    const minify = Boolean(config?.minify);
    $stage.find('#bcw_minify').prop('checked', minify);
    $stage.find('#bcw_minify_single_line').prop('checked', Boolean(config?.minifySingleLine));
    const $singleLineLabel = $stage.find('#bcw_minify_single_line_label');
    $singleLineLabel.toggle(minify);
    $stage.find('#bcw_minify').on('change', function () {
        const enabled = Boolean($(this).prop('checked'));
        $singleLineLabel.toggle(enabled);
        if (!enabled) {
            $stage.find('#bcw_minify_single_line').prop('checked', false);
        }
    });

    // Crop strategy
    const cropStrategy = VALID_CROP_STRATEGIES.includes(config?.cropStrategy)
        ? config.cropStrategy
        : 'attention';
    $stage.find('#bcw_crop_strategy').val(cropStrategy);

    // Crop padding slider + live value display
    const cropPadding = clampCropPadding(config?.cropPadding);
    $stage.find('#bcw_crop_padding').val(cropPadding);
    $stage.find('#bcw_crop_padding_value').text(String(cropPadding));
    $stage.find('#bcw_crop_padding').on('input', function () {
        $stage.find('#bcw_crop_padding_value').text(String($(this).val()));
    });
}

/**
 * Stage 1 controller object following the shared stage-module contract.
 */
export const Stage1Characters = {
    /**
     * Populate the Stage 1 panel DOM.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the panel is fully rendered.
     */
    async render(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_1');
        const config = wizardState.config;
        const html = await loadStage1Template();
        $stage.html(html);

        // Unshallow any initially-selected characters so avatars/names resolve.
        await Promise.all(
            wizardState.state.selectedCharacterIds
                .filter((id) => characters[id]?.shallow)
                .map((id) => unshallowCharacter(String(id))),
        );

        // Working copy of the selected character id order.
        let currentIds = [...wizardState.state.selectedCharacterIds];

        const $strip = $stage.find('#bcw_character_strip');
        const $search = $stage.find('#bcw_character_search');
        const $availableList = $stage.find('#bcw_available_list')
            .css({ maxHeight: '200px', overflowY: 'auto' });

        const syncIds = () => {
            wizardState.updateField('selectedCharacterIds', [...currentIds]);
        };

        const renderStrip = () => {
            $strip.empty();
            for (const id of currentIds) {
                const character = characters[id];
                if (!character) {
                    continue;
                }
                const $card = createCharacterCard(id, { character });
                $card.find('.bcw-remove-button').on('click', () => removeCharacter(id));
                $card.find('.bcw-remove-button').on('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        removeCharacter(id);
                    }
                });
                $strip.append($card);
            }
            attachDragHandlers($strip, handleReorder);
        };

        const renderAvailableList = () => {
            const query = String($search.val() ?? '').trim().toLowerCase();
            const selectedSet = new Set(currentIds);
            $availableList.empty();

            const available = characters
                .map((character, id) => ({ character, id }))
                .filter(({ character, id }) => {
                    if (selectedSet.has(id)) {
                        return false;
                    }
                    const name = normalizeName(getCharacterName(character));
                    if (!name) {
                        return false;
                    }
                    return !query || name.includes(query);
                })
                .slice(0, AVAILABLE_LIST_LIMIT);

            for (const { character, id } of available) {
                const $item = createAvailableCharacterItem(character, id);
                $item.on('click', () => addCharacter(id));
                $item.on('keydown', function (event) {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        addCharacter(id);
                    }
                });
                $availableList.append($item);
            }

            if (available.length === 0) {
                $availableList.append(
                    $('<small></small>').text(
                        query ? 'No matching characters.' : 'No more characters to add.',
                    ),
                );
            }
        };

        const addCharacter = (id) => {
            if (currentIds.includes(id)) {
                return;
            }
            currentIds.push(id);
            syncIds();
            renderStrip();
            renderAvailableList();
            // If the character is shallow, fetch full data then re-render.
            if (characters[id]?.shallow) {
                unshallowCharacter(String(id)).then(() => {
                    renderStrip();
                    renderAvailableList();
                });
            }
        };

        const removeCharacter = (id) => {
            currentIds = currentIds.filter((cid) => cid !== id);
            syncIds();
            renderStrip();
            renderAvailableList();
        };

        const handleReorder = (newOrder) => {
            currentIds = newOrder;
            syncIds();
        };

        renderStrip();
        renderAvailableList();

        $search.off('input.bcwStage1').on('input.bcwStage1', renderAvailableList);

        // Group name
        $stage.find('#bcw_group_name').val(config?.groupName ?? '');

        // Combine prompt (fall back to the stored default, then the built-in default)
        const promptDefault =
            power_user.group_card_combine_prompt ?? DEFAULT_GROUP_CARD_COMBINE_PROMPT;
        $stage.find('#bcw_prompt').val(config?.prompt ?? promptDefault);

        // Preset toolbar
        wirePresetControls($stage);

        // Advanced options + collapsible wiring
        wireAdvancedOptions($stage, config);
        initCollapsible($stage.find('#bcw_advanced_options_header'));
    },

    /**
     * Read the Stage 1 form into a config patch.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {object} Config patch.
     */
    collectConfig(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_1');
        const lorebookMode = String(
            $stage.find('input[name="bcw_lorebook"]:checked').val() ?? 'none',
        );

        const selectedOptionalFields = $stage
            .find('#bcw_included_fields input[type="checkbox"]')
            .toArray()
            .filter((el) => $(el).prop('checked'))
            .map((el) => String($(el).attr('data-field') ?? ''))
            .filter((field) => OPTIONAL_CHARACTER_FIELDS.includes(field));

        const fallbackTags = parseFallbackTags($stage.find('#bcw_fallback_tags').val());

        const cropStrategyValue = String($stage.find('#bcw_crop_strategy').val() ?? '');

        return {
            groupName: String($stage.find('#bcw_group_name').val() ?? '').trim(),
            prompt: String($stage.find('#bcw_prompt').val() ?? '').trim(),
            concurrency: clampConcurrency($stage.find('#bcw_concurrency').val()),
            selectedOptionalFields,
            createLorebook: lorebookMode !== 'none',
            dynamicLorebook: lorebookMode === 'dynamic',
            summaryFallbackTags: fallbackTags.length > 0 ? fallbackTags : ['summary'],
            minify: Boolean($stage.find('#bcw_minify').prop('checked')),
            minifySingleLine: Boolean(
                $stage.find('#bcw_minify_single_line').prop('checked'),
            ),
            cropStrategy: VALID_CROP_STRATEGIES.includes(cropStrategyValue)
                ? cropStrategyValue
                : 'attention',
            cropPadding: clampCropPadding($stage.find('#bcw_crop_padding').val()),
        };
    },

    /**
     * Validate the Stage 1 form before transitioning forward.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {boolean} `true` when the form is valid.
     */
    validate(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_1');
        const toaster = globalThis.toastr;

        // Count rendered cards rather than raw state ids so deleted or
        // otherwise invalid characters are excluded.
        const charCount = $stage.find('#bcw_character_strip .bcw-character-card').length;
        if (charCount < 2) {
            toaster?.warning?.(
                'Select at least two valid characters.',
                'Combine into Group Card',
            );
            return false;
        }

        const groupName = String($stage.find('#bcw_group_name').val() ?? '').trim();
        if (!groupName) {
            toaster?.warning?.('Enter a group card name.', 'Combine into Group Card');
            return false;
        }

        const prompt = String($stage.find('#bcw_prompt').val() ?? '').trim();
        if (!prompt) {
            toaster?.warning?.('Enter a prompt.', 'Combine into Group Card');
            return false;
        }

        return true;
    },

    /**
     * Hook executed when entering Stage 1.
     *
     * @returns {void}
     */
    onEnter() {},

    /**
     * Hook executed when leaving Stage 1.
     *
     * @returns {void}
     */
    onExit() {},
};
