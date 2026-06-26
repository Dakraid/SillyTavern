import { characterGroupOverlay, getVirtualCharacterList } from '../script.js';
import {
    BulkEditOverlay,
    BulkEditOverlayState,
    CharacterContextMenu,
} from './BulkEditOverlay.js';
import { event_types, eventSource } from './events.js';

let is_bulk_edit = false;

const enableBulkEdit = () => {
    enableBulkSelect();
    characterGroupOverlay.selectState();
    // show the bulk edit option buttons
    $('.bulkEditOptionElement').show();
    is_bulk_edit = true;
    characterGroupOverlay.updateSelectedCount(0);
};

const disableBulkEdit = () => {
    disableBulkSelect();
    characterGroupOverlay.browseState();
    // hide the bulk edit option buttons
    $('.bulkEditOptionElement').hide();
    is_bulk_edit = false;
    characterGroupOverlay.updateSelectedCount(0);
};

const toggleBulkEditMode = (isBulkEdit) => {
    if (isBulkEdit) {
        disableBulkEdit();
    } else {
        enableBulkEdit();
    }
};

/**
 * Toggles bulk edit mode on/off when the edit button is clicked.
 */
function onEditButtonClick() {
    console.log('Edit button clicked');
    toggleBulkEditMode(is_bulk_edit);
}

/**
 * Toggles the select state of all characters in bulk edit mode to selected. If all are selected, they'll be deselected.
 */
function onSelectAllButtonClick() {
    console.log('Bulk select all button clicked');
    const vcl = getVirtualCharacterList();
    const entities = vcl ? vcl.getEntities() : [];
    const allCharacterIds = entities
        .filter((entity) => entity.type === 'character')
        .map((entity) => entity.id);
    const selectedSet = new Set(characterGroupOverlay.selectedCharacters);
    const allSelected = allCharacterIds.every((id) => selectedSet.has(id));

    if (allSelected) {
        characterGroupOverlay.selectedCharacters.splice(
            0,
            characterGroupOverlay.selectedCharacters.length,
            ...characterGroupOverlay.selectedCharacters.filter(
                (id) => !allCharacterIds.includes(id),
            ),
        );
    } else {
        for (const id of allCharacterIds) {
            if (!selectedSet.has(id)) {
                characterGroupOverlay.selectedCharacters.push(id);
            }
        }
    }

    characterGroupOverlay.updateSelectedCount();

    if (vcl) {
        vcl.applySelectionState(
            characterGroupOverlay.selectedCharacters,
            BulkEditOverlay.selectedClass,
        );
    }
}

/**
 * Deletes all characters that have been selected via the bulk checkboxes.
 */
async function onDeleteButtonClick() {
    console.log('Delete button clicked');

    // We just let the button trigger the context menu delete option
    await characterGroupOverlay.handleContextMenuDelete();
}

/**
 * Combines the selected characters into a group card via the combine wizard.
 */
async function onCombineButtonClick() {
    console.log('Combine button clicked');

    // Delegate to the context menu handler, which validates the selection
    // (requires at least two valid characters) and opens the combine wizard.
    await characterGroupOverlay.handleContextMenuCombineGroupCard();
}

/**
 * Enables bulk selection by adding a checkbox next to each character.
 */
function enableBulkSelect() {
    $('#rm_print_characters_block .character_select').each((_i, el) => {
        // Prevent checkbox from adding multiple times (because of stage change callback)
        if ($(el).find('.bulk_select_checkbox').length > 0) {
            return;
        }
        const checkbox = $('<input type=\'checkbox\' class=\'bulk_select_checkbox\'>');
        checkbox.on('change', () => {
            // Do something when the checkbox is changed
        });
        $(el).prepend(checkbox);
    });
    $(
        '#rm_print_characters_block.group_overlay_mode_select .bogus_folder_select, #rm_print_characters_block.group_overlay_mode_select .group_select',
    ).addClass('disabled');

    $('#rm_print_characters_block').addClass('bulk_select');
    // We also need to disable the default click event for the character_select divs
    $(document).on('click', '.bulk_select_checkbox', function (event) {
        event.stopImmediatePropagation();
    });

    const vcl = getVirtualCharacterList();
    if (vcl) {
        vcl.applySelectionState(
            characterGroupOverlay.selectedCharacters,
            BulkEditOverlay.selectedClass,
        );
    }
}

/**
 * Disables bulk selection by removing the checkboxes.
 */
function disableBulkSelect() {
    $('.bulk_select_checkbox').remove();
    $(
        '#rm_print_characters_block.group_overlay_mode_select .bogus_folder_select, #rm_print_characters_block.group_overlay_mode_select .group_select',
    ).removeClass('disabled');
    $('#rm_print_characters_block').removeClass('bulk_select');
}

/**
 * Entry point that runs on page load.
 */
export function initBulkEdit() {
    characterGroupOverlay.addStateChangeCallback((state) => {
        if (state === BulkEditOverlayState.select) enableBulkEdit();
        if (state === BulkEditOverlayState.browse) disableBulkEdit();
    });

    $('#bulkEditButton').on('click', onEditButtonClick);
    $('#bulkSelectAllButton').on('click', onSelectAllButtonClick);
    $('#bulkDeleteButton').on('click', onDeleteButtonClick);
    $('#bulkCombineButton').on('click', onCombineButtonClick);

    const characterContextMenu = new CharacterContextMenu(characterGroupOverlay);
    eventSource.on(
        event_types.CHARACTER_PAGE_LOADED,
        characterGroupOverlay.onPageLoad,
    );
    console.debug('Character context menu initialized', characterContextMenu);
}
