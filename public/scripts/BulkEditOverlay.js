'use strict';

import {
    characterGroupOverlay,
    characters,
    event_types,
    eventSource,
    getCharacters,
    getRequestHeaders,
    buildAvatarList,
    characterToEntity,
    printCharactersDebounced,
    deleteCharacter,
    getVirtualCharacterList,
    getEntitiesList,
} from '../script.js';

import { favsToHotswap } from './RossAscends-mods.js';
import { loader } from './action-loader.js';
import { convertCharacterToPersona } from './personas.js';
import { callGenericPopup, POPUP_TYPE } from './popup.js';
import {
    createTagInput,
    getTagKeyForEntity,
    getTagsList,
    printTagList,
    tag_map,
    compareTagsForSort,
    removeTagFromMap,
    importTags,
    tag_import_setting,
} from './tags.js';
import { t } from './i18n.js';
import {
    getGroupCardWizardMetadata,
    getCoreCharacterField,
} from './bulk-combine/helpers.js';

import { openCombineWizard } from './bulk-combine/index.js';
import { openTaskWizard } from './bulk-combine/wizard/TaskWizardController.js';

/**
 * Triggers a browser download for a Blob.
 * @param {Blob} blob File data to download.
 * @param {string} filename Download filename.
 */
function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}

let globalJobEventSource = null;

/**
 * Static object representing the actions of the
 * character context menu override.
 */
class CharacterContextMenu {
    /**
	 * Tag one or more characters,
	 * opens a popup.
	 *
	 * @param {Array<number>} selectedCharacters
	 */
    static tag = (selectedCharacters) => {
        characterGroupOverlay.bulkTagPopupHandler.show(selectedCharacters);
    };

    /**
	 * Duplicate one or more characters
	 *
	 * @param {number} characterId
	 * @returns {Promise<any>}
	 */
    static duplicate = async (characterId) => {
        const character = CharacterContextMenu.#getCharacter(characterId);
        const body = { avatar_url: character.avatar };

        const result = await fetch('/api/characters/duplicate', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(body),
        });

        if (!result.ok) {
            throw new Error('Character not duplicated');
        }

        const data = await result.json();
        await eventSource.emit(event_types.CHARACTER_DUPLICATED, {
            oldAvatar: body.avatar_url,
            newAvatar: data.path,
        });
    };

    /**
	 * Download a character card as PNG.
	 *
	 * @param {number} characterId
	 * @returns {Promise<void>}
	 */
    static download = async (characterId) => {
        const character = CharacterContextMenu.#getCharacter(characterId);
        const response = await fetch(
            `/characters/${encodeURIComponent(character.avatar)}`,
        );

        if (!response.ok) {
            throw new Error('Failed to download character');
        }

        const blob = await response.blob();
        downloadBlob(blob, character.avatar);
    };

    /**
     * Re-opens the durable Bulk Combine task that created a character.
     *
     * @param {number} characterId
     * @returns {Promise<void>}
     */
    static rerunBulkCombine = async (characterId) => {
        const taskId = CharacterContextMenu.#getCharacter(characterId)?.data?.extensions?.bulk_combine_task;
        if (!taskId) {
            return;
        }

        try {
            await openTaskWizard(String(taskId));
        } catch (error) {
            console.error('Failed to re-open the source Bulk Combine task.', error);
            const message = String(error?.message ?? error);
            if (message.includes('task_not_found')) {
                toastr.error(
                    t`The source combine task no longer exists.`,
                    t`Combine into Group Card`,
                );
                return;
            }
            toastr.error(
                t`Failed to open the source combine task.`,
                t`Combine into Group Card`,
            );
        }
    };

    /**
	 * Favorite a character
	 * and highlight it.
	 *
	 * @param {number} characterId
	 * @returns {Promise<void>}
	 */
    static favorite = async (characterId) => {
        const character = CharacterContextMenu.#getCharacter(characterId);
        const newFavState = !character.data.extensions.fav;

        const data = {
            name: character.name,
            avatar: character.avatar,
            data: {
                extensions: {
                    fav: newFavState,
                },
            },
            fav: newFavState,
        };

        const mergeResponse = await fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(data),
        });

        if (!mergeResponse.ok) {
            mergeResponse
                .json()
                .then((json) =>
                    toastr.error(
                        `Character not saved. Error: ${json.message}. Field: ${json.error}`,
                    ),
                );
        }

        const element = document.getElementById(`CharID${characterId}`);
        element.classList.toggle('is_fav');
    };

    /**
	 * Convert one or more characters to persona,
	 * may open a popup for one or more characters.
	 *
	 * @param {number} characterId
	 * @returns {Promise<void>}
	 */
    static persona = async (characterId) =>
        void (await convertCharacterToPersona(characterId));

    /**
	 * Delete one or more characters,
	 * opens a popup.
	 *
	 * @param {string|string[]} characterKey
	 * @param {boolean} [deleteChats]
	 * @returns {Promise<void>}
	 */
    static delete = async (characterKey, deleteChats = false) => {
        await deleteCharacter(characterKey, { deleteChats: deleteChats });
    };

    static #getCharacter = (characterId) => characters[characterId] ?? null;

    /**
	 * Show the context menu at the given position
	 *
	 * @param positionX
	 * @param positionY
	 */
    static show = (positionX, positionY, characterId = null) => {
        let contextMenu = document.getElementById(BulkEditOverlay.contextMenuId);
        contextMenu.style.left = `${positionX}px`;
        contextMenu.style.top = `${positionY}px`;

        const rerunButton = document.getElementById('character_context_menu_bulk_combine_rerun');
        const canRerun = Boolean(
            CharacterContextMenu.#getCharacter(characterId)?.data?.extensions?.bulk_combine_task,
        );
        rerunButton.disabled = !canRerun;
        rerunButton.closest('li')?.classList.toggle('hidden', !canRerun);

        document
            .getElementById(BulkEditOverlay.contextMenuId)
            .classList.remove('hidden');

        // Adjust position if context menu is outside of viewport
        const boundingRect = contextMenu.getBoundingClientRect();
        if (boundingRect.right > window.innerWidth) {
            contextMenu.style.left = `${positionX - (boundingRect.right - window.innerWidth)}px`;
        }
        if (boundingRect.bottom > window.innerHeight) {
            contextMenu.style.top = `${positionY - (boundingRect.bottom - window.innerHeight)}px`;
        }
    };

    /**
	 * Hide the context menu
	 */
    static hide = () =>
        document
            .getElementById(BulkEditOverlay.contextMenuId)
            .classList.add('hidden');

    /**
	 * Sets up the context menu for the given overlay
	 *
	 * @param characterGroupOverlay
	 */
    constructor(characterGroupOverlay) {
        const contextMenuItems = [
            {
                id: 'character_context_menu_favorite',
                callback: characterGroupOverlay.handleContextMenuFavorite,
            },
            {
                id: 'character_context_menu_duplicate',
                callback: characterGroupOverlay.handleContextMenuDuplicate,
            },
            {
                id: 'character_context_menu_download',
                callback: characterGroupOverlay.handleContextMenuDownload,
            },
            {
                id: 'character_context_menu_persona',
                callback: characterGroupOverlay.handleContextMenuPersona,
            },
            {
                id: 'character_context_menu_bulk_combine_rerun',
                callback: characterGroupOverlay.handleContextMenuRerunBulkCombine,
            },
            {
                id: 'bulk_select_combine_group_card',
                callback: characterGroupOverlay.handleContextMenuCombineGroupCard,
            },
            {
                id: 'character_context_menu_delete',
                callback: characterGroupOverlay.handleContextMenuDelete,
            },
            {
                id: 'character_context_menu_tag',
                callback: characterGroupOverlay.handleContextMenuTag,
            },
        ];

        contextMenuItems.forEach((contextMenuItem) =>
            document
                .getElementById(contextMenuItem.id)
                .addEventListener('click', contextMenuItem.callback),
        );
    }
}

/**
 * Represents a tag control not bound to a single character
 */
class BulkTagPopupHandler {
    /**
	 * The characters for this popup
	 * @type {number[]}
	 */
    characterIds;

    /**
	 * A storage of the current mutual tags, as calculated by getMutualTags()
	 * @type {object[]}
	 */
    currentMutualTags;

    /**
	 * Sets up the bulk popup menu handler for the given overlay.
	 *
	 * Characters can be passed in with the show() call.
	 */
    constructor() {}

    /**
	 * Gets the HTML as a string that is going to be the popup for the bulk tag edit
	 *
	 * @returns String containing the html for the popup
	 */
    #getHtml = () => {
        const characterData = JSON.stringify({ characterIds: this.characterIds });
        return `<div id="bulk_tag_shadow_popup">
            <div id="bulk_tag_popup" class="wider_dialogue_popup">
                <div id="bulk_tag_popup_holder">
                    <h3 class="marginBot5">Modify tags of ${this.characterIds.length} characters</h3>
                    <small class="bulk_tags_desc m-b-1">Add or remove the mutual tags of all selected characters. Import all or existing tags for all selected characters.</small>
                    <div id="bulk_tags_avatars_block" class="avatars_inline avatars_inline_small tags tags_inline"></div>
                    <br>
                    <div id="bulk_tags_div" class="marginBot5" data-characters='${characterData}'>
                        <div class="tag_controls">
                            <input id="bulkTagInput" class="text_pole tag_input wide100p margin0" data-i18n="[placeholder]Search / Create Tags" placeholder="Search / Create tags" maxlength="25" />
                            <div class="tags_view menu_button fa-solid fa-tags" title="View all tags" data-i18n="[title]View all tags"></div>
                        </div>
                        <div id="bulkTagList" class="m-t-1 tags"></div>
                    </div>
                    <div id="dialogue_popup_controls" class="m-t-1">
                        <div id="bulk_tag_popup_reset" class="menu_button" title="Remove all tags from the selected characters" data-i18n="[title]Remove all tags from the selected characters">
                            <i class="fa-solid fa-trash-can margin-right-10px"></i>
                            All
                        </div>
                        <div id="bulk_tag_popup_remove_mutual" class="menu_button" title="Remove all mutual tags from the selected characters" data-i18n="[title]Remove all mutual tags from the selected characters">
                            <i class="fa-solid fa-trash-can margin-right-10px"></i>
                            Mutual
                        </div>
                        <div id="bulk_tag_popup_import_all_tags" class="menu_button" title="Import all tags from selected characters" data-i18n="[title]Import all tags from selected characters">
                            Import All
                        </div>
                        <div id="bulk_tag_popup_import_existing_tags" class="menu_button" title="Import existing tags from selected characters" data-i18n="[title]Import existing tags from selected characters">
                            Import Existing
                        </div>
                        <div id="bulk_tag_popup_cancel" class="menu_button" data-i18n="Cancel">Close</div>
                    </div>
                </div>
            </div>
        </div>`;
    };

    /**
	 * Append and show the tag control
	 *
	 * @param {number[]} characterIds - The characters that are shown inside the popup
	 */
    show(characterIds) {
        // shallow copy character ids persistently into this tooltip
        this.characterIds = characterIds.slice();

        if (this.characterIds.length == 0) {
            console.log('No characters selected for bulk edit tags.');
            return;
        }

        document.body.append(
            document.createRange().createContextualFragment(this.#getHtml()),
        );

        const entities = this.characterIds
            .map((id) => characterToEntity(characters[id], id))
            .filter((entity) => entity.item !== undefined);
        buildAvatarList($('#bulk_tags_avatars_block'), entities);

        // Print the tag list with all mutuable tags, marking them as removable. That is the initial fill
        printTagList($('#bulkTagList'), {
            tags: () => this.getMutualTags(),
            tagOptions: { removable: true },
        });

        // Tag input with resolvable list for the mutual tags to get redrawn, so that newly added tags get sorted correctly
        createTagInput('#bulkTagInput', '#bulkTagList', {
            tags: () => this.getMutualTags(),
            tagOptions: { removable: true },
        });

        document
            .querySelector('#bulk_tag_popup_reset')
            .addEventListener('click', this.resetTags.bind(this));
        document
            .querySelector('#bulk_tag_popup_remove_mutual')
            .addEventListener('click', this.removeMutual.bind(this));
        document
            .querySelector('#bulk_tag_popup_cancel')
            .addEventListener('click', this.hide.bind(this));
        document
            .querySelector('#bulk_tag_popup_import_all_tags')
            .addEventListener('click', this.importAllTags.bind(this));
        document
            .querySelector('#bulk_tag_popup_import_existing_tags')
            .addEventListener('click', this.importExistingTags.bind(this));
    }

    /**
	 * Import existing tags for all selected characters
	 */
    async importExistingTags() {
        for (const characterId of this.characterIds) {
            await importTags(characters[characterId], {
                importSetting: tag_import_setting.ONLY_EXISTING,
            });
        }

        $('#bulkTagList').empty();
    }

    /**
	 * Import all tags for all selected characters
	 */
    async importAllTags() {
        for (const characterId of this.characterIds) {
            await importTags(characters[characterId], {
                importSetting: tag_import_setting.ALL,
            });
        }

        $('#bulkTagList').empty();
    }

    /**
	 * Builds a list of all tags that the provided characters have in common.
	 *
	 * @returns {Array<object>} A list of mutual tags
	 */
    getMutualTags() {
        if (this.characterIds.length == 0) {
            return [];
        }

        if (this.characterIds.length === 1) {
            // Just use tags of the single character
            return getTagsList(getTagKeyForEntity(this.characterIds[0]));
        }

        // Find mutual tags for multiple characters
        const allTags = this.characterIds.map((cid) =>
            getTagsList(getTagKeyForEntity(cid)),
        );
        const mutualTags = allTags.reduce((mutual, characterTags) =>
            mutual.filter((tag) => characterTags.some((cTag) => cTag.id === tag.id)),
        );

        this.currentMutualTags = mutualTags.sort(compareTagsForSort);
        return this.currentMutualTags;
    }

    /**
	 * Hide and remove the tag control
	 */
    hide() {
        let popupElement = document.querySelector('#bulk_tag_shadow_popup');
        if (popupElement) {
            document.body.removeChild(popupElement);
        }

        // No need to redraw here, all tags actions were redrawn when they happened
    }

    /**
	 * Empty the tag map for the given characters
	 */
    resetTags() {
        for (const characterId of this.characterIds) {
            const key = getTagKeyForEntity(characterId);
            if (key) tag_map[key] = [];
        }

        $('#bulkTagList').empty();

        printCharactersDebounced();
    }

    /**
	 * Remove the mutual tags for all given characters
	 */
    removeMutual() {
        const mutualTags = this.getMutualTags();

        for (const characterId of this.characterIds) {
            for (const tag of mutualTags) {
                removeTagFromMap(tag.id, characterId.toString());
            }
        }

        $('#bulkTagList').empty();

        printCharactersDebounced();
    }
}

class BulkEditOverlayState {
    /**
	 *
	 * @type {number}
	 */
    static browse = 0;

    /**
	 *
	 * @type {number}
	 */
    static select = 1;
}

/**
 * Implement a SingletonPattern, allowing access to the group overlay instance
 * from everywhere via (new CharacterGroupOverlay())
 *
 * @type {Readonly<BulkEditOverlay>}
 */
let bulkEditOverlayInstance = null;

class BulkEditOverlay {
    static containerId = 'rm_print_characters_block';
    static contextMenuId = 'character_context_menu';
    static characterClass = 'character_select';
    static groupClass = 'group_select';
    static bogusFolderClass = 'bogus_folder_select';
    static selectModeClass = 'group_overlay_mode_select';
    static selectedClass = 'character_selected';
    static legacySelectedClass = 'bulk_select_checkbox';
    static bulkSelectedCountId = 'bulkSelectedCount';

    static longPressDelay = 2500;

    #state = BulkEditOverlayState.browse;
    #longPress = false;
    #stateChangeCallbacks = [];
    #selectedCharacters = [];
    #bulkTagPopupHandler = new BulkTagPopupHandler();
    #chunkLoadHandler = () => {
        if (this.state === BulkEditOverlayState.select) {
            this.#rebindVisibleElements();
        }
    };

    /**
	 * @typedef {object} LastSelected - An object noting the last selected character and its state.
	 * @property {number} [characterId] - The character id of the last selected character.
	 * @property {boolean} [select] - The selected state of the last selected character. <c>true</c> if it was selected, <c>false</c> if it was deselected.
	 */

    /**
	 * @type {LastSelected} - An object noting the last selected character and its state.
	 */
    lastSelected = { characterId: undefined, select: undefined };

    /**
	 * Locks other pointer actions when the context menu is open
	 *
	 * @type {boolean}
	 */
    #contextMenuOpen = false;

    /**
	 * Whether the next character select should be skipped
	 *
	 * @type {boolean}
	 */
    #cancelNextToggle = false;

    /**
	 * @type HTMLElement
	 */
    container = null;

    get state() {
        return this.#state;
    }

    set state(newState) {
        if (this.#state === newState) return;

        eventSource
            .emit(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, newState)
            .then(() => {
                this.#state = newState;
                eventSource.emit(
                    event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER,
                    this.state,
                );
            });
    }

    get isLongPress() {
        return this.#longPress;
    }

    set isLongPress(longPress) {
        this.#longPress = longPress;
    }

    get stateChangeCallbacks() {
        return this.#stateChangeCallbacks;
    }

    /**
	 *
	 * @returns {number[]}
	 */
    get selectedCharacters() {
        return this.#selectedCharacters;
    }

    /**
	 * The instance of the bulk tag popup handler that handles tagging of all selected characters
	 *
	 * @returns {BulkTagPopupHandler}
	 */
    get bulkTagPopupHandler() {
        return this.#bulkTagPopupHandler;
    }

    static #initActiveJobsPanel = () => {
        const toggle = document.getElementById('active_jobs_toggle');
        const content = document.getElementById('active_jobs_content');
        if (!toggle || !content) {
            return;
        }

        toggle.addEventListener('click', () => {
            const isOpen = content.style.display !== 'none';
            content.style.display = isOpen ? 'none' : 'block';
            const icon = toggle.querySelector('.inline-drawer-icon');
            if (icon) {
                icon.classList.toggle('down', !isOpen);
                icon.classList.toggle('up', isOpen);
            }
            if (!isOpen) {
                BulkEditOverlay.#renderActiveJobsList();
            }
        });

        BulkEditOverlay.#renderActiveJobsList();
    };

    static #renderActiveJobsList = async () => {
        const container = document.getElementById('active_jobs_list');
        if (!container) {
            return;
        }

        try {
            const response = await fetch('/api/characters/jobs');
            if (!response.ok) {
                throw new Error('Failed to fetch jobs');
            }

            const { jobs = [] } = await response.json();
            const terminalStatuses = ['completed', 'failed', 'cancelled'];

            const badge = document.getElementById('active_jobs_badge');
            if (badge) {
                const active = jobs.filter(
                    (job) => !terminalStatuses.includes(job.status),
                ).length;
                badge.textContent = String(active);
                badge.style.display = active > 0 ? 'inline' : 'none';
            }

            container.replaceChildren();

            if (jobs.length === 0) {
                const empty = document.createElement('div');
                empty.className = 'active-jobs-empty';
                empty.textContent = 'No active tasks.';
                container.append(empty);
                return;
            }

            const list = document.createElement('div');
            list.className = 'active-jobs-list';
            jobs.forEach((job) => {
                const icon = '📖';
                const status = String(job.status ?? 'unknown');
                const statusClass = status.replace(/[^a-z0-9_-]/gi, '');
                const numericCreatedAt = Number(job.createdAt);
                const createdAt = Number.isFinite(numericCreatedAt)
                    ? numericCreatedAt
                    : Date.parse(String(job.createdAt));
                const elapsed = Number.isFinite(createdAt)
                    ? Math.max(0, Math.round((Date.now() - createdAt) / 1000))
                    : 0;
                const elapsedStr =
					elapsed < 60
					    ? `${elapsed}s`
					    : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
                const name =
					job.config?.groupName || job.config?.lorebookName || job.id;
                const isTerminal = terminalStatuses.includes(status);
                const item = document.createElement('div');
                item.className = 'active-job-item';

                const iconSpan = document.createElement('span');
                iconSpan.className = 'active-job-icon';
                iconSpan.textContent = icon;
                item.append(iconSpan);

                const nameSpan = document.createElement('span');
                nameSpan.className = 'active-job-name';
                nameSpan.textContent = String(name);
                item.append(nameSpan);

                const statusSpan = document.createElement('span');
                statusSpan.className = `active-job-status ${statusClass}`;
                statusSpan.textContent = status;
                item.append(statusSpan);

                const elapsedSmall = document.createElement('small');
                elapsedSmall.textContent = elapsedStr;
                item.append(elapsedSmall);

                if (!isTerminal) {
                    const cancelBtn = document.createElement('div');
                    cancelBtn.className = 'menu_button active-job-cancel';
                    cancelBtn.dataset.jobId = String(job.id);
                    cancelBtn.dataset.jobType = String(job.managerType);
                    cancelBtn.title = 'Cancel';
                    const iconElement = document.createElement('i');
                    iconElement.className = 'fa-solid fa-xmark';
                    cancelBtn.append(iconElement);
                    item.append(cancelBtn);
                }

                list.append(item);
            });
            container.append(list);

            container.querySelectorAll('.active-job-cancel').forEach((btn) => {
                if (!(btn instanceof HTMLElement)) {
                    return;
                }

                btn.addEventListener('click', async () => {
                    const jobId = btn.dataset.jobId;
                    if (!jobId) {
                        return;
                    }

                    const endpoint = `/api/worldinfo/ai-jobs/${encodeURIComponent(jobId)}/cancel`;
                    try {
                        await fetch(endpoint, {
                            method: 'POST',
                            headers: getRequestHeaders(),
                        });
                    } catch (e) {
                        console.error('Cancel failed:', e);
                    }
                    BulkEditOverlay.#renderActiveJobsList();
                });
            });
        } catch (error) {
            const empty = document.createElement('div');
            empty.className = 'active-jobs-empty';
            empty.textContent = 'Failed to load tasks.';
            container.replaceChildren(empty);
        }
    };

    static #initGlobalJobSync = () => {
        if (globalJobEventSource) {
            return;
        }

        globalJobEventSource = new EventSource('/api/characters/jobs/events');

        for (const eventName of ['state', 'job_started', 'job_completed', 'job_failed']) {
            globalJobEventSource.addEventListener(eventName, () => {
                BulkEditOverlay.#renderActiveJobsList();
            });
        }

        window.addEventListener('beforeunload', () => {
            globalJobEventSource?.close();
        });
    };

    constructor() {
        if (bulkEditOverlayInstance instanceof BulkEditOverlay)
            return bulkEditOverlayInstance;

        this.container = document.getElementById(BulkEditOverlay.containerId);

        eventSource.on(
            event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER,
            this.handleStateChange,
        );
        eventSource.on(event_types.CHARACTER_PAGE_LOADED, this.#chunkLoadHandler);
        BulkEditOverlay.#initActiveJobsPanel();
        BulkEditOverlay.#initGlobalJobSync();
        bulkEditOverlayInstance = Object.freeze(this);
    }

    /**
	 * Set the overlay to browse mode
	 */
    browseState = () => (this.state = BulkEditOverlayState.browse);

    /**
	 * Set the overlay to select mode
	 */
    selectState = () => (this.state = BulkEditOverlayState.select);

    /**
	 * Set up a Sortable grid for the loaded page
	 */
    onPageLoad = () => {
        if (this.state !== BulkEditOverlayState.select) {
            this.browseState();
        }

        const elements = this.#getEnabledElements();
        elements.forEach((element) =>
            element.addEventListener('touchstart', this.handleHold),
        );
        elements.forEach((element) =>
            element.addEventListener('mousedown', this.handleHold),
        );
        elements.forEach((element) =>
            element.addEventListener('contextmenu', this.handleDefaultContextMenu),
        );

        elements.forEach((element) =>
            element.addEventListener('touchend', this.handleLongPressEnd),
        );
        elements.forEach((element) =>
            element.addEventListener('mouseup', this.handleLongPressEnd),
        );
        elements.forEach((element) =>
            element.addEventListener('dragend', this.handleLongPressEnd),
        );
        elements.forEach((element) =>
            element.addEventListener('touchmove', this.handleLongPressEnd),
        );

        // Cohee: It only triggers when clicking on a margin between the elements?
        // Feel free to fix or remove this, I'm not sure how to.
        //this.container.addEventListener('click', this.handleCancelClick);
    };

    /**
	 * Handle state changes
	 *
	 *
	 */
    handleStateChange = () => {
        switch (this.state) {
            case BulkEditOverlayState.browse:
                this.container.classList.remove(BulkEditOverlay.selectModeClass);
                this.#contextMenuOpen = false;
                this.#enableClickEventsForCharacters();
                this.#enableClickEventsForGroups();
                this.clearSelectedCharacters();
                this.disableContextMenu();
                this.#disableBulkEditButtonHighlight();
                CharacterContextMenu.hide();
                break;
            case BulkEditOverlayState.select:
                this.container.classList.add(BulkEditOverlay.selectModeClass);
                this.#disableClickEventsForCharacters();
                this.#disableClickEventsForGroups();
                this.enableContextMenu();
                this.#enableBulkEditButtonHighlight();
                break;
        }

        this.stateChangeCallbacks.forEach((callback) => callback(this.state));
    };

    /**
	 * Block the browsers native context menu and
	 * set a click event to hide the custom context menu.
	 */
    enableContextMenu = () => {
        this.container.addEventListener('contextmenu', this.handleContextMenuShow);
        document.addEventListener('click', this.handleContextMenuHide);
    };

    /**
	 * Remove event listeners, allowing the native browser context
	 * menu to be opened.
	 */
    disableContextMenu = () => {
        this.container.removeEventListener(
            'contextmenu',
            this.handleContextMenuShow,
        );
        document.removeEventListener('click', this.handleContextMenuHide);
    };

    handleDefaultContextMenu = (event) => {
        if (this.isLongPress) {
            event.preventDefault();
            event.stopPropagation();
            return false;
        }
    };

    /**
	 * Opens menu on long-press.
	 *
	 * @param event - Pointer event
	 */
    handleHold = (event) => {
        if (0 !== event.button && event.type !== 'touchstart') return;
        if (this.#contextMenuOpen) {
            this.#contextMenuOpen = false;
            this.#cancelNextToggle = true;
            CharacterContextMenu.hide();
            return;
        }

        let cancel = false;

        const cancelHold = (event) => (cancel = true);
        this.container.addEventListener('mouseup', cancelHold);
        this.container.addEventListener('touchend', cancelHold);

        this.isLongPress = true;

        setTimeout(() => {
            if (this.isLongPress && !cancel) {
                if (this.state === BulkEditOverlayState.browse) {
                    this.selectState();
                } else if (this.state === BulkEditOverlayState.select) {
                    this.#contextMenuOpen = true;
                    const [x, y] = this.#getContextMenuPosition(event);
                    const characterId = this.selectedCharacters.length === 1
                        ? this.selectedCharacters[0]
                        : null;
                    CharacterContextMenu.show(x, y, characterId);
                }
            }

            this.container.removeEventListener('mouseup', cancelHold);
            this.container.removeEventListener('touchend', cancelHold);
        }, BulkEditOverlay.longPressDelay);
    };

    handleLongPressEnd = (event) => {
        this.isLongPress = false;
        if (this.#contextMenuOpen) event.stopPropagation();
    };

    handleCancelClick = () => {
        if (false === this.#contextMenuOpen)
            this.state = BulkEditOverlayState.browse;
        this.#contextMenuOpen = false;
    };

    /**
	 * Returns the position of the mouse/touch location
	 *
	 * @param event
	 * @returns {(boolean|number|*)[]}
	 */
    #getContextMenuPosition = (event) => [
        event.clientX || event.touches[0].clientX,
        event.clientY || event.touches[0].clientY,
    ];

    #stopEventPropagation = (event) => {
        if (this.#contextMenuOpen) {
            this.handleContextMenuHide(event);
        }
        event.stopPropagation();
    };

    #enableClickEventsForGroups = () =>
        this.#getDisabledElements().forEach((element) =>
            element.removeEventListener('click', this.#stopEventPropagation),
        );

    #disableClickEventsForGroups = () =>
        this.#getDisabledElements().forEach((element) =>
            element.addEventListener('click', this.#stopEventPropagation),
        );

    #enableClickEventsForCharacters = () =>
        this.#getEnabledElements().forEach((element) =>
            element.removeEventListener('click', this.toggleCharacterSelected),
        );

    #disableClickEventsForCharacters = () =>
        this.#getEnabledElements().forEach((element) =>
            element.addEventListener('click', this.toggleCharacterSelected),
        );

    #enableBulkEditButtonHighlight = () =>
        document
            .getElementById('bulkEditButton')
            .classList.add('bulk_edit_overlay_active');

    #disableBulkEditButtonHighlight = () =>
        document
            .getElementById('bulkEditButton')
            .classList.remove('bulk_edit_overlay_active');

    #getEnabledElements = () => [
        ...this.container.getElementsByClassName(BulkEditOverlay.characterClass),
    ];

    #getDisabledElements = () => [
        ...this.container.getElementsByClassName(BulkEditOverlay.groupClass),
        ...this.container.getElementsByClassName(BulkEditOverlay.bogusFolderClass),
    ];

    #rebindVisibleElements() {
        const elements = this.#getEnabledElements();
        elements.forEach((element) => {
            if (!element._bulkEditBound) {
                element._bulkEditBound = true;
                element.addEventListener('click', this.toggleCharacterSelected);
                element.addEventListener('touchstart', this.handleHold);
                element.addEventListener('mousedown', this.handleHold);
                element.addEventListener('contextmenu', this.handleDefaultContextMenu);
                element.addEventListener('touchend', this.handleLongPressEnd);
                element.addEventListener('mouseup', this.handleLongPressEnd);
                element.addEventListener('dragend', this.handleLongPressEnd);
                element.addEventListener('touchmove', this.handleLongPressEnd);
            }
        });

        this.container.querySelectorAll('.character_select').forEach((element) => {
            if (!element.querySelector('.bulk_select_checkbox')) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'bulk_select_checkbox';
                checkbox.addEventListener('click', (event) =>
                    event.stopImmediatePropagation(),
                );
                element.prepend(checkbox);
            }
        });

        const vcl = getVirtualCharacterList();
        if (vcl) {
            vcl.applySelectionState(
                this.selectedCharacters,
                BulkEditOverlay.selectedClass,
            );
        }
    }

    toggleCharacterSelected = (event) => {
        event.stopPropagation();

        const character = event.currentTarget;

        if (!this.#contextMenuOpen && !this.#cancelNextToggle) {
            if (event.shiftKey) {
                // Shift click might have selected text that we don't want to. Unselect it.
                document.getSelection().removeAllRanges();

                this.handleShiftClick(character);
            } else {
                this.toggleSingleCharacter(character);
            }
        }

        this.#cancelNextToggle = false;
    };

    /**
	 * When shift click was held down, this function handles the multi select of characters in a single click.
	 *
	 * If the last clicked character was deselected, and the current one was deselected too, it will deselect all currently selected characters between those two.
	 * If the last clicked character was selected, and the current one was selected too, it will select all currently not selected characters between those two.
	 * If the states do not match, nothing will happen.
	 *
	 * @param {HTMLElement} currentCharacter - The html element of the currently toggled character
	 */
    handleShiftClick = (currentCharacter) => {
        const characterId = Number(currentCharacter.getAttribute('data-chid'));
        const select = !this.selectedCharacters.includes(characterId);

        if (
            this.lastSelected.characterId >= 0 &&
			this.lastSelected.select !== undefined
        ) {
            // Only if select state and the last select state match we execute the range select
            if (select === this.lastSelected.select) {
                this.toggleCharactersInRange(currentCharacter, select);
            }
        }
    };

    /**
	 * Toggles the selection of a given characters
	 *
	 * @param {HTMLElement} character - The html element of a character
	 * @param {object} param1 - Optional params
	 * @param {boolean} [param1.markState] - Whether the toggle of this character should be remembered as the last done toggle
	 */
    toggleSingleCharacter = (character, { markState = true } = {}) => {
        const characterId = Number(character.getAttribute('data-chid'));

        const select = !this.selectedCharacters.includes(characterId);
        const legacyBulkEditCheckbox = /** @type {HTMLInputElement} */ (
            character.querySelector('.' + BulkEditOverlay.legacySelectedClass)
        );

        if (select) {
            character.classList.add(BulkEditOverlay.selectedClass);
            if (legacyBulkEditCheckbox) legacyBulkEditCheckbox.checked = true;
            this.#selectedCharacters.push(characterId);
        } else {
            character.classList.remove(BulkEditOverlay.selectedClass);
            if (legacyBulkEditCheckbox) legacyBulkEditCheckbox.checked = false;
            this.#selectedCharacters = this.#selectedCharacters.filter(
                (item) => characterId !== item,
            );
        }

        this.updateSelectedCount();

        if (markState) {
            this.lastSelected.characterId = characterId;
            this.lastSelected.select = select;
        }
    };

    /**
	 * Updates the selected count element with the current count
	 *
	 * @param {number} [countOverride] - optional override for a manual number to set
	 */
    updateSelectedCount = (countOverride = undefined) => {
        const count = countOverride ?? this.selectedCharacters.length;
        $(`#${BulkEditOverlay.bulkSelectedCountId}`)
            .text(count)
            .attr('title', `${count} characters selected`);
    };

    /**
	 * Toggles the selection of characters in a given range.
	 * The range is provided by the given character and the last selected one remembered in the selection state.
	 *
	 * @param {HTMLElement} currentCharacter - The html element of the currently toggled character
	 * @param {boolean} select - <c>true</c> if the characters in the range are to be selected, <c>false</c> if deselected
	 */
    toggleCharactersInRange = (currentCharacter, select) => {
        const currentCharacterId = Number(
            currentCharacter.getAttribute('data-chid'),
        );
        const vcl = getVirtualCharacterList();
        const entities = vcl
            ? vcl.getEntities()
            : getEntitiesList({ doFilter: true });

        const lastIndex = entities.findIndex(
            (entity) =>
                entity.type === 'character' &&
				entity.id === this.lastSelected.characterId,
        );
        const currentIndex = entities.findIndex(
            (entity) =>
                entity.type === 'character' && entity.id === currentCharacterId,
        );

        if (lastIndex === -1 || currentIndex === -1) return;

        const [start, end] = [
            Math.min(lastIndex, currentIndex),
            Math.max(lastIndex, currentIndex),
        ];

        for (let i = start; i <= end; i++) {
            const entity = entities[i];
            if (entity.type !== 'character') continue;

            const characterId = entity.id;
            const isCharacterSelected = this.selectedCharacters.includes(characterId);

            if (
                (select && !isCharacterSelected) ||
				(!select && isCharacterSelected)
            ) {
                const character = this.container.querySelector(
                    `[data-chid="${characterId}"]`,
                );
                if (character instanceof HTMLElement) {
                    this.toggleSingleCharacter(character, {
                        markState: currentCharacterId === characterId,
                    });
                } else if (select) {
                    this.#selectedCharacters.push(characterId);
                } else {
                    this.#selectedCharacters = this.#selectedCharacters.filter(
                        (id) => id !== characterId,
                    );
                }
            }
        }

        this.updateSelectedCount();

        if (vcl) {
            vcl.applySelectionState(
                this.selectedCharacters,
                BulkEditOverlay.selectedClass,
            );
        }
    };

    handleContextMenuShow = (event) => {
        event.preventDefault();
        const [x, y] = this.#getContextMenuPosition(event);
        const characterId = this.selectedCharacters.length === 1
            ? this.selectedCharacters[0]
            : null;
        CharacterContextMenu.show(x, y, characterId);
        this.#contextMenuOpen = true;
    };

    handleContextMenuHide = (event) => {
        let contextMenu = document.getElementById(BulkEditOverlay.contextMenuId);
        if (false === contextMenu.contains(event.target)) {
            CharacterContextMenu.hide();
            this.#contextMenuOpen = false;
        }
    };

    /**
	 * Concurrently handle character favorite requests.
	 *
	 * @returns {Promise<void>}
	 */
    handleContextMenuFavorite = async () => {
        const promises = [];

        for (const characterId of this.selectedCharacters) {
            promises.push(CharacterContextMenu.favorite(characterId));
        }

        await Promise.allSettled(promises);
        await getCharacters();
        await favsToHotswap();
        this.browseState();
    };

    /**
	 * Concurrently handle character duplicate requests.
	 *
	 * @returns {Promise<number>}
	 */
    handleContextMenuDuplicate = () =>
        Promise.all(
            this.selectedCharacters.map(async (characterId) =>
                CharacterContextMenu.duplicate(characterId),
            ),
        )
            .then(() => getCharacters())
            .then(() => this.browseState());

    /**
	 * Download selected character cards.
	 *
	 * @returns {Promise<void>}
	 */
    handleContextMenuDownload = async () => {
        const characterIds = this.selectedCharacters;

        if (characterIds.length === 0) {
            return;
        }

        const loaderHandle = loader.show({
            slug: 'bulk-download',
            title: t`Bulk Download`,
            message: t`Downloading ${characterIds.length} character(s)…`,
            toastMode: loader.ToastMode.STATIC,
        });

        try {
            if (characterIds.length === 1) {
                await CharacterContextMenu.download(characterIds[0]);
                return;
            }

            if (!('JSZip' in window)) {
                await import('../lib/jszip.min.js');
            }

            const ZipConstructor = /** @type {any} */ (window).JSZip;
            const zip = new ZipConstructor();

            for (const characterId of characterIds) {
                const character = characters[characterId];
                const response = await fetch(
                    `/characters/${encodeURIComponent(character.avatar)}`,
                );

                if (!response.ok) {
                    console.warn(`Failed to download: ${character.avatar}`);
                    continue;
                }

                const blob = await response.blob();
                zip.file(character.avatar, blob);
            }

            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const timestamp = new Date()
                .toISOString()
                .replace(/[:.]/g, '-')
                .slice(0, 19);
            downloadBlob(zipBlob, `characters_${timestamp}.zip`);
        } catch (error) {
            console.error('Bulk download failed:', error);
            toastr.error('Failed to download character(s).');
        } finally {
            loaderHandle.hide();
        }
    };

    /**
	 * Sequentially handle all character-to-persona conversions.
	 *
	 * @returns {Promise<void>}
	 */
    handleContextMenuPersona = async () => {
        for (const characterId of this.selectedCharacters) {
            await CharacterContextMenu.persona(characterId);
        }

        this.browseState();
    };

    /**
     * Re-opens the source task for one selected Bulk Combine card.
     *
     * @returns {Promise<void>}
     */
    handleContextMenuRerunBulkCombine = async () => {
        const characterId = this.selectedCharacters.length === 1
            ? this.selectedCharacters[0]
            : null;
        try {
            await CharacterContextMenu.rerunBulkCombine(characterId);
        } finally {
            this.browseState();
        }
    };

    /**
	 * Starts combining selected characters into a group card.
	 */
    handleContextMenuCombineGroupCard = async () => {
        const characterIds = this.selectedCharacters.slice();

        try {
            await openCombineWizard(characterIds);
        } finally {
            this.browseState();
        }
    };

    static rerunGroupCardWizard = async (characterId) => {
        const character = characters[characterId];
        const meta = getGroupCardWizardMetadata(character);
        if (!character || !meta) {
            toastr.error(
                'This character was not created by the Group Card Wizard.',
                'Combine into Group Card',
            );
            return;
        }

        const sourceCharacterIds = [];
        const sourceAvatars = Array.isArray(meta.sourceCharacterAvatars)
            ? meta.sourceCharacterAvatars
            : [];
        for (const avatar of sourceAvatars) {
            const id = characters.findIndex(
                (candidate) => candidate?.avatar === avatar,
            );
            if (id >= 0 && !sourceCharacterIds.includes(id)) {
                sourceCharacterIds.push(id);
            }
        }

        if (sourceAvatars.length > sourceCharacterIds.length) {
            const foundAvatars = new Set(
                sourceCharacterIds.map((id) => characters[id]?.avatar),
            );
            const missingAvatars = sourceAvatars.filter(
                (avatar) => !foundAvatars.has(avatar),
            );
            if (missingAvatars.length > 0) {
                toastr.warning(
                    `${missingAvatars.length} source character(s) could not be found and will be skipped.`,
                    'Combine into Group Card',
                );
            }
        }

        await openCombineWizard(sourceCharacterIds, {
            rerunAvatar: character.avatar,
            rerunMeta: meta,
            groupName: getCoreCharacterField(character, 'name'),
        });
    };

    static #showGroupCardJobPopup = () => {
        const content = $('<div></div>');
        const newCardButton = $('<div></div>')
            .addClass('menu_button')
            .append($('<i></i>').addClass('fa-solid fa-layer-group'))
            .append(' New Group Card');
        newCardButton.on('click', async () => {
            content.closest('.popup').remove();
            const selectedCharacters =
                bulkEditOverlayInstance?.selectedCharacters?.slice?.() ?? [];
            await openCombineWizard(selectedCharacters);
        });
        content.append(newCardButton);
        callGenericPopup(content, POPUP_TYPE.DISPLAY, '', {
            okButton: 'Close',
            wide: false,
        });
    };

    /**
	 * Gets the HTML as a string that is displayed inside the popup for the bulk delete
	 *
	 * @param {Array<number>} characterIds - The characters that are shown inside the popup
	 * @returns String containing the html for the popup content
	 */
    static #getDeletePopupContentHtml = (characterIds) => {
        return `
            <h3 class="marginBot5">Delete ${characterIds.length} characters?</h3>
            <span class="bulk_delete_note">
                <i class="fa-solid fa-triangle-exclamation warning margin-r5"></i>
                <b>THIS IS PERMANENT!</b>
            </span>
            <div id="bulk_delete_avatars_block" class="avatars_inline avatars_inline_small tags tags_inline m-t-1"></div>
            <br>
            <div id="bulk_delete_options" class="m-b-1">
                <label for="del_char_checkbox" class="checkbox_label justifyCenter">
                    <input type="checkbox" id="del_char_checkbox" />
                    <span>Also delete the chat files</span>
                </label>
            </div>`;
    };

    /**
	 * Request user input before concurrently handle deletion
	 * requests.
	 *
	 * @returns {Promise<number>}
	 */
    handleContextMenuDelete = () => {
        const characterIds = this.selectedCharacters;
        const popupContent = $(
            BulkEditOverlay.#getDeletePopupContentHtml(characterIds),
        );
        const checkbox = popupContent.find('#del_char_checkbox');
        const promise = callGenericPopup(popupContent, POPUP_TYPE.CONFIRM).then(
            (accept) => {
                if (!accept) return;

                const deleteChats = checkbox.prop('checked') ?? false;

                const loaderHandle = loader.show({
                    slug: 'bulk-delete',
                    title: t`Bulk Delete`,
                    message: t`Deleting ${characterIds.length} character(s)…`,
                    toastMode: loader.ToastMode.STATIC,
                });
                const avatarList = characterIds
                    .map((id) => characters[id]?.avatar)
                    .filter((a) => a);
                return CharacterContextMenu.delete(avatarList, deleteChats)
                    .then(() => this.browseState())
                    .finally(() => loaderHandle.hide());
            },
        );

        // At this moment the popup is already changed in the dom, but not yet closed/resolved. We build the avatar list here
        const entities = characterIds
            .map((id) => characterToEntity(characters[id], id))
            .filter((entity) => entity.item !== undefined);
        buildAvatarList($('#bulk_delete_avatars_block'), entities);

        return promise;
    };

    /**
	 * Attaches and opens the tag menu
	 */
    handleContextMenuTag = () => {
        CharacterContextMenu.tag(this.selectedCharacters);
        this.browseState();
    };

    addStateChangeCallback = (callback) =>
        this.stateChangeCallbacks.push(callback);

    /**
	 * Clears internal character storage and
	 * removes visual highlight.
	 */
    clearSelectedCharacters = () => {
        document
            .querySelectorAll(
                '#' +
					BulkEditOverlay.containerId +
					' .' +
					BulkEditOverlay.selectedClass,
            )
            .forEach((element) =>
                element.classList.remove(BulkEditOverlay.selectedClass),
            );
        this.selectedCharacters.length = 0;
    };
}

export {
    BulkEditOverlayState,
    CharacterContextMenu,
    BulkEditOverlay,
};
