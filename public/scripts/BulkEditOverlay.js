'use strict';

import {
    characterGroupOverlay,
    characters,
    event_types,
    eventSource,
    Generate,
    getCharacters,
    getRequestHeaders,
    buildAvatarList,
    characterToEntity,
    printCharactersDebounced,
    deleteCharacter,
    saveSettingsDebounced,
    substituteParams,
    unshallowCharacter,
} from '../script.js';

import { favsToHotswap } from './RossAscends-mods.js';
import { loader } from './action-loader.js';
import { convertCharacterToPersona } from './personas.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { DEFAULT_GROUP_CARD_COMBINE_PROMPT, power_user } from './power-user.js';
import { createTagInput, getTagKeyForEntity, getTagsList, printTagList, tag_map, compareTagsForSort, removeTagFromMap, importTags, tag_import_setting } from './tags.js';
import { t } from './i18n.js';
import { newWorldInfoEntryTemplate, world_names } from './world-info.js';
import { escapeHtml } from './utils.js';

const CORE_CHARACTER_FIELDS = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'];
const ALWAYS_INCLUDED_CHARACTER_FIELDS = ['name', 'description'];
const OPTIONAL_CHARACTER_FIELDS = ['personality', 'scenario', 'first_mes', 'mes_example'];
const CHARACTER_OPEN_TAG = '<character>';
const CHARACTER_CLOSE_TAG = '</character>';

/**
 * Normalizes selected optional fields into ordered core fields.
 *
 * @param {Array<string>} [selected] Selected optional fields.
 * @returns {Array<string>} Ordered included core fields.
 */
function normalizeSelectedFields(selected) {
    if (!selected) {
        return [...CORE_CHARACTER_FIELDS];
    }

    const selectedFields = new Set((Array.isArray(selected) ? selected : []).filter(field => OPTIONAL_CHARACTER_FIELDS.includes(field)));
    const includedFields = new Set([...ALWAYS_INCLUDED_CHARACTER_FIELDS, ...selectedFields]);
    return CORE_CHARACTER_FIELDS.filter(field => includedFields.has(field));
}

/**
 * Normalizes names for duplicate checks.
 *
 * @param {string} name Name to normalize.
 * @returns {string} Trimmed lowercase name.
 */
function normalizeName(name) {
    return String(name ?? '').trim().toLowerCase();
}

/**
 * Gets a character name from top-level or data fields.
 *
 * @param {object} character Character object.
 * @returns {string} Character name.
 */
function getCharacterName(character) {
    return character?.name ?? character?.ch_name ?? character?.data?.name ?? character?.data?.ch_name ?? '';
}

/**
 * Resolves selected character ids or objects to valid character objects.
 *
 * @param {Array<number|object>} selectedCharacters Selected character ids or objects.
 * @param {Array<object>} characterList Loaded character list.
 * @returns {Array<object>} Valid named characters.
 */
function getValidSelectedCharacters(selectedCharacters, characterList) {
    const availableCharacters = characterList ?? [];

    return (selectedCharacters ?? [])
        .map(character => typeof character === 'number' ? availableCharacters[character] : character)
        .filter(character => normalizeName(getCharacterName(character)));
}

/**
 * Gets one core character field from top-level fields with .data fallback.
 *
 * @param {object} character Character object.
 * @param {string} field Core field name.
 * @returns {string} String field value.
 */
function getCoreCharacterField(character, field) {
    if (field === 'name') {
        return String(getCharacterName(character));
    }

    return String(character?.[field] ?? character?.data?.[field] ?? '');
}

/**
 * Gets only core fields used for group-card generation.
 *
 * @param {object} character Character object.
 * @returns {{ name: string, description: string, personality: string, scenario: string, first_mes: string, mes_example: string }} Core payload.
 */
function getCoreCharacterPayload(character) {
    /** @type {{ name: string, description: string, personality: string, scenario: string, first_mes: string, mes_example: string }} */
    const payload = {
        name: '',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
    };

    for (const field of CORE_CHARACTER_FIELDS) {
        payload[field] = getCoreCharacterField(character, field);
    }

    return payload;
}

/**
 * Builds an XML-like block for a selected character core payload.
 *
 * @param {object} character Character object.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {string} XML-like character block.
 */
function buildCoreCharacterPromptBlock(character, fields) {
    const payload = getCoreCharacterPayload(character);
    const characterName = payload.name;
    const fieldXml = normalizeSelectedFields(fields)
        .map(field => {
            const value = field === 'name' ? payload[field] : substituteParams(payload[field], { name2Override: characterName });
            return `  <${field}>${escapeHtml(value)}</${field}>`;
        })
        .join('\n');

    return `${CHARACTER_OPEN_TAG}\n${fieldXml}\n${CHARACTER_CLOSE_TAG}`;
}

/**
 * Builds quiet generation prompt using selected core character fields only.
 *
 * @param {string} prompt User-configured combine instructions.
 * @param {Array<object>} selectedCharacters Valid selected characters.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {string} Quiet prompt.
 */
function buildGroupCardCombineQuietPrompt(prompt, selectedCharacters, fields) {
    const payload = selectedCharacters.map(character => buildCoreCharacterPromptBlock(character, fields)).join('\n\n');

    return `${String(prompt ?? '').trim()}\n\nInput characters:\n${payload}`;
}

/**
 * Removes wrapping triple-backtick fences from generated output.
 *
 * @param {string} output Raw generated output.
 * @returns {string} Unfenced output.
 */
function stripTripleBacktickFences(output) {
    return String(output ?? '')
        .trim()
        .replace(/^```[\w-]*\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
}

/**
 * Extracts and validates generated group card description XML-like output.
 *
 * @param {string} output Raw generated output.
 * @param {number} selectedCharacterCount Count of selected source characters.
 * @returns {string} Validated generated description.
 * @throws {Error} When output is empty, not XML-like, or has too few character tags.
 */
function validateGeneratedGroupCardDescription(output, selectedCharacterCount) {
    const unfencedOutput = stripTripleBacktickFences(output);

    if (!unfencedOutput) {
        throw new Error('Generation returned empty output.');
    }

    const firstCharacterTagIndex = unfencedOutput.indexOf(CHARACTER_OPEN_TAG);
    const lastCharacterCloseTagIndex = unfencedOutput.lastIndexOf(CHARACTER_CLOSE_TAG);

    if (firstCharacterTagIndex === -1 || lastCharacterCloseTagIndex === -1 || lastCharacterCloseTagIndex < firstCharacterTagIndex) {
        throw new Error('Generation did not return character XML.');
    }

    const generatedDescription = unfencedOutput
        .slice(firstCharacterTagIndex, lastCharacterCloseTagIndex + CHARACTER_CLOSE_TAG.length)
        .trim();
    const characterTagCount = generatedDescription.match(/<character>/g)?.length ?? 0;

    if (characterTagCount < selectedCharacterCount) {
        throw new Error(`Generation returned ${characterTagCount} character block(s), expected at least ${selectedCharacterCount}.`);
    }

    return generatedDescription;
}

/**
 * Formats a core field value for lorebook summary content.
 *
 * @param {string} label Human-readable field label.
 * @param {string} value Core character field value.
 * @returns {string} Labeled field section, or empty string when value is empty.
 */
function formatLorebookSummaryField(label, value) {
    const trimmedValue = String(value ?? '').trim();

    return trimmedValue ? `${label}:\n${trimmedValue}` : '';
}

/**
 * Builds deterministic lorebook content from original core character fields.
 *
 * @param {object} character Character object.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {string} Lorebook entry content.
 */
function buildLorebookEntryContent(character, fields) {
    const payload = getCoreCharacterPayload(character);
    const includedFields = normalizeSelectedFields(fields);
    const fieldSections = [
        `Name: ${payload.name.trim()}`,
        formatLorebookSummaryField('Description', payload.description),
        includedFields.includes('personality') ? formatLorebookSummaryField('Personality', payload.personality) : '',
        includedFields.includes('scenario') ? formatLorebookSummaryField('Scenario', payload.scenario) : '',
        includedFields.includes('first_mes') ? formatLorebookSummaryField('First message', payload.first_mes) : '',
        includedFields.includes('mes_example') ? formatLorebookSummaryField('Example messages', payload.mes_example) : '',
    ].filter(Boolean);

    return fieldSections.join('\n\n');
}

/**
 * Builds a lorebook entry for one original selected character.
 *
 * @param {object} character Character object.
 * @param {number} index Entry index.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {object} World info entry data.
 */
function buildLorebookEntry(character, index, fields) {
    const name = getCoreCharacterField(character, 'name').trim();
    const uid = Number.isInteger(index) && index >= 0 ? index : 0;

    return {
        uid,
        ...structuredClone(newWorldInfoEntryTemplate),
        key: [name],
        comment: name,
        content: buildLorebookEntryContent(character, fields),
        addMemo: true,
        order: 100 - uid,
    };
}

/**
 * Builds lorebook data containing one entry per selected character.
 *
 * @param {Array<object>} selectedCharacters Valid selected characters.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {{ entries: object }} World info data.
 */
function buildLorebookData(selectedCharacters, fields) {
    const entries = Object.fromEntries((selectedCharacters ?? []).map((character, index) => {
        const entry = buildLorebookEntry(character, index, fields);
        return [entry.uid, entry];
    }));

    return { entries };
}

/**
 * Gets persisted group-card combine prompt presets.
 *
 * @returns {Array<{ name: string, prompt: string }>} Prompt presets.
 */
function getGroupCardCombinePromptPresets() {
    if (!Array.isArray(power_user.group_card_combine_prompt_presets)) {
        power_user.group_card_combine_prompt_presets = [];
    }

    return power_user.group_card_combine_prompt_presets;
}

/**
 * Finds a prompt preset by name.
 *
 * @param {string} name Preset name.
 * @param {Array<{ name: string, prompt: string }>} [presets] Prompt presets.
 * @returns {number} Preset index, or -1.
 */
function findGroupCardCombinePromptPresetIndex(name, presets = getGroupCardCombinePromptPresets()) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return -1;
    }

    return presets.findIndex(preset => normalizeName(preset?.name) === normalizedName);
}

/**
 * Saves a named prompt preset, optionally overwriting an existing preset.
 *
 * @param {string} name Preset name.
 * @param {string} prompt Preset prompt.
 * @param {object} [options] Save dependencies.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @returns {Promise<{ name: string, prompt: string }|null>} Saved preset, or null when cancelled.
 */
async function saveGroupCardCombinePromptPreset(name, prompt, { toaster = globalThis.toastr } = {}) {
    const trimmedName = String(name ?? '').trim();

    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', 'Combine into Group Card');
        return null;
    }

    const presets = getGroupCardCombinePromptPresets();
    const existingIndex = findGroupCardCombinePromptPresetIndex(trimmedName, presets);
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        const overwrite = await callGenericPopup(`Overwrite prompt preset "${escapeHtml(trimmedName)}"?`, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Overwrite',
            cancelButton: 'Cancel',
        });

        if (overwrite !== POPUP_RESULT.AFFIRMATIVE) {
            return null;
        }

        presets[existingIndex] = savedPreset;
    } else {
        presets.push(savedPreset);
    }

    saveSettingsDebounced();
    return savedPreset;
}

/**
 * Deletes a prompt preset by index.
 *
 * @param {number} presetIndex Preset index.
 * @returns {boolean} True if deleted.
 */
function deleteGroupCardCombinePromptPreset(presetIndex) {
    const presets = getGroupCardCombinePromptPresets();

    if (!Number.isInteger(presetIndex) || presetIndex < 0 || presetIndex >= presets.length) {
        return false;
    }

    presets.splice(presetIndex, 1);
    saveSettingsDebounced();
    return true;
}

/**
 * Populates the combine prompt preset selector.
 *
 * @param {JQuery<HTMLElement>} presetSelect Preset select element.
 * @param {number|string} [selectedIndex] Selected preset index.
 */
function renderGroupCardCombinePromptPresetSelect(presetSelect, selectedIndex = '') {
    const presets = getGroupCardCombinePromptPresets();
    presetSelect.empty();
    presetSelect.append($('<option></option>').val('').text('— Load preset —'));

    presets.forEach((preset, index) => {
        presetSelect.append($('<option></option>').val(String(index)).text(preset.name));
    });

    presetSelect.val(selectedIndex === '' ? '' : String(selectedIndex));
}

/**
 * Throws response text when an API request fails.
 *
 * @param {Response} response Fetch response.
 * @param {string} fallbackMessage Fallback failure message.
 */
async function throwIfNotOk(response, fallbackMessage) {
    if (response.ok) {
        return;
    }

    const responseText = await response.text();
    throw new Error(responseText || fallbackMessage);
}

/**
 * Sends an API request and returns response text without throwing.
 *
 * @param {string} url API endpoint.
 * @param {object} body JSON request body.
 * @returns {Promise<Response>} Fetch response.
 */
async function sendJsonRequest(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
}

/**
 * Attempts to delete a partially created lorebook.
 *
 * @param {string} groupName Lorebook name.
 * @returns {Promise<string>} Rollback status message.
 */
async function rollbackGeneratedLorebook(groupName) {
    try {
        const response = await sendJsonRequest('/api/worldinfo/delete', { name: groupName });
        await throwIfNotOk(response, `Failed to roll back lorebook "${groupName}".`);
        return `Rolled back lorebook "${groupName}".`;
    } catch (error) {
        return `Failed to roll back lorebook "${groupName}": ${error?.message ?? error}.`;
    }
}

/**
 * Attempts to delete a partially created character.
 *
 * @param {string} groupName Character name.
 * @param {string} avatar Character avatar filename.
 * @returns {Promise<string>} Rollback status message.
 */
async function rollbackGeneratedCharacter(groupName, avatar) {
    try {
        const response = await sendJsonRequest('/api/characters/delete', { avatar_url: avatar, delete_chats: false });
        await throwIfNotOk(response, `Failed to roll back character "${groupName}" (avatar "${avatar}").`);
        return `Rolled back character "${groupName}" (avatar "${avatar}").`;
    } catch (error) {
        return `Failed to roll back character "${groupName}" (avatar "${avatar}"): ${error?.message ?? error}.`;
    }
}

/**
 * Reads created character avatar from the create response.
 *
 * @param {Response} response Character create response.
 * @param {string} groupName Group card name.
 * @returns {Promise<string>} Created avatar filename.
 */
async function readCreatedCharacterAvatar(response, groupName) {
    const responseText = (await response.text()).trim();

    if (!responseText) {
        throw new Error(`Character "${groupName}" create response did not include avatar.`);
    }

    if (responseText.startsWith('{')) {
        const data = JSON.parse(responseText);
        const avatar = String(data?.avatar ?? '').trim();

        if (!avatar) {
            throw new Error(`Character "${groupName}" create response did not include avatar.`);
        }

        return avatar;
    }

    return responseText;
}

/**
 * Creates a generated group card character, optionally creating and linking a lorebook.
 *
 * @param {string} groupName Group card and lorebook name.
 * @param {string} generatedDescription Generated character description.
 * @param {Array<object>} selectedChars Selected character objects.
 * @param {boolean} [createLorebook] Whether to create and link a lorebook.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {Promise<{ avatar: string, world: string }>} Created avatar and linked world name.
 */
async function createGeneratedGroupCard(groupName, generatedDescription, selectedChars, createLorebook = true, fields) {
    const request = validateGroupCardRequest(groupName, selectedChars, { createLorebook });

    if (!request) {
        throw new Error('Group card request is no longer valid.');
    }

    const sourceNames = request.characters.map(character => getCoreCharacterField(character, 'name').trim()).join(', ');

    if (createLorebook) {
        const worldResponse = await sendJsonRequest('/api/worldinfo/edit', {
            name: request.groupName,
            data: buildLorebookData(request.characters, fields),
        });
        await throwIfNotOk(worldResponse, `Failed to create lorebook "${request.groupName}".`);
    }

    const characterResponse = await sendJsonRequest('/api/characters/create', {
        name: request.groupName,
        ch_name: request.groupName,
        description: generatedDescription,
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: `Generated group card from: ${sourceNames}`,
        system_prompt: '',
        post_history_instructions: '',
        creator: '',
        character_version: '',
        tags: [],
        talkativeness: '0.5',
        world: '',
        depth_prompt_prompt: '',
        depth_prompt_depth: '4',
        depth_prompt_role: 'system',
        fav: 'false',
        alternate_greetings: [],
        extensions: createLorebook ? {} : { world: '' },
    });

    if (!characterResponse.ok) {
        const responseText = await characterResponse.text();
        const rollbackMessage = createLorebook ? await rollbackGeneratedLorebook(request.groupName) : '';
        const artifactMessage = createLorebook ? ` after lorebook "${request.groupName}" was created` : '';
        throw new Error(`Failed to create character "${request.groupName}"${artifactMessage}. ${responseText || 'No response body.'} ${rollbackMessage}`);
    }

    let avatar = '';

    try {
        avatar = await readCreatedCharacterAvatar(characterResponse, request.groupName);
    } catch (error) {
        const rollbackMessage = createLorebook ? await rollbackGeneratedLorebook(request.groupName) : '';
        throw new Error(`${error?.message ?? error} ${rollbackMessage}`);
    }

    if (!createLorebook) {
        return { avatar, world: '' };
    }

    const linkResponse = await sendJsonRequest('/api/characters/merge-attributes', {
        avatar,
        data: {
            extensions: {
                world: request.groupName,
            },
        },
    });

    if (!linkResponse.ok) {
        const responseText = await linkResponse.text();
        const characterRollbackMessage = await rollbackGeneratedCharacter(request.groupName, avatar);
        const lorebookRollbackMessage = await rollbackGeneratedLorebook(request.groupName);
        throw new Error(`Failed to link lorebook "${request.groupName}" to character "${request.groupName}" (avatar "${avatar}"). ${responseText || 'No response body.'} ${characterRollbackMessage} ${lorebookRollbackMessage}`);
    }

    return { avatar, world: request.groupName };
}

/**
 * Validates group card creation request before generation.
 *
 * @param {string} groupName Requested group card and lorebook name.
 * @param {Array<number|object>} selectedCharacters Selected character ids or objects.
 * @param {object} [options] Validation dependencies.
 * @param {Array<object>} [options.characterList] Loaded character list.
 * @param {Array<string>} [options.worldNames] Loaded lorebook names.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @param {boolean} [options.createLorebook] Whether a lorebook will be created.
 * @returns {{ groupName: string, characters: Array<object> }|null} Valid request data, or null when blocked.
 */
function validateGroupCardRequest(groupName, selectedCharacters, { characterList = characters, worldNames = world_names, toaster = globalThis.toastr, createLorebook = true } = {}) {
    const trimmedName = String(groupName ?? '').trim();
    const normalizedName = normalizeName(trimmedName);

    if (!normalizedName) {
        toaster?.warning?.('Enter a group card name.', 'Combine into Group Card');
        return null;
    }

    const validCharacters = getValidSelectedCharacters(selectedCharacters, characterList);

    if (validCharacters.length < 2) {
        toaster?.warning?.('Select at least two valid characters.', 'Combine into Group Card');
        return null;
    }

    const hasCharacterNameCollision = (characterList ?? []).some(character => normalizeName(getCharacterName(character)) === normalizedName);

    if (hasCharacterNameCollision) {
        toaster?.error?.(`Character named "${trimmedName}" already exists.`, 'Combine into Group Card');
        return null;
    }

    const hasLorebookNameCollision = createLorebook && (worldNames ?? []).some(name => normalizeName(name) === normalizedName);

    if (hasLorebookNameCollision) {
        toaster?.error?.(`Lorebook named "${trimmedName}" already exists.`, 'Combine into Group Card');
        return null;
    }

    return { groupName: trimmedName, characters: validCharacters };
}

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
        await eventSource.emit(event_types.CHARACTER_DUPLICATED, { oldAvatar: body.avatar_url, newAvatar: data.path });
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
            mergeResponse.json().then(json => toastr.error(`Character not saved. Error: ${json.message}. Field: ${json.error}`));
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
    static persona = async (characterId) => void (await convertCharacterToPersona(characterId));

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
    static show = (positionX, positionY) => {
        let contextMenu = document.getElementById(BulkEditOverlay.contextMenuId);
        contextMenu.style.left = `${positionX}px`;
        contextMenu.style.top = `${positionY}px`;

        document.getElementById(BulkEditOverlay.contextMenuId).classList.remove('hidden');

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
    static hide = () => document.getElementById(BulkEditOverlay.contextMenuId).classList.add('hidden');

    /**
     * Sets up the context menu for the given overlay
     *
     * @param characterGroupOverlay
     */
    constructor(characterGroupOverlay) {
        const contextMenuItems = [
            { id: 'character_context_menu_favorite', callback: characterGroupOverlay.handleContextMenuFavorite },
            { id: 'character_context_menu_duplicate', callback: characterGroupOverlay.handleContextMenuDuplicate },
            { id: 'character_context_menu_persona', callback: characterGroupOverlay.handleContextMenuPersona },
            { id: 'bulk_select_combine_group_card', callback: characterGroupOverlay.handleContextMenuCombineGroupCard },
            { id: 'character_context_menu_delete', callback: characterGroupOverlay.handleContextMenuDelete },
            { id: 'character_context_menu_tag', callback: characterGroupOverlay.handleContextMenuTag },
        ];

        contextMenuItems.forEach(contextMenuItem => document.getElementById(contextMenuItem.id).addEventListener('click', contextMenuItem.callback));
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
    constructor() { }

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

        document.body.insertAdjacentHTML('beforeend', this.#getHtml());

        const entities = this.characterIds.map(id => characterToEntity(characters[id], id)).filter(entity => entity.item !== undefined);
        buildAvatarList($('#bulk_tags_avatars_block'), entities);

        // Print the tag list with all mutuable tags, marking them as removable. That is the initial fill
        printTagList($('#bulkTagList'), { tags: () => this.getMutualTags(), tagOptions: { removable: true } });

        // Tag input with resolvable list for the mutual tags to get redrawn, so that newly added tags get sorted correctly
        createTagInput('#bulkTagInput', '#bulkTagList', { tags: () => this.getMutualTags(), tagOptions: { removable: true } });

        document.querySelector('#bulk_tag_popup_reset').addEventListener('click', this.resetTags.bind(this));
        document.querySelector('#bulk_tag_popup_remove_mutual').addEventListener('click', this.removeMutual.bind(this));
        document.querySelector('#bulk_tag_popup_cancel').addEventListener('click', this.hide.bind(this));
        document.querySelector('#bulk_tag_popup_import_all_tags').addEventListener('click', this.importAllTags.bind(this));
        document.querySelector('#bulk_tag_popup_import_existing_tags').addEventListener('click', this.importExistingTags.bind(this));
    }

    /**
     * Import existing tags for all selected characters
     */
    async importExistingTags() {
        for (const characterId of this.characterIds) {
            await importTags(characters[characterId], { importSetting: tag_import_setting.ONLY_EXISTING });
        }

        $('#bulkTagList').empty();
    }

    /**
     * Import all tags for all selected characters
     */
    async importAllTags() {
        for (const characterId of this.characterIds) {
            await importTags(characters[characterId], { importSetting: tag_import_setting.ALL });
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
        const allTags = this.characterIds.map(cid => getTagsList(getTagKeyForEntity(cid)));
        const mutualTags = allTags.reduce((mutual, characterTags) =>
            mutual.filter(tag => characterTags.some(cTag => cTag.id === tag.id)),
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

        eventSource.emit(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE, newState)
            .then(() => {
                this.#state = newState;
                eventSource.emit(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, this.state);
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

    constructor() {
        if (bulkEditOverlayInstance instanceof BulkEditOverlay)
            return bulkEditOverlayInstance;

        this.container = document.getElementById(BulkEditOverlay.containerId);

        eventSource.on(event_types.CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER, this.handleStateChange);
        bulkEditOverlayInstance = Object.freeze(this);
    }

    /**
     * Set the overlay to browse mode
     */
    browseState = () => this.state = BulkEditOverlayState.browse;

    /**
     * Set the overlay to select mode
     */
    selectState = () => this.state = BulkEditOverlayState.select;

    /**
     * Set up a Sortable grid for the loaded page
     */
    onPageLoad = () => {
        this.browseState();

        const elements = this.#getEnabledElements();
        elements.forEach(element => element.addEventListener('touchstart', this.handleHold));
        elements.forEach(element => element.addEventListener('mousedown', this.handleHold));
        elements.forEach(element => element.addEventListener('contextmenu', this.handleDefaultContextMenu));

        elements.forEach(element => element.addEventListener('touchend', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('mouseup', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('dragend', this.handleLongPressEnd));
        elements.forEach(element => element.addEventListener('touchmove', this.handleLongPressEnd));

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

        this.stateChangeCallbacks.forEach(callback => callback(this.state));
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
        this.container.removeEventListener('contextmenu', this.handleContextMenuShow);
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

        const cancelHold = (event) => cancel = true;
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
                    CharacterContextMenu.show(x, y);
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
        if (false === this.#contextMenuOpen) this.state = BulkEditOverlayState.browse;
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

    #enableClickEventsForGroups = () => this.#getDisabledElements().forEach((element) => element.removeEventListener('click', this.#stopEventPropagation));

    #disableClickEventsForGroups = () => this.#getDisabledElements().forEach((element) => element.addEventListener('click', this.#stopEventPropagation));

    #enableClickEventsForCharacters = () => this.#getEnabledElements().forEach(element => element.removeEventListener('click', this.toggleCharacterSelected));

    #disableClickEventsForCharacters = () => this.#getEnabledElements().forEach(element => element.addEventListener('click', this.toggleCharacterSelected));

    #enableBulkEditButtonHighlight = () => document.getElementById('bulkEditButton').classList.add('bulk_edit_overlay_active');

    #disableBulkEditButtonHighlight = () => document.getElementById('bulkEditButton').classList.remove('bulk_edit_overlay_active');

    #getEnabledElements = () => [...this.container.getElementsByClassName(BulkEditOverlay.characterClass)];

    #getDisabledElements = () => [...this.container.getElementsByClassName(BulkEditOverlay.groupClass), ...this.container.getElementsByClassName(BulkEditOverlay.bogusFolderClass)];

    toggleCharacterSelected = event => {
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

        if (this.lastSelected.characterId >= 0 && this.lastSelected.select !== undefined) {
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
        const legacyBulkEditCheckbox = /** @type {HTMLInputElement} */ (character.querySelector('.' + BulkEditOverlay.legacySelectedClass));

        if (select) {
            character.classList.add(BulkEditOverlay.selectedClass);
            if (legacyBulkEditCheckbox) legacyBulkEditCheckbox.checked = true;
            this.#selectedCharacters.push(characterId);
        } else {
            character.classList.remove(BulkEditOverlay.selectedClass);
            if (legacyBulkEditCheckbox) legacyBulkEditCheckbox.checked = false;
            this.#selectedCharacters = this.#selectedCharacters.filter(item => characterId !== item);
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
        $(`#${BulkEditOverlay.bulkSelectedCountId}`).text(count).attr('title', `${count} characters selected`);
    };

    /**
     * Toggles the selection of characters in a given range.
     * The range is provided by the given character and the last selected one remembered in the selection state.
     *
     * @param {HTMLElement} currentCharacter - The html element of the currently toggled character
     * @param {boolean} select - <c>true</c> if the characters in the range are to be selected, <c>false</c> if deselected
     */
    toggleCharactersInRange = (currentCharacter, select) => {
        const currentCharacterId = Number(currentCharacter.getAttribute('data-chid'));
        const characters = Array.from(document.querySelectorAll('#' + BulkEditOverlay.containerId + ' .' + BulkEditOverlay.characterClass));

        const startIndex = characters.findIndex(c => Number(c.getAttribute('data-chid')) === Number(this.lastSelected.characterId));
        const endIndex = characters.findIndex(c => Number(c.getAttribute('data-chid')) === currentCharacterId);

        for (let i = Math.min(startIndex, endIndex); i <= Math.max(startIndex, endIndex); i++) {
            const character = characters[i];
            const characterId = Number(character.getAttribute('data-chid'));
            const isCharacterSelected = this.selectedCharacters.includes(characterId);

            // Only toggle the character if it wasn't on the state we have are toggling towards.
            // Also doing a weird type check, because typescript checker doesn't like the return of 'querySelectorAll'.
            if ((select && !isCharacterSelected || !select && isCharacterSelected) && character instanceof HTMLElement) {
                this.toggleSingleCharacter(character, { markState: currentCharacterId == characterId });
            }
        }
    };

    handleContextMenuShow = (event) => {
        event.preventDefault();
        const [x, y] = this.#getContextMenuPosition(event);
        CharacterContextMenu.show(x, y);
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
    handleContextMenuDuplicate = () => Promise.all(this.selectedCharacters.map(async characterId => CharacterContextMenu.duplicate(characterId)))
        .then(() => getCharacters())
        .then(() => this.browseState());

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
     * Starts combining selected characters into a group card.
     */
    handleContextMenuCombineGroupCard = async () => {
        const characterIds = this.selectedCharacters.slice();

        const methodName = 'combineIntoGroupCard';
        const combineIntoGroupCard = /** @type {(characterIds: number[]) => Promise<void>} */ (BulkEditOverlay[methodName]);

        try {
            await combineIntoGroupCard(characterIds);
        } finally {
            this.browseState();
        }
    };

    /**
     * Gets the HTML as a string that is displayed inside the group card combine popup.
     *
     * @param {number} characterCount Selected valid character count.
     * @returns {string} Popup content HTML.
     */
    static #getCombineGroupCardPopupContentHtml = (characterCount) => {
        return `
            <h3 class="marginBot5">Combine into Group Card</h3>
            <small class="bulk_combine_group_card_desc m-b-1">Generate a group card from ${characterCount} selected characters.</small>
            <label for="bulk_combine_group_card_name" class="text_label">
                <span>Group name</span>
                <input id="bulk_combine_group_card_name" class="text_pole wide100p margin0" type="text" autocomplete="off" autofocus />
            </label>
            <label for="bulk_combine_group_card_prompt" class="text_label marginTop10">
                <span>Prompt</span>
                <textarea id="bulk_combine_group_card_prompt" class="text_pole wide100p margin0" rows="12"></textarea>
            </label>
            <div id="bulk_combine_group_card_preset_controls" class="m-t-1 flex-container">
                <select id="bulk_combine_group_card_preset_select" class="text_pole flex1">
                    <option value="">— Load preset —</option>
                </select>
                <div id="bulk_combine_group_card_preset_save" class="menu_button" title="Save current prompt as preset">
                    <i class="fa-solid fa-floppy-disk"></i>
                </div>
                <div id="bulk_combine_group_card_preset_delete" class="menu_button" title="Delete selected preset">
                    <i class="fa-solid fa-trash-can"></i>
                </div>
                <div id="bulk_combine_group_card_preset_restore" class="menu_button" title="Restore built-in default prompt">
                    <i class="fa-solid fa-rotate-left"></i>
                </div>
            </div>
            <div class="marginTop10">
                <small>Included fields</small>
                <div id="bulk_combine_group_card_field_toggles">
                    <label class="checkbox_label"><input type="checkbox" data-field="personality" /><span>Personality</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-field="scenario" /><span>Scenario</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-field="first_mes" /><span>First message</span></label>
                    <label class="checkbox_label"><input type="checkbox" data-field="mes_example" /><span>Example messages</span></label>
                </div>
            </div>
            <label for="bulk_combine_group_card_lorebook_toggle" class="checkbox_label marginTop10">
                <input type="checkbox" id="bulk_combine_group_card_lorebook_toggle" />
                <span>Create lorebook with original character data</span>
            </label>`;
    };

    /**
     * Opens the combine modal and starts generation when confirmed.
     *
     * @param {Array<number|object>} selectedCharacters Selected character ids or objects.
     * @returns {Promise<void>}
     */
    static combineIntoGroupCard = async (selectedCharacters) => {
        await Promise.all((selectedCharacters ?? [])
            .filter(id => typeof id === 'number' && characters[id]?.shallow)
            .map(id => unshallowCharacter(id))
        );
        const validCharacters = getValidSelectedCharacters(selectedCharacters, characters);

        if (validCharacters.length < 2) {
            toastr.warning('Select at least two valid characters.', 'Combine into Group Card');
            return;
        }

        const popupContent = $(BulkEditOverlay.#getCombineGroupCardPopupContentHtml(validCharacters.length));
        const groupNameInput = popupContent.find('#bulk_combine_group_card_name');
        const promptInput = popupContent.find('#bulk_combine_group_card_prompt');
        const presetSelect = popupContent.find('#bulk_combine_group_card_preset_select');
        const savePresetButton = popupContent.find('#bulk_combine_group_card_preset_save');
        const deletePresetButton = popupContent.find('#bulk_combine_group_card_preset_delete');
        const restorePresetButton = popupContent.find('#bulk_combine_group_card_preset_restore');
        const fieldToggles = popupContent.find('#bulk_combine_group_card_field_toggles input[type="checkbox"]');
        const lorebookToggle = popupContent.find('#bulk_combine_group_card_lorebook_toggle');
        promptInput.val(power_user.group_card_combine_prompt ?? DEFAULT_GROUP_CARD_COMBINE_PROMPT);
        lorebookToggle.prop('checked', false);
        renderGroupCardCombinePromptPresetSelect(presetSelect);

        const persistedFields = Array.isArray(power_user.group_card_combine_included_fields)
            ? power_user.group_card_combine_included_fields
            : ['personality'];
        const persistedFieldSet = new Set(persistedFields);
        fieldToggles.each((_, element) => {
            $(element).prop('checked', persistedFieldSet.has(String($(element).data('field') ?? '')));
        });

        presetSelect.on('change', () => {
            const presetIndex = Number(presetSelect.val());
            const preset = getGroupCardCombinePromptPresets()[presetIndex];

            if (preset) {
                promptInput.val(preset.prompt);
            }
        });

        savePresetButton.on('click', async () => {
            const currentIndex = Number(presetSelect.val());
            const currentPreset = getGroupCardCombinePromptPresets()[currentIndex];
            const presetName = await callGenericPopup('Enter a prompt preset name:', POPUP_TYPE.INPUT, currentPreset?.name ?? '', {
                okButton: 'Save',
                cancelButton: 'Cancel',
            });

            if (!presetName) {
                return;
            }

            const savedPreset = await saveGroupCardCombinePromptPreset(String(presetName), String(promptInput.val() ?? ''));

            if (!savedPreset) {
                return;
            }

            const savedIndex = findGroupCardCombinePromptPresetIndex(savedPreset.name);
            renderGroupCardCombinePromptPresetSelect(presetSelect, savedIndex);
        });

        deletePresetButton.on('click', () => {
            const presetIndex = Number(presetSelect.val());

            if (deleteGroupCardCombinePromptPreset(presetIndex)) {
                renderGroupCardCombinePromptPresetSelect(presetSelect);
            }
        });

        restorePresetButton.on('click', () => {
            promptInput.val(DEFAULT_GROUP_CARD_COMBINE_PROMPT);
        });

        await callGenericPopup(popupContent, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Generate',
            cancelButton: 'Cancel',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onClosing: async (popup) => {
                if (popup.result !== POPUP_RESULT.AFFIRMATIVE) {
                    return true;
                }

                const prompt = String(promptInput.val() ?? '').trim();

                if (!prompt) {
                    toastr.warning('Enter a prompt.', 'Combine into Group Card');
                    return false;
                }

                const createLorebook = Boolean(lorebookToggle.prop('checked'));
                const request = validateGroupCardRequest(String(groupNameInput.val() ?? ''), selectedCharacters, { createLorebook });

                if (!request) {
                    return false;
                }

                const selectedOptionalFields = fieldToggles
                    .toArray()
                    .filter(element => $(element).prop('checked'))
                    .map(element => String($(element).data('field') ?? ''))
                    .filter(field => OPTIONAL_CHARACTER_FIELDS.includes(field));
                const selectedFields = normalizeSelectedFields(selectedOptionalFields);

                power_user.group_card_combine_prompt = prompt;
                power_user.group_card_combine_included_fields = selectedOptionalFields;
                saveSettingsDebounced();

                try {
                    await BulkEditOverlay.#startGroupCardCombinePipeline(request.groupName, prompt, request.characters, createLorebook, selectedFields);
                    await getCharacters();
                    toastr.success(createLorebook ? 'Created group card and linked lorebook.' : 'Created group card.');
                    return true;
                } catch (error) {
                    console.error(error);
                    toastr.error(error?.message ?? 'Failed to combine selected characters.', 'Combine into Group Card');
                    return false;
                }
            },
        });
    };

    /**
     * Starts group card generation pipeline.
     *
     * @param {string} groupName Requested group card name.
     * @param {string} prompt Saved combine prompt.
     * @param {Array<object>} selectedCharacters Valid selected characters.
     * @param {boolean} [createLorebook] Whether to create and link a lorebook.
     * @param {Array<string>} [fields] Included core fields.
     * @returns {Promise<unknown>} Generation result.
     */
    static #startGroupCardCombinePipeline = async (groupName, prompt, selectedCharacters, createLorebook = true, fields) => {
        const loaderHandle = loader.show({
            slug: 'combine-group-card',
            title: t`Combine into Group Card`,
            message: t`Generating "${groupName}" from ${selectedCharacters.length} character(s)…`,
            toastMode: loader.ToastMode.STATIC,
        });

        try {
            const quiet_prompt = buildGroupCardCombineQuietPrompt(prompt, selectedCharacters, fields);
            const generatedDescription = await Generate('quiet', { quiet_prompt });
            const validatedDescription = validateGeneratedGroupCardDescription(generatedDescription, selectedCharacters.length);
            const result = await createGeneratedGroupCard(groupName, validatedDescription, selectedCharacters, createLorebook, fields);

            // Generate Voronoi composite avatar from selected character images
            try {
                const avatarFilenames = selectedCharacters.map(c => c.avatar).filter(Boolean);
                if (avatarFilenames.length > 0) {
                    const compositeResponse = await fetch('/api/characters/generate-voronoi-composite', {
                        method: 'POST',
                        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                        body: JSON.stringify({ avatars: avatarFilenames }),
                    });

                    if (compositeResponse.ok) {
                        const { file } = await compositeResponse.json();
                        if (file) {
                            // Fetch the composite image
                            const imageResponse = await fetch(`/api/characters/generate-voronoi-composite?file=${encodeURIComponent(file)}`);
                            if (imageResponse.ok) {
                                const imageBlob = await imageResponse.blob();

                                // Upload as new avatar
                                const formData = new FormData();
                                formData.append('avatar_url', result.avatar);
                                formData.append('avatar', imageBlob, 'avatar.png');

                                const editHeaders = getRequestHeaders();
                                delete editHeaders['Content-Type'];

                                await fetch('/api/characters/edit-avatar', {
                                    method: 'POST',
                                    headers: editHeaders,
                                    body: formData,
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                console.warn('Failed to generate Voronoi composite avatar:', error);
            }

            return result;
        } finally {
            loaderHandle.hide();
        }
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
        const popupContent = $(BulkEditOverlay.#getDeletePopupContentHtml(characterIds));
        const checkbox = popupContent.find('#del_char_checkbox');
        const promise = callGenericPopup(popupContent, POPUP_TYPE.CONFIRM)
            .then((accept) => {
                if (!accept) return;

                const deleteChats = checkbox.prop('checked') ?? false;

                const loaderHandle = loader.show({
                    slug: 'bulk-delete',
                    title: t`Bulk Delete`,
                    message: t`Deleting ${characterIds.length} character(s)…`,
                    toastMode: loader.ToastMode.STATIC,
                });
                const avatarList = characterIds.map(id => characters[id]?.avatar).filter(a => a);
                return CharacterContextMenu.delete(avatarList, deleteChats)
                    .then(() => this.browseState())
                    .finally(() => loaderHandle.hide());
            });

        // At this moment the popup is already changed in the dom, but not yet closed/resolved. We build the avatar list here
        const entities = characterIds.map(id => characterToEntity(characters[id], id)).filter(entity => entity.item !== undefined);
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

    addStateChangeCallback = callback => this.stateChangeCallbacks.push(callback);

    /**
     * Clears internal character storage and
     * removes visual highlight.
     */
    clearSelectedCharacters = () => {
        document.querySelectorAll('#' + BulkEditOverlay.containerId + ' .' + BulkEditOverlay.selectedClass)
            .forEach(element => element.classList.remove(BulkEditOverlay.selectedClass));
        this.selectedCharacters.length = 0;
    };
}

export {
    BulkEditOverlayState,
    CharacterContextMenu,
    BulkEditOverlay,
    ALWAYS_INCLUDED_CHARACTER_FIELDS,
    OPTIONAL_CHARACTER_FIELDS,
    normalizeName,
    normalizeSelectedFields,
    validateGroupCardRequest,
    getCoreCharacterPayload,
    buildCoreCharacterPromptBlock,
    buildGroupCardCombineQuietPrompt,
    validateGeneratedGroupCardDescription,
    buildLorebookEntryContent,
    buildLorebookEntry,
    buildLorebookData,
    getGroupCardCombinePromptPresets,
    findGroupCardCombinePromptPresetIndex,
    saveGroupCardCombinePromptPreset,
    deleteGroupCardCombinePromptPreset,
    createGeneratedGroupCard,
};
