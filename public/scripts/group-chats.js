import { Fuse } from '../lib.js';

import {
    shuffle,
    onlyUnique,
    debounce,
    delay,
    isDataURL,
    createThumbnail,
    extractAllWords,
    saveBase64AsFile,
    PAGINATION_TEMPLATE,
    getBase64Async,
    resetScrollHeight,
    initScrollHeight,
    localizePagination,
    renderPaginationDropdown,
    paginationDropdownChangeHandler,
    waitUntilCondition,
    uuidv4,
} from './utils.js';
import { RA_CountCharTokens, humanizedDateTime, dragElement, favsToHotswap, getMessageTimeStamp } from './RossAscends-mods.js';
import { power_user, loadMovingUIState, sortEntitiesList } from './power-user.js';
import { debounce_timeout } from './constants.js';

import {
    chat,
    sendSystemMessage,
    printMessages,
    substituteParams,
    characters,
    default_avatar,
    addOneMessage,
    clearChat,
    Generate,
    select_rm_info,
    setCharacterId,
    setCharacterName,
    setEditedMessageId,
    is_send_press,
    resetChatState,
    setSendButtonState,
    getCharacters,
    system_message_types,
    online_status,
    talkativeness_default,
    selectRightMenuWithAnimation,
    deleteLastMessage,
    showSwipeButtons,
    hideSwipeButtons,
    chat_metadata,
    updateChatMetadata,
    syncActiveChatPromptWrapperSettings,
    getThumbnailUrl,
    getRequestHeaders,
    setMenuType,
    menu_type,
    select_selected_character,
    cancelTtsPlay,
    displayPastChats,
    sendMessageAsUser,
    getBiasStrings,
    saveChatConditional,
    deactivateSendButtons,
    activateSendButtons,
    eventSource,
    event_types,
    getCurrentChatId,
    getCurrentVersion,
    setCharacterSettingsOverrides,
    system_avatar,
    isChatSaving,
    setExternalAbortController,
    baseChatReplace,
    createLazyFields,
    depth_prompt_depth_default,
    loadItemizedPrompts,
    animation_duration,
    depth_prompt_role_default,
    showIntegrityDiffPopup,
    shouldAutoContinue,
    unshallowCharacter,
    chatElement,
    ensureMessageMediaIsArray,
    extension_prompt_types,
    extension_prompt_roles,
    getExtensionPromptRoleByName,
    setExtensionPrompt,
} from '../script.js';
import {
    printTagList,
    createTagMapFromList,
    applyTagsOnCharacterSelect,
    tag_map,
    applyTagsOnGroupSelect,
    printTagFilters,
    tag_filter_type,
} from './tags.js';
import { FILTER_TYPES, FilterHelper } from './filters.js';
import { isExternalMediaAllowed } from './chats.js';
import { POPUP_RESULT, POPUP_TYPE, Popup, callGenericPopup } from './popup.js';
import { extension_settings } from './extensions.js';
import { ConnectionManagerRequestService } from './extensions/shared.js';
import { t } from './i18n.js';
import { accountStorage } from './util/AccountStorage.js';
import { compressRequest } from './request-compression.js';

export {
    selected_group,
    openGroupId,
    is_group_automode_enabled,
    hideMutedSprites,
    is_group_generating,
    group_generation_id,
    groups,
    saveGroupChat,
    generateGroupWrapper,
    deleteGroup,
    getGroupAvatar,
    getGroups,
    regenerateGroup,
    resetSelectedGroup,
    select_group_chats,
    getGroupChatNames,
    normalizeDirectorMemberIdList,
    normalizeDirectorHistoryArray,
    filterDirectorQueueForMembers,
    filterDirectorControlledDisabledMembers,
    filterDirectorHistoryByMessageRefs,
    filterDirectorStateForGroup,
    buildDirectorDisabledMembersForInspectorSave,
    applyDirectorInspectorStateToGroup,
    formatDirectorDirectionsForPrompt,
    runDirector,
    refreshDirectorPromptInjectionForGroup,
    setDirectorStatusRunning,
    setDirectorStatusPreview,
    hideDirectorStatus,
};

let is_group_generating = false; // Group generation flag
let is_group_automode_enabled = false;
let hideMutedSprites = false;
/** @type {Group[]} */
let groups = [];
/** @type {string|null} */
let selected_group = null;
let group_generation_id = null;
let fav_grp_checked = false;
let openGroupId = null;
let newGroupMembers = [];

export const group_activation_strategy = {
    NATURAL: 0,
    LIST: 1,
    MANUAL: 2,
    POOLED: 3,
    DIRECTOR: 4,
};

export const group_generation_mode = {
    SWAP: 0,
    APPEND: 1,
    APPEND_DISABLED: 2,
};

export const DEFAULT_AUTO_MODE_DELAY = 5;

export const groupCandidatesFilter = new FilterHelper(debounce(printGroupCandidates, debounce_timeout.quick));
export const groupMembersFilter = new FilterHelper(debounce(printGroupMembers, debounce_timeout.quick));
let autoModeWorker = null;
const saveGroupDebounced = debounce(async (group, reload) => await _save(group, reload), debounce_timeout.relaxed);
/** @type {Map<string, number>} */
let groupChatQueueOrder = new Map();

function setAutoModeWorker() {
    clearInterval(autoModeWorker);
    const autoModeDelay = groups.find((x) => x.id === selected_group)?.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY;
    autoModeWorker = setInterval(groupChatAutoModeWorker, autoModeDelay * 1000);
}

/**
 * Saves a group to the server.
 * @param {Group} group Group object to save
 * @param {boolean} reload Whether to reload characters after saving
 */
async function _save(group, reload = true) {
    await fetch('/api/groups/edit', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(group),
    });
    if (reload) {
        await getCharacters();
    }
}

// Group chats
async function regenerateGroup() {
    let generationId = getLastMessageGenerationId();

    while (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        const this_generationId = lastMes.extra?.gen_id;

        // for new generations after the update
        if (generationId && this_generationId && generationId !== this_generationId) {
            break;
        } else if (lastMes.is_user || lastMes.is_system) {
            // legacy for generations before the update
            break;
        }

        await deleteLastMessage();
    }

    const abortController = new AbortController();
    setExternalAbortController(abortController);
    return generateGroupWrapper(false, 'normal', { signal: abortController.signal });
}

/**
 * Loads group chat messages from the server.
 * @param {string} chatId Chat ID
 * @returns {Promise<ChatFile>} Array of chat messages
 */
async function loadGroupChat(chatId) {
    const response = await fetch('/api/chats/group/get', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId }),
    });

    if (response.ok) {
        const responseData = await response.json();
        const chatArray = Array.isArray(responseData) ? responseData : responseData.data || [];
        const corruptLines = Array.isArray(responseData) ? [] : responseData.corruptLines || [];

        if (corruptLines.length > 0) {
            toastr.warning(
                `Found ${corruptLines.length} corrupt message(s) in this group chat. These messages could not be loaded.`,
                'Chat Data Warning',
                { timeOut: 10000 },
            );
            console.warn('Corrupt group chat lines:', corruptLines);
        }

        return chatArray;
    }

    return [];
}

/**
 * Validates a group by checking if all members exist and removing duplicates.
 * @param {Group} group Group to validate
 * @returns {Promise<void>}
 */
async function validateGroup(group) {
    if (!group) return;

    // Validate that all members exist as characters
    let dirty = false;
    group.members = group.members.filter((member) => {
        const character = characters.find((x) => x.avatar === member || x.name === member);
        if (!character) {
            const msg = t`Warning: Listed member ${member} does not exist as a character. It will be removed from the group.`;
            toastr.warning(msg, t`Group Validation`);
            console.warn(msg);
            dirty = true;
        }
        return character;
    });

    // Remove duplicate chat ids
    if (Array.isArray(group.chats)) {
        const lengthBefore = group.chats.length;
        group.chats = group.chats.filter(onlyUnique);
        const lengthAfter = group.chats.length;
        if (lengthBefore !== lengthAfter) {
            dirty = true;
        }
    }

    if (dirty) {
        await editGroup(group.id, true, false);
    }
}

/**
 * Loads the chat messages for a specific group.
 * @param {string} groupId - The ID of the group to load chat messages for.
 * @param {boolean} reload - Whether to reload the group chat after loading.
 * @returns {Promise<void>} A promise that resolves when the chat messages have been loaded.
 */
export async function getGroupChat(groupId, reload = false) {
    const group = groups.find((x) => x.id === groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }

    // Run validation before any loading
    await validateGroup(group);
    await unshallowGroupMembers(groupId);

    const chat_id = group.chat_id;
    const data = await loadGroupChat(chat_id);
    const metadata = data?.[0]?.chat_metadata ?? {};
    const freshChat = !metadata.tainted && (!Array.isArray(data) || !data.length);

    // Remove chat file header if present
    if (Array.isArray(data) && data.length && Object.hasOwn(data[0], 'chat_metadata')) {
        data.shift();
    }

    // Add integrity slug if missing
    if (!metadata.integrity) {
        metadata.integrity = uuidv4();
    }

    updateChatMetadata(metadata, true);
    const { changed: promptWrapperSettingsChanged } = syncActiveChatPromptWrapperSettings({ markTainted: true });

    await loadItemizedPrompts(getCurrentChatId());

    if (group && Array.isArray(group.members) && freshChat) {
        chat.splice(0, chat.length);
        chatElement.find('.mes').remove();
        for (let member of group.members) {
            const character = characters.find((x) => x.avatar === member || x.name === member);
            if (!character) {
                continue;
            }

            const mes = await getFirstCharacterMessage(character);

            // No first message
            if (!mes?.mes) {
                continue;
            }

            chat.push(mes);
            await eventSource.emit(event_types.MESSAGE_RECEIVED, chat.length - 1, 'first_message');
            addOneMessage(mes);
            await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, chat.length - 1, 'first_message');
        }
        await saveGroupChat(groupId, false);
    } else if (Array.isArray(data) && data.length) {
        chat.splice(0, chat.length, ...data);
        chat.forEach(ensureMessageMediaIsArray);
        chatElement.find('.mes').remove();
        await printMessages();
    }

    if (promptWrapperSettingsChanged && !freshChat) await saveGroupChat(groupId, false);

    if (reload) {
        select_group_chats(groupId, true);
    }

    await eventSource.emit(event_types.CHAT_CHANGED, getCurrentChatId());
    if (freshChat) await eventSource.emit(event_types.GROUP_CHAT_CREATED);
}

/**
 * Retrieves the members of a group
 *
 * @param {string} [groupId=selected_group] - The ID of the group to retrieve members from. Defaults to the currently selected group.
 * @returns {Character[]} An array of character objects representing the members of the group. If the group is not found, an empty array is returned.
 */
export function getGroupMembers(groupId = selected_group) {
    const group = groups.find((x) => x.id === groupId);
    return group?.members.map((member) => characters.find((x) => x.avatar === member)) ?? [];
}

/**
 * Retrieves the member names of a group. If the group is not selected, an empty array is returned.
 * @returns {string[]} An array of character names representing the members of the group.
 */
export function getGroupNames() {
    if (!selected_group) {
        return [];
    }
    const groupMembers = groups.find((x) => x.id == selected_group)?.members;
    return Array.isArray(groupMembers) ? groupMembers.map((x) => characters.find((y) => y.avatar === x)?.name).filter((x) => x) : [];
}

/**
 * Finds the character ID for a group member.
 * @param {number|string} arg 0-based member index or character name
 * @param {Boolean} full Whether to return a key-value object containing extra data
 * @returns {number|Object} 0-based character ID or key-value object if full is true
 */
export function findGroupMemberId(arg, full = false) {
    arg = arg?.toString()?.trim();

    if (!arg) {
        console.warn('WARN: No argument provided for findGroupMemberId');
        return;
    }

    const group = groups.find((x) => x.id == selected_group);

    if (!group || !Array.isArray(group.members)) {
        console.warn('WARN: No group found for selected group ID');
        return;
    }

    const index = parseInt(arg);
    const searchByString = isNaN(index);

    if (searchByString) {
        const memberNames = group.members.map((x) => ({
            avatar: x,
            name: characters.find((y) => y.avatar === x)?.name,
            index: characters.findIndex((y) => y.avatar === x),
        }));
        const fuse = new Fuse(memberNames, { keys: ['avatar', 'name'] });
        const result = fuse.search(arg);

        if (!result.length) {
            console.warn(`WARN: No group member found using string ${arg}`);
            return;
        }

        const chid = result[0].item.index;

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${arg}`);
            return;
        }

        console.log(`Targeting group member ${chid} (${arg}) from search result`, result[0]);

        return !full ? chid : { ...{ id: chid }, ...result[0].item };
    } else {
        const memberAvatar = group.members[index];

        if (memberAvatar === undefined) {
            console.warn(`WARN: No group member found at index ${index}`);
            return;
        }

        const chid = characters.findIndex((x) => x.avatar === memberAvatar);

        if (chid === -1) {
            console.warn(`WARN: No character found for group member ${memberAvatar} at index ${index}`);
            return;
        }

        console.log(`Targeting group member ${memberAvatar} at index ${index}`);

        return !full
            ? chid
            : {
                id: chid,
                avatar: memberAvatar,
                name: characters.find((y) => y.avatar === memberAvatar)?.name,
                index: index,
            };
    }
}

/**
 * Gets depth prompts for group members.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{depth: number, text: string, role: string}[]} Array of depth prompts
 */
export function getGroupDepthPrompts(groupId, characterId) {
    if (!groupId) {
        return [];
    }

    console.debug('getGroupDepthPrompts entered for group: ', groupId);
    const group = groups.find((x) => x.id === groupId);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return [];
    }

    if (group.generation_mode === group_generation_mode.SWAP) {
        return [];
    }

    const depthPrompts = [];

    for (const member of group.members) {
        const index = characters.findIndex((x) => x.avatar === member);
        const character = characters[index];

        if (index === -1 || !character) {
            console.debug(`Skipping missing member: ${member}`);
            continue;
        }

        if (group.disabled_members.includes(member) && characterId !== index) {
            console.debug(`Skipping disabled group member: ${member}`);
            continue;
        }

        const depthPromptText = baseChatReplace(character.data?.extensions?.depth_prompt?.prompt?.trim(), null, character.name) || '';
        const depthPromptDepth = character.data?.extensions?.depth_prompt?.depth ?? depth_prompt_depth_default;
        const depthPromptRole = character.data?.extensions?.depth_prompt?.role ?? depth_prompt_role_default;

        if (depthPromptText) {
            depthPrompts.push({ text: depthPromptText, depth: depthPromptDepth, role: depthPromptRole });
        }
    }

    return depthPrompts;
}

/**
 * Combines group members cards into a single string. Only for groups with generation mode set to APPEND or APPEND_DISABLED.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards combined
 */
export function getGroupCharacterCards(groupId, characterId) {
    const lazy = getGroupCharacterCardsLazy(groupId, characterId);
    if (!lazy) return null;

    // Resolve all lazy fields into a plain object
    return {
        description: lazy.description,
        personality: lazy.personality,
        scenario: lazy.scenario,
        mesExamples: lazy.mesExamples,
    };
}

/**
 * Returns group character cards with lazy evaluation.
 * Each field is only processed when first accessed.
 * @param {string} groupId Group ID
 * @param {number} characterId Current Character ID
 * @returns {{description: string, personality: string, scenario: string, mesExamples: string}} Group character cards with lazy getters
 */
export function getGroupCharacterCardsLazy(groupId, characterId) {
    const group = groups.find((x) => x.id === groupId);

    // If no group cards should be generated, return null so caller knows to fall back
    if (!group || !group?.generation_mode || !Array.isArray(group.members) || !group.members.length) {
        return null;
    }

    /**
     * Runs baseChatReplace on a text, with custom <FIELDNAME> replace
     * @param {string} value Value to replace
     * @param {string} fieldName Name of the field
     * @param {string} characterName Name of the character
     * @param {boolean} trim Whether to trim the value
     * @returns {string} Replaced text
     */
    function customTransform(value, fieldName, characterName, trim) {
        if (!value) return '';
        value = value.replace(/<FIELDNAME>/gi, fieldName);
        value = trim ? value.trim() : value;
        return baseChatReplace(value, null, characterName);
    }

    /**
     * Prepares text with prefix/suffix for a character field
     * @param {string} value Value to replace
     * @param {string} characterName Name of the character
     * @param {string} fieldName Name of the field
     * @param {function(string): string} [preprocess] Preprocess function
     * @returns {string} Prepared text
     */
    function replaceAndPrepareForJoin(value, characterName, fieldName, preprocess = null) {
        value = value?.trim() ?? '';
        if (!value) return '';
        if (typeof preprocess === 'function') {
            value = preprocess(value);
        }
        const prefix = customTransform(group.generation_mode_join_prefix, fieldName, characterName, false);
        const suffix = customTransform(group.generation_mode_join_suffix, fieldName, characterName, false);
        value = customTransform(value, fieldName, characterName, true);
        return `${prefix}${value}${suffix}`;
    }

    /**
     * Collects and joins field values from all group members
     * @param {string} fieldName Display name of the field
     * @param {function(Character): string} getter Function to get field value from character
     * @param {function(string): string} [preprocess] Optional preprocess function
     * @returns {string} Combined field values
     */
    function collectField(fieldName, getter, preprocess = null) {
        const values = [];
        for (const member of group.members) {
            const index = characters.findIndex((x) => x.avatar === member);
            const character = characters[index];
            if (index === -1 || !character) continue;
            if (
                group.disabled_members.includes(member) &&
                characterId !== index &&
                group.generation_mode !== group_generation_mode.APPEND_DISABLED
            ) {
                continue;
            }
            values.push(replaceAndPrepareForJoin(getter(character), character.name, fieldName, preprocess));
        }
        return values.filter((x) => x.length).join('\n');
    }

    const scenarioOverride = String(chat_metadata.scenario || '');
    const mesExamplesOverride = String(chat_metadata.mes_example || '');

    return createLazyFields({
        description: () => collectField('Description', (c) => c.description),
        personality: () => collectField('Personality', (c) => c.personality),
        scenario: () => baseChatReplace(scenarioOverride?.trim()) || collectField('Scenario', (c) => c.scenario),
        mesExamples: () =>
            baseChatReplace(mesExamplesOverride?.trim()) ||
            collectField(
                'Example Messages',
                (c) => c.mes_example,
                (x) => (!x.startsWith('<START>') ? `<START>\n${x}` : x),
            ),
    });
}

/**
 * Gets the first message for a character.
 * @param {Character} character Character object
 * @returns {Promise<ChatMessage>} First message object
 */
async function getFirstCharacterMessage(character) {
    let messageText = character.first_mes;

    // if there are alternate greetings, pick one at random
    if (Array.isArray(character.data?.alternate_greetings)) {
        const messageTexts = [character.first_mes, ...character.data.alternate_greetings].filter((x) => x);
        messageText = messageTexts[Math.floor(Math.random() * messageTexts.length)];
    }

    // Allow extensions to change the first message
    const eventArgs = { input: messageText, output: '', character: character };
    await eventSource.emit(event_types.CHARACTER_FIRST_MESSAGE_SELECTED, eventArgs);
    if (eventArgs.output) {
        messageText = eventArgs.output;
    }

    const mes = {};
    mes.is_user = false;
    mes.is_system = false;
    mes.name = character.name;
    mes.send_date = getMessageTimeStamp();
    mes.original_avatar = character.avatar;
    mes.extra = { gen_id: Date.now() * Math.random() * 1000000 };
    mes.mes = messageText ? substituteParams(messageText.trim(), { name2Override: character.name }) : '';
    mes.force_avatar = character.avatar != 'none' ? getThumbnailUrl('avatar', character.avatar) : default_avatar;
    return mes;
}

function resetSelectedGroup() {
    selected_group = null;
    is_group_generating = false;
}

/**
 * Saves a group chat to the server.
 * @param {string} groupId Group ID
 * @param {boolean} shouldSaveGroup Whether to save the group after saving the chat
 * @param {boolean} force Force the saving on integrity error
 * @returns {Promise<void>} A promise that resolves when the group chat has been saved.
 */
async function saveGroupChat(groupId, shouldSaveGroup, force = false) {
    const group = groups.find((x) => x.id == groupId);
    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }
    const chatId = group.chat_id;
    group.date_last_chat = Date.now();
    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: { ...chat_metadata },
        user_name: 'unused',
        character_name: 'unused',
    };
    const saveGroupChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId, chat: [chatHeader, ...chat], force: force }),
    });
    const response = await fetch('/api/chats/group/save', saveGroupChatRequest);

    if (response.ok) {
        const responseData = await response.json();

        if (responseData.version) {
            const clientVersion = getCurrentVersion();

            if (responseData.version !== clientVersion) {
                toastr.warning(
                    `The server has been updated to v${responseData.version}. You are running v${clientVersion}. Please reload the page to avoid data corruption.`,
                    'Server Version Changed',
                    { timeOut: 0, extendedTimeOut: 0 },
                );
            }
        }
    } else {
        const errorData = await response.json();
        const isIntegrityError = errorData?.error === 'integrity' && !force;
        if (!isIntegrityError) {
            toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group Chat could not be saved`);
            console.error('Group chat could not be saved', response);
            return;
        }

        try {
            const diskResponse = await fetch('/api/chats/group/disk', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chatId }),
            });

            if (!diskResponse.ok) {
                toastr.error('Could not compare group chat versions. Reloading...', 'Integrity Error');
                window.location.reload();
                return;
            }

            const diskData = await diskResponse.json();
            const diskMessages = Array.isArray(diskData) ? diskData : diskData.data || [];
            diskMessages.shift();

            const mergedMessages = await showIntegrityDiffPopup([...chat], diskMessages);

            if (mergedMessages === null) {
                window.location.reload();
                return;
            }

            await saveGroupChatWithData(groupId, shouldSaveGroup, mergedMessages, true);
        } catch (err) {
            console.error('Error during group integrity diff:', err);
            window.location.reload();
        }

        return;
    }

    if (shouldSaveGroup) {
        await editGroup(groupId, false, false);
    }
}

async function saveGroupChatWithData(groupId, shouldSaveGroup, chatData, force = false) {
    const group = groups.find((x) => x.id == groupId);

    if (!group) {
        console.warn('Group not found', groupId);
        return;
    }

    const chatId = group.chat_id;
    group.date_last_chat = Date.now();
    const chatHeader = {
        chat_metadata: { ...chat_metadata },
        user_name: 'unused',
        character_name: 'unused',
    };
    const saveGroupChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId, chat: [chatHeader, ...chatData], force: force }),
    });
    const response = await fetch('/api/chats/group/save', saveGroupChatRequest);

    if (!response.ok) {
        const errorData = await response.json();
        if (errorData?.error === 'integrity' && !force) {
            await saveGroupChat(groupId, shouldSaveGroup, true);
            return;
        }

        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group Chat could not be saved`);
        console.error('Group chat could not be saved', response);
        return;
    }

    const responseData = await response.json();

    if (responseData.version) {
        const clientVersion = getCurrentVersion();

        if (responseData.version !== clientVersion) {
            toastr.warning(
                `The server has been updated to v${responseData.version}. You are running v${clientVersion}. Please reload the page to avoid data corruption.`,
                'Server Version Changed',
                { timeOut: 0, extendedTimeOut: 0 },
            );
        }
    }

    if (shouldSaveGroup) {
        await editGroup(groupId, false, false);
    }
}

/**
 * Renames a group member across all groups and their chats.
 * @param {string} oldAvatar Old avatar name
 * @param {string} newAvatar New avatar name
 * @param {string} newName New character name
 */
export async function renameGroupMember(oldAvatar, newAvatar, newName) {
    // Scan every group for our renamed character
    for (const group of groups) {
        try {
            // Try finding the member by old avatar link
            const memberIndex = group.members.findIndex((x) => x == oldAvatar);

            // Character was not present in the group...
            if (memberIndex == -1) {
                continue;
            }

            // Replace group member avatar id and save the changes
            group.members[memberIndex] = newAvatar;
            await editGroup(group.id, true, false);
            console.log(`Renamed character ${newName} in group: ${group.name}`);

            // Load all chats from this group
            for (const chatId of group.chats) {
                const messages = await loadGroupChat(chatId);

                // Only save the chat if there were any changes to the chat content
                let hadChanges = false;
                // Chat shouldn't be empty
                if (Array.isArray(messages) && messages.length) {
                    // Iterate over every chat message
                    for (const message of messages) {
                        // Skip the chat header
                        if (Object.hasOwn(message, 'chat_metadata')) {
                            continue;
                        }

                        // Only look at character messages
                        if (message.is_user || message.is_system) {
                            continue;
                        }

                        // Message belonged to the old-named character:
                        // Update name, avatar thumbnail URL and original avatar link
                        if (message.force_avatar && message.force_avatar.indexOf(encodeURIComponent(oldAvatar)) !== -1) {
                            message.name = newName;
                            message.force_avatar = message.force_avatar.replace(
                                encodeURIComponent(oldAvatar),
                                encodeURIComponent(newAvatar),
                            );
                            message.original_avatar = newAvatar;
                            hadChanges = true;
                        }
                    }

                    if (hadChanges) {
                        await eventSource.emit(event_types.CHARACTER_RENAMED_IN_PAST_CHAT, messages, oldAvatar, newAvatar);

                        const saveChatRequest = await compressRequest({
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({ id: chatId, chat: [...messages] }),
                        });
                        const saveChatResponse = await fetch('/api/chats/group/save', saveChatRequest);

                        if (!saveChatResponse.ok) {
                            throw new Error('Group member could not be renamed');
                        }

                        console.log(`Renamed character ${newName} in group chat: ${chatId}`);
                    }
                }
            }
        } catch (error) {
            console.log(`An error during renaming the character ${newName} in group: ${group.name}`);
            console.error(error);
        }
    }
}

/**
 * Fetches all groups from the server and processes them.
 */
async function getGroups() {
    const response = await fetch('/api/groups/all', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (response.ok) {
        /** @type {Group[]} */
        const data = await response.json();
        groups = data.slice();

        // Convert groups to new format
        for (const group of groups) {
            if (typeof group.id === 'number') {
                group.id = String(group.id);
            }
            if (group.disabled_members == undefined) {
                group.disabled_members = [];
            }
            if (group.chat_id == undefined) {
                group.chat_id = group.id;
                group.chats = [group.id];
                group.members = group.members
                    .map((x) => characters.find((y) => y.name == x)?.avatar)
                    .filter((x) => x)
                    .filter(onlyUnique);
            }
            if (typeof group.chat_id === 'number') {
                group.chat_id = String(group.chat_id);
            }
            if (Array.isArray(group.chats) && group.chats.some((x) => typeof x === 'number')) {
                group.chats = group.chats.map((x) => String(x));
            }
        }
    }
}

/**
 * Gets a group UI block for the list.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group block
 */
export function getGroupBlock(group) {
    let count = 0;
    let namesList = [];

    // Build inline name list
    if (Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const character = characters.find((x) => x.avatar === member || x.name === member);
            if (character) {
                namesList.push(character.name);
                count++;
            }
        }
    }

    const template = $('#group_list_template .group_select').clone();
    template.data('id', group.id);
    template.attr('data-grid', group.id);
    template.find('.ch_name').text(group.name).attr('title', `[Group] ${group.name}`);
    template.find('.group_fav_icon').css('display', 'none');
    template.addClass(group.fav ? 'is_fav' : '');
    template.find('.ch_fav').val(String(group.fav));
    template.find('.group_select_counter').text(count + ' ' + (count != 1 ? t`characters` : t`character`));
    template.find('.group_select_block_list').text(namesList.join(', '));

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: group.id, tagOptions: { isCharacterList: true } });

    const avatar = getGroupAvatar(group);
    if (avatar) {
        $(template).find('.avatar').replaceWith(avatar);
    }

    return template;
}

/**
 * Updates the avatar display for a given group.
 * @param {Group} group Group object
 */
function updateGroupAvatar(group) {
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));

    $('.group_select').each(function () {
        if ($(this).data('id') == group.id) {
            $(this).find('.avatar').replaceWith(getGroupAvatar(group));
        }
    });

    favsToHotswap();
}

/**
 * Checks if a URL is a valid image URL.
 * @param {string} url URL to check
 * @returns {boolean} True if valid, false otherwise
 */
function isValidImageUrl(url) {
    // check if empty dict
    if (!url || Object.keys(url).length === 0) {
        return false;
    }
    return isDataURL(url) || (url && (url.startsWith('user') || url.startsWith('/user')));
}

/**
 * Gets a group avatar element.
 * @param {Group} group Group object
 * @returns {JQuery<HTMLElement>} Group avatar element
 */
function getGroupAvatar(group) {
    if (!group) {
        return $(`<div class="avatar"><img src="${default_avatar}"></div>`);
    }
    // if isDataURL or if it's a valid local file url
    if (isValidImageUrl(group.avatar_url)) {
        return $(`<div class="avatar" title="[Group] ${group.name}"><img src="${group.avatar_url}"></div>`);
    }

    const memberAvatars = [];
    if (group && Array.isArray(group.members) && group.members.length) {
        for (const member of group.members) {
            const charIndex = characters.findIndex((x) => x.avatar === member);
            if (charIndex !== -1 && characters[charIndex].avatar !== 'none') {
                const avatar = getThumbnailUrl('avatar', characters[charIndex].avatar);
                memberAvatars.push(avatar);
            }
            if (memberAvatars.length === 4) {
                break;
            }
        }
    }

    const avatarCount = memberAvatars.length;

    if (avatarCount >= 1 && avatarCount <= 4) {
        const groupAvatar = $(`#group_avatars_template .collage_${avatarCount}`).clone();

        for (let i = 0; i < avatarCount; i++) {
            groupAvatar.find(`.img_${i + 1}`).attr('src', memberAvatars[i]);
        }

        groupAvatar.attr('title', `[Group] ${group.name}`);
        return groupAvatar;
    }

    // catch edge case where group had one member and that member is deleted
    if (avatarCount === 0) {
        return $('<div class="missing-avatar fa-solid fa-user-slash"></div>');
    }

    // default avatar
    const groupAvatar = $('#group_avatars_template .collage_1').clone();
    groupAvatar.find('.img_1').attr('src', group.avatar_url || system_avatar);
    groupAvatar.attr('title', `[Group] ${group.name}`);
    return groupAvatar;
}

/**
 * Gets chat IDs for a group.
 * @param {string} groupId Group ID
 * @returns {string[]} Array of chat IDs
 */
function getGroupChatNames(groupId) {
    const group = groups.find((x) => x.id === groupId);

    if (!group) {
        return [];
    }

    const names = [];
    for (const chatId of group.chats) {
        names.push(chatId);
    }
    return names;
}

/**
 * Generates text for the group chat by queueing members according to the activation strategy.
 * @param {boolean} byAutoMode If the generation was triggered by the auto mode.
 * @param {string?} type Generation type
 * @param {object} params Additional Generate parameters
 * @returns {Promise<string|void>} Generated text or nothing if no generation occurred
 */
async function generateGroupWrapper(byAutoMode, type = null, params = {}) {
    function throwIfAborted() {
        if (params.signal instanceof AbortSignal && params.signal.aborted) {
            throw new Error('AbortSignal was fired. Group generation stopped');
        }
    }

    if (online_status === 'no_connection') {
        is_group_generating = false;
        setSendButtonState(false);
        return Promise.resolve();
    }

    if (is_group_generating) {
        return Promise.resolve();
    }

    // Auto-navigate back to group menu
    if (menu_type !== 'group_edit') {
        select_group_chats(selected_group, false);
        await delay(1);
    }

    /** @type {any} Caution: JS war crimes ahead */
    let textResult = '';
    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        sendSystemMessage(system_message_types.EMPTY, '', { isSmallSys: true });
        return Promise.resolve();
    }

    try {
        await unshallowGroupMembers(selected_group);

        throwIfAborted();
        hideSwipeButtons();
        is_group_generating = true;
        setCharacterName('');
        setCharacterId(undefined);
        const userInput = String($('#send_textarea').val());

        // id of this specific batch for regeneration purposes
        group_generation_id = Date.now();
        const lastMessage = chat[chat.length - 1];
        let activationText = '';
        let isUserInput = false;

        if (userInput?.length && !byAutoMode) {
            isUserInput = true;
            activationText = userInput;
        } else {
            if (lastMessage && !lastMessage.is_system) {
                activationText = lastMessage.mes;
            }
        }

        const activationStrategy = Number(group.activation_strategy ?? group_activation_strategy.NATURAL);
        const enabledMembers = group.members.filter((x) => !group.disabled_members.includes(x));
        let activatedMembers = [];
        let useDirectorOverride = false;
        let directorRunSucceeded = false;

        if (params && typeof params.force_chid == 'number') {
            activatedMembers = [params.force_chid];
        } else if (type === 'quiet') {
            activatedMembers = activateSwipe(group.members, { allowSystem: true }).slice(0, 1);

            if (activatedMembers.length === 0) {
                activatedMembers = activateListOrder(group.members.slice(0, 1));
            }
        } else if (type === 'swipe' || type === 'continue') {
            activatedMembers = activateSwipe(group.members, { allowSystem: false });

            if (activatedMembers.length === 0) {
                toastr.warning(t`Deleted group member swiped. To get a reply, add them back to the group.`);
                throw new Error('Deleted group member swiped');
            }
        } else if (type === 'impersonate') {
            activatedMembers = activateImpersonate(group.members);
        } else if (activationStrategy === group_activation_strategy.NATURAL) {
            activatedMembers = activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
        } else if (activationStrategy === group_activation_strategy.LIST) {
            activatedMembers = activateListOrder(enabledMembers);
        } else if (activationStrategy === group_activation_strategy.POOLED) {
            activatedMembers = activatePooledOrder(enabledMembers, lastMessage, isUserInput);
        } else if (activationStrategy === group_activation_strategy.DIRECTOR) {
            try {
                directorRunSucceeded = await runDirector(group);
            } catch (directorError) {
                console.error('Director run failed, continuing with natural group generation:', directorError);
            }

            const directorOverride = directorRunSucceeded ? getDirectorActivationOverride(group) : null;
            useDirectorOverride = !!directorOverride?.length && (!type || type === 'normal');
            activatedMembers = useDirectorOverride
                ? directorOverride
                : activateNaturalOrder(enabledMembers, activationText, lastMessage, group.allow_self_responses, isUserInput);
        } else if (activationStrategy === group_activation_strategy.MANUAL && !isUserInput) {
            activatedMembers = shuffle(enabledMembers)
                .slice(0, 1)
                .map((x) => characters.findIndex((y) => y.avatar === x))
                .filter((x) => x !== -1);
        }

        const directorPromptApplied =
            activatedMembers.length > 0 &&
            activationStrategy === group_activation_strategy.DIRECTOR &&
            directorRunSucceeded &&
            applyDirectorPromptInjection(group);
        if (!directorPromptApplied) {
            clearDirectorPromptInjection();
        }

        if (activatedMembers.length === 0) {
            //toastr.warning('All group members are disabled. Enable at least one to get a reply.');

            // Send user message as is
            const bias = getBiasStrings(userInput, type);
            await sendMessageAsUser(userInput, bias.messageBias);
            await saveChatConditional();
            $('#send_textarea')
                .val('')[0]
                .dispatchEvent(new Event('input', { bubbles: true }));
        }
        groupChatQueueOrder = new Map();

        if (power_user.show_group_chat_queue) {
            for (let i = 0; i < activatedMembers.length; ++i) {
                groupChatQueueOrder.set(characters[activatedMembers[i]].avatar, i + 1);
            }
        }
        await eventSource.emit(event_types.GROUP_WRAPPER_STARTED, { selected_group, type });
        // now the real generation begins: cycle through every activated character
        for (const chId of activatedMembers) {
            throwIfAborted();
            deactivateSendButtons();
            setCharacterId(chId);
            setCharacterName(characters[chId].name);
            if (power_user.show_group_chat_queue) {
                printGroupMembers();
            }
            await eventSource.emit(event_types.GROUP_MEMBER_DRAFTED, chId);

            // Wait for generation to finish
            const generateType = ['swipe', 'impersonate', 'quiet', 'continue'].includes(type) ? type : 'normal';
            textResult = await Generate(generateType, { automatic_trigger: byAutoMode, ...(params || {}) });
            let messageChunk = textResult?.messageChunk;

            if (messageChunk) {
                while (shouldAutoContinue(messageChunk, type === 'impersonate')) {
                    textResult = await Generate('continue', { automatic_trigger: byAutoMode, ...(params || {}) });
                    messageChunk = textResult?.messageChunk;
                }
            }
            const generatedAvatar = characters[chId].avatar;
            if (power_user.show_group_chat_queue) {
                groupChatQueueOrder.delete(generatedAvatar);
                groupChatQueueOrder.forEach((value, key, map) => map.set(key, value - 1));
            }

            if (useDirectorOverride && consumeDirectorQueueSpeaker(group, generatedAvatar)) {
                await saveDirectorStateAndRefreshPrompt(group, false);
            }
        }
    } finally {
        clearDirectorPromptInjection();
        is_group_generating = false;
        setSendButtonState(false);
        setCharacterId(undefined);
        if (power_user.show_group_chat_queue) {
            groupChatQueueOrder = new Map();
            printGroupMembers();
        }
        setCharacterName('');
        activateSendButtons();
        showSwipeButtons();
        await eventSource.emit(event_types.GROUP_WRAPPER_FINISHED, { selected_group, type });
    }

    return Promise.resolve(textResult);
}

/**
 * Gets the generation ID of the last chat message.
 * @returns {number|null} Generation ID or null
 */
function getLastMessageGenerationId() {
    let generationId = null;
    if (chat.length > 0) {
        const lastMes = chat[chat.length - 1];
        if (!lastMes.is_user && !lastMes.is_system && lastMes.extra) {
            generationId = lastMes.extra.gen_id;
        }
    }
    return generationId;
}

/**
 * Activate group chat members for 'impersonate' generation type.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function activateImpersonate(members) {
    const randomIndex = Math.floor(Math.random() * members.length);
    const activatedMembers = [members[randomIndex]];
    const memberIds = activatedMembers.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activates a group member based on the last message.
 * @param {string[]} members Array of group member avatar ids
 * @param {Object} [options] Options object
 * @param {boolean} [options.allowSystem] Whether to allow system messages
 * @returns {number[]} Array of character ids
 */
function activateSwipe(members, { allowSystem = false } = {}) {
    let activatedNames = [];
    const lastMessage = chat[chat.length - 1];

    if (!lastMessage) {
        return [];
    }

    if (lastMessage.is_user || (!allowSystem && lastMessage.is_system) || lastMessage.extra?.type === system_message_types.NARRATOR) {
        for (const message of chat.slice().reverse()) {
            if (message.is_user || (!allowSystem && message.is_system) || message.extra?.type === system_message_types.NARRATOR) {
                continue;
            }

            if (message.original_avatar) {
                activatedNames.push(message.original_avatar);
                break;
            }
        }

        if (activatedNames.length === 0) {
            activatedNames.push(shuffle(members.slice())[0]);
        }
    }

    // pre-update group chat swipe
    if (!lastMessage.original_avatar) {
        const matches = characters.filter((x) => x.name == lastMessage.name);

        for (const match of matches) {
            if (members.includes(match.avatar)) {
                activatedNames.push(match.avatar);
                break;
            }
        }
    } else {
        activatedNames.push(lastMessage.original_avatar);
    }

    const memberIds = activatedNames.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members for the list activation order.
 * @param {string[]} members Array of group member avatar ids
 * @returns {number[]} Array of character ids
 */
function activateListOrder(members) {
    let activatedMembers = members.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
    return memberIds;
}

/**
 * Activate group members based on the last message.
 * @param {string[]} members List of member avatars
 * @param {Object} lastMessage Last message
 * @param {boolean} isUserInput Whether the user has input text
 * @returns {number[]} List of character ids
 */
function activatePooledOrder(members, lastMessage, isUserInput) {
    /** @type {string} */
    let activatedMember = null;
    /** @type {string[]} */
    const spokenSinceUser = [];

    for (const message of chat.slice().reverse()) {
        if (message.is_user || isUserInput) {
            break;
        }

        if (message.is_system || message.extra?.type === system_message_types.NARRATOR) {
            continue;
        }

        if (message.original_avatar) {
            spokenSinceUser.push(message.original_avatar);
        }
    }

    const haveNotSpoken = members.filter((x) => !spokenSinceUser.includes(x));

    if (haveNotSpoken.length) {
        activatedMember = haveNotSpoken[Math.floor(Math.random() * haveNotSpoken.length)];
    }

    if (activatedMember === null) {
        const lastMessageAvatar = members.length > 1 && lastMessage && !lastMessage.is_user && lastMessage.original_avatar;
        const randomPool = lastMessageAvatar ? members.filter((x) => x !== lastMessage.original_avatar) : members;
        activatedMember = randomPool[Math.floor(Math.random() * randomPool.length)];
    }

    const memberId = characters.findIndex((y) => y.avatar === activatedMember);
    return memberId !== -1 ? [memberId] : [];
}

/**
 * Activate group members for the natural activation order.
 * @param {string[]} members Array of group member avatar ids
 * @param {string} input User input that triggered the generation
 * @param {ChatMessage} lastMessage Last message in the chat
 * @param {boolean} allowSelfResponses If the group allows self-responses
 * @param {boolean} isUserInput If the generation was triggered by user input
 * @returns {number[]} Array of character ids
 */
function activateNaturalOrder(members, input, lastMessage, allowSelfResponses, isUserInput) {
    let activatedMembers = [];

    // prevents the same character from speaking twice
    let bannedUser = !isUserInput && lastMessage && !lastMessage.is_user && lastMessage.name;

    // ...unless allowed to do so
    if (allowSelfResponses) {
        bannedUser = undefined;
    }

    // find mentions (excluding self)
    if (input && input.length) {
        for (let inputWord of extractAllWords(input)) {
            for (let member of members) {
                const character = characters.find((x) => x.avatar === member);

                if (!character || character.name === bannedUser) {
                    continue;
                }

                if (extractAllWords(character.name).includes(inputWord)) {
                    activatedMembers.push(member);
                    break;
                }
            }
        }
    }

    const chattyMembers = [];
    // activation by talkativeness (in shuffled order, except banned)
    const shuffledMembers = shuffle([...members]);
    for (let member of shuffledMembers) {
        const character = characters.find((x) => x.avatar === member);

        if (!character || character.name === bannedUser) {
            continue;
        }

        const rollValue = Math.random();
        const talkativeness = isNaN(character.talkativeness) ? talkativeness_default : Number(character.talkativeness);
        if (talkativeness >= rollValue) {
            activatedMembers.push(member);
        }
        if (talkativeness > 0) {
            chattyMembers.push(member);
        }
    }

    // pick 1 at random if no one was activated
    let retries = 0;
    // try to limit the selected random character to those with talkativeness > 0
    const randomPool = chattyMembers.length > 0 ? chattyMembers : members;
    while (activatedMembers.length === 0 && ++retries <= randomPool.length) {
        const randomIndex = Math.floor(Math.random() * randomPool.length);
        const character = characters.find((x) => x.avatar === randomPool[randomIndex]);

        if (!character) {
            continue;
        }

        activatedMembers.push(randomPool[randomIndex]);
    }

    // de-duplicate array of character avatars
    activatedMembers = activatedMembers.filter(onlyUnique);

    // map to character ids
    const memberIds = activatedMembers.map((x) => characters.findIndex((y) => y.avatar === x)).filter((x) => x !== -1);
    return memberIds;
}

/**
 * Deletes a group from the server by ID.
 * @param {string} id Group ID to delete
 * @returns {Promise<void>} Promise that resolves when the group is deleted
 */
async function deleteGroup(id) {
    const group = groups.find((x) => x.id === id);

    const response = await fetch('/api/groups/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: id }),
    });

    if (group && Array.isArray(group.chats)) {
        for (const chatId of group.chats) {
            await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
        }
    }

    if (response.ok) {
        await clearChat();
        selected_group = null;
        delete tag_map[id];
        resetChatState();
        await printMessages();
        await getCharacters();

        select_rm_info('group_delete', id);

        $('#rm_button_selected_ch').children('h2').text('');
    }
}

/**
 * Edits a group by ID.
 * @param {string} id Group ID to edit
 * @param {boolean} immediately Whether to save immediately
 * @param {boolean} reload Whether to reload the groups after saving
 * @returns {Promise<void>} Promise that resolves when the group is edited
 */
export async function editGroup(id, immediately, reload = true) {
    let group = groups.find((x) => x.id === id);

    if (!group) {
        return;
    }

    if (immediately) {
        return await _save(group, reload);
    }

    saveGroupDebounced(group, reload);
}

/**
 * Unshallows all definitions of group members.
 * @param {string} groupId Id of the group
 * @returns {Promise<void>} Promise that resolves when all group members are unshallowed
 */
export async function unshallowGroupMembers(groupId) {
    const group = groups.find((x) => x.id == groupId);
    if (!group) {
        return;
    }
    const members = group.members;
    if (!Array.isArray(members)) {
        return;
    }
    for (const member of members) {
        const index = characters.findIndex((x) => x.avatar === member);
        if (index === -1) {
            continue;
        }
        await unshallowCharacter(String(index));
    }
}

let groupAutoModeAbortController = null;

async function groupChatAutoModeWorker() {
    if (!is_group_automode_enabled || online_status === 'no_connection') {
        return;
    }

    if (!selected_group || is_send_press || is_group_generating) {
        return;
    }

    const group = groups.find((x) => x.id === selected_group);

    if (!group || !Array.isArray(group.members) || !group.members.length) {
        return;
    }

    groupAutoModeAbortController = new AbortController();
    await generateGroupWrapper(true, 'auto', { signal: groupAutoModeAbortController.signal });
}

/**
 * Modifies a group member by adding or removing them.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {boolean} isDelete If true, removes the member; otherwise adds the member
 */
async function modifyGroupMember(groupId, groupMember, isDelete) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const membersArray = thisGroup?.members ?? newGroupMembers;

    if (isDelete) {
        const index = membersArray.findIndex((x) => x === id);
        if (index !== -1) {
            membersArray.splice(membersArray.indexOf(id), 1);
        }
    } else {
        membersArray.unshift(id);
    }

    if (openGroupId) {
        await unshallowGroupMembers(openGroupId);
        await editGroup(openGroupId, false, false);
        updateGroupAvatar(thisGroup);
    }

    printGroupCandidates();
    printGroupMembers();

    // Refresh the tag filters for both lists to reflect any new tags
    printTagFilters(tag_filter_type.group_candidates_list);
    printTagFilters(tag_filter_type.group_members_list);

    const groupHasMembers = getGroupCharacters({ doFilter: false, onlyMembers: true }).length > 0;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
}

/**
 * Reorders a group member up or down.
 * @param {string} groupId Group ID
 * @param {JQuery<HTMLElement>} groupMember Group member element
 * @param {string} direction Direction to move the member ('up' or 'down')
 * @returns {Promise<void>} Promise that resolves when the member has been reordered
 */
async function reorderGroupMember(groupId, groupMember, direction) {
    const id = groupMember.data('id');
    const thisGroup = groups.find((x) => x.id == groupId);
    const memberArray = thisGroup?.members ?? newGroupMembers;

    const indexOf = memberArray.indexOf(id);
    if (direction == 'down') {
        const next = memberArray[indexOf + 1];
        if (next) {
            memberArray[indexOf + 1] = memberArray[indexOf];
            memberArray[indexOf] = next;
        }
    }
    if (direction == 'up') {
        const prev = memberArray[indexOf - 1];
        if (prev) {
            memberArray[indexOf - 1] = memberArray[indexOf];
            memberArray[indexOf] = prev;
        }
    }

    printGroupMembers();

    // Existing groups need to modify members list
    if (openGroupId) {
        await editGroup(groupId, false, false);
        updateGroupAvatar(thisGroup);
    }
}

async function onGroupActivationStrategyInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.activation_strategy = Number(e.target.value);
        if (!isDirectorStrategy(_thisGroup)) {
            clearDirectorPromptInjection();
        }
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupGenerationModeInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.generation_mode = Number(e.target.value);
        await editGroup(openGroupId, false, false);

        toggleHiddenControls(_thisGroup);
    }
}

async function onGroupAutoModeDelayInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.auto_mode_delay = Number(e.target.value);
        await editGroup(openGroupId, false, false);
        setAutoModeWorker();
    }
}

async function onGroupGenerationModeTemplateInput(e) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const prop = $(e.target).attr('setting');
        _thisGroup[prop] = String(e.target.value);
        await editGroup(openGroupId, false, false);
    }
}

async function onGroupNameInput() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.name = $(this).val();
        $('#rm_button_selected_ch').children('h2').text(_thisGroup.name);
        await editGroup(openGroupId, false);
    }
}

/**
 * Checks if a character with the given avatar ID is a member of the group.
 * @param {Group} group Group object
 * @param {string} avatarId Avatar ID to check
 * @returns {boolean} True if the avatar is a member of the group, false otherwise
 */
function isGroupMember(group, avatarId) {
    if (group && Array.isArray(group.members)) {
        return group.members.includes(avatarId);
    } else {
        return newGroupMembers.includes(avatarId);
    }
}

/**
 * Gets group characters based on filters.
 * @param {object} param
 * @param {boolean} [param.doFilter=false] Whether to apply filters
 * @param {boolean} [param.onlyMembers=false] Whether to include only group members
 * @returns {Array<{item: Character, id: number, type: string}>} Array of group character objects
 */
function getGroupCharacters({ doFilter = false, onlyMembers = false } = {}) {
    function applyFilterAndSort(results, filter, filterSelector) {
        let filtered = results;
        if (doFilter) {
            filtered = filter.applyFilters(filtered);
        }
        const useFilterOrder = doFilter && !!$(filterSelector).val();
        sortEntitiesList(filtered, useFilterOrder, filter);
        filter.clearFuzzySearchCaches();
        return filtered;
    }

    function handleMembers(results, thisGroup) {
        const membersArray = thisGroup?.members ?? newGroupMembers;

        // Create index map for O(1) lookups in member sort function
        // (separate from characterIndexMap which maps character objects to their array indices)
        const memberIndexMap = new Map(membersArray.map((avatar, index) => [avatar, index]));

        function sortMembersFn(a, b) {
            const aIndex = memberIndexMap.get(a.item.avatar) ?? -1;
            const bIndex = memberIndexMap.get(b.item.avatar) ?? -1;
            return aIndex - bIndex;
        }

        // Apply manual member sort before filter and sort
        let filtered = results;
        if (doFilter) {
            filtered = groupMembersFilter.applyFilters(filtered);
        }
        filtered.sort(sortMembersFn);

        // Apply conditional filter-based sort and cleanup
        const useFilterOrder = doFilter && !!$('#rm_group_members_filter').val();
        if (useFilterOrder) {
            sortEntitiesList(filtered, useFilterOrder, groupMembersFilter);
        }
        groupMembersFilter.clearFuzzySearchCaches();
        return filtered;
    }

    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);

    // Create index map for O(1) lookups when mapping characters to their array indices
    // (separate from memberIndexMap used later for sorting members by their group order)
    const characterIndexMap = new Map(characters.map((char, index) => [char, index]));

    const results = characters
        .filter((x) => isGroupMember(thisGroup, x.avatar) == onlyMembers)
        .map((x) => ({ item: x, id: characterIndexMap.get(x), type: 'character' }));

    // Early return for candidates (non-members)
    if (!onlyMembers) {
        return applyFilterAndSort(results, groupCandidatesFilter, '#rm_group_filter');
    }

    // Handle members with manual sort capability
    return handleMembers(results, thisGroup);
}

function printGroupCandidates() {
    const storageKey = 'GroupCandidates_PerPage';
    const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
    const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
    $('#rm_group_add_members_pagination').pagination({
        dataSource: getGroupCharacters({ doFilter: true, onlyMembers: false }),
        pageRange: 1,
        position: 'top',
        showPageNumbers: false,
        prevText: '<',
        nextText: '>',
        formatNavigator: PAGINATION_TEMPLATE,
        formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
        showNavigator: true,
        showSizeChanger: true,
        pageSize,
        afterSizeSelectorChange: function (e, size) {
            accountStorage.setItem(storageKey, e.target.value);
            paginationDropdownChangeHandler(e, size);
        },
        callback: function (data) {
            $('#rm_group_add_members').empty();
            for (const i of data) {
                $('#rm_group_add_members').append(getGroupCharacterBlock(i.item));
            }
            localizePagination($('#rm_group_add_members_pagination'));
        },
    });
}

function printGroupMembers() {
    const storageKey = 'GroupMembers_PerPage';
    $('.rm_group_members_pagination').each(function () {
        let that = this;
        const pageSize = Number(accountStorage.getItem(storageKey)) || 5;
        const sizeChangerOptions = [5, 10, 25, 50, 100, 200, 500, 1000];
        $(this).pagination({
            dataSource: getGroupCharacters({ doFilter: true, onlyMembers: true }),
            pageRange: 1,
            position: 'top',
            showPageNumbers: false,
            prevText: '<',
            nextText: '>',
            formatNavigator: PAGINATION_TEMPLATE,
            showNavigator: true,
            showSizeChanger: true,
            formatSizeChanger: renderPaginationDropdown(pageSize, sizeChangerOptions),
            pageSize,
            afterSizeSelectorChange: function (e, size) {
                accountStorage.setItem(storageKey, e.target.value);
                paginationDropdownChangeHandler(e, size);
            },
            callback: function (data) {
                $('.rm_group_members').empty();
                for (const i of data) {
                    $('.rm_group_members').append(getGroupCharacterBlock(i.item));
                }
                localizePagination($(that));
            },
        });
    });
}

/**
 * Creates a jQuery element representing a group character block.
 * @param {Character} character Character object
 * @returns {JQuery<HTMLElement>} jQuery element representing the group character block
 */
function getGroupCharacterBlock(character) {
    const avatar = getThumbnailUrl('avatar', character.avatar);
    const template = $('#group_member_template .group_member').clone();
    const isFav = !!character.fav || character.fav == 'true';
    template.data('id', character.avatar);
    template.find('.avatar img').attr({ src: avatar, title: character.avatar });
    template.find('.ch_name').text(character.name);
    template.attr('data-chid', characters.indexOf(character));
    template.find('.ch_fav').val(String(isFav));
    template.toggleClass('is_fav', isFav);

    const auxFieldName = power_user.aux_field || 'character_version';
    const auxFieldValue = (character.data && character.data[auxFieldName]) || '';
    if (auxFieldValue) {
        template.find('.character_version').text(auxFieldValue);
    } else {
        template.find('.character_version').hide();
    }

    let queuePosition = groupChatQueueOrder.get(character.avatar);
    if (queuePosition) {
        template.find('.queue_position').text(queuePosition);
        template.toggleClass('is_queued', queuePosition > 1);
        template.toggleClass('is_active', queuePosition === 1);
    }

    template.toggleClass('disabled', isGroupMemberDisabled(character.avatar));

    // Display inline tags
    const tagsElement = template.find('.tags');
    printTagList(tagsElement, { forEntityOrKey: characters.indexOf(character), tagOptions: { isCharacterList: true } });

    if (!openGroupId) {
        template.find('[data-action="speak"]').hide();
        template.find('[data-action="enable"]').hide();
        template.find('[data-action="disable"]').hide();
    }

    return template;
}

/**
 * Checks if a group member is disabled.
 * @param {string} avatarId Avatar ID of the group member
 * @returns {boolean} True if the group member is disabled, false otherwise
 */
function isGroupMemberDisabled(avatarId) {
    const thisGroup = openGroupId && groups.find((x) => x.id == openGroupId);
    return Boolean(thisGroup && thisGroup.disabled_members.includes(avatarId));
}

async function onDeleteGroupClick() {
    if (!openGroupId) {
        toastr.warning(t`Currently no group selected.`);
        return;
    }
    if (is_group_generating) {
        toastr.warning(t`Not so fast! Wait for the characters to stop typing before deleting the group.`);
        return;
    }

    const confirm = await Popup.show.confirm(
        t`Delete the group?`,
        '<p>' +
        t`This will also delete all your chats with that group. If you want to delete a single conversation, select a "View past chats" option in the lower left menu.` +
        '</p>',
    );
    if (confirm) {
        deleteGroup(openGroupId);
    }
}

async function onFavoriteGroupClick() {
    updateFavButtonState(!fav_grp_checked);
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.fav = fav_grp_checked;
        await editGroup(openGroupId, false, false);
        favsToHotswap();
    }
}

async function onGroupSelfResponsesClick() {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        const value = $(this).prop('checked');
        _thisGroup.allow_self_responses = value;
        await editGroup(openGroupId, false, false);
    }
}

async function onHideMutedSpritesClick(value) {
    if (openGroupId) {
        let _thisGroup = groups.find((x) => x.id == openGroupId);
        _thisGroup.hideMutedSprites = value;
        console.log(`_thisGroup.hideMutedSprites = ${_thisGroup.hideMutedSprites}`);
        await editGroup(openGroupId, false, false);
        await eventSource.emit(event_types.GROUP_UPDATED);
    }
}

/**
 * Toggles the visibility of hidden controls based on the group's generation mode.
 * @param {Group} group Group object
 * @param {number|null} generationMode Generation mode, or null to use the group's current generation mode
 */
function toggleHiddenControls(group, generationMode = null) {
    const isJoin = [group_generation_mode.APPEND, group_generation_mode.APPEND_DISABLED].includes(generationMode ?? group?.generation_mode);
    $('#rm_group_generation_mode_join_prefix').parent().toggle(isJoin);
    $('#rm_group_generation_mode_join_suffix').parent().toggle(isJoin);

    if (!CSS.supports('field-sizing', 'content')) {
        initScrollHeight($('#rm_group_generation_mode_join_prefix'));
        initScrollHeight($('#rm_group_generation_mode_join_suffix'));
    }
}

/**
 * Opens a group creation/editing right menu.
 * @param {string|null} groupId ID of the group to select or null if creating a new group
 * @param {boolean} skipAnimation If true, skips the animation when selecting the group
 */
function select_group_chats(groupId, skipAnimation) {
    openGroupId = groupId;
    newGroupMembers = [];
    const group = openGroupId && groups.find((x) => x.id == openGroupId);
    if (group) {
        loadDirectorSettings(group);
    }
    const groupName = group?.name ?? '';
    const replyStrategy = Number(group?.activation_strategy ?? group_activation_strategy.NATURAL);
    const generationMode = Number(group?.generation_mode ?? group_generation_mode.SWAP);

    setMenuType(group ? 'group_edit' : 'group_create');
    $('#group_avatar_preview').empty().append(getGroupAvatar(group));
    $('#rm_group_restore_avatar').toggle(!!group && isValidImageUrl(group.avatar_url));
    $('#rm_group_filter').val('').trigger('input');
    $('#rm_group_members_filter').val('').trigger('input');
    $('#rm_group_activation_strategy').val(replyStrategy);
    $(`#rm_group_activation_strategy option[value="${replyStrategy}"]`).prop('selected', true);
    $('#rm_group_generation_mode').val(generationMode);
    $(`#rm_group_generation_mode option[value="${generationMode}"]`).prop('selected', true);
    $('#rm_group_chat_name').val(groupName);

    if (!skipAnimation) {
        selectRightMenuWithAnimation('rm_group_chats_block');
    }

    // render tags
    applyTagsOnGroupSelect(groupId);

    // render characters list
    printGroupCandidates();
    printGroupMembers();

    const groupHasMembers = !!$('#rm_group_members').children().length;
    $('#rm_group_submit').prop('disabled', !groupHasMembers);
    $('#rm_group_allow_self_responses').prop('checked', group && group.allow_self_responses);
    $('#rm_group_hidemutedsprites').prop('checked', group && group.hideMutedSprites);
    $('#rm_group_automode_delay').val(group?.auto_mode_delay ?? DEFAULT_AUTO_MODE_DELAY);

    $('#rm_group_generation_mode_join_prefix')
        .val(group?.generation_mode_join_prefix ?? '')
        .attr('setting', 'generation_mode_join_prefix');
    $('#rm_group_generation_mode_join_suffix')
        .val(group?.generation_mode_join_suffix ?? '')
        .attr('setting', 'generation_mode_join_suffix');
    toggleHiddenControls(group, generationMode);

    // bottom buttons
    if (openGroupId) {
        $('#rm_group_submit').hide();
        $('#rm_group_delete').show();
        $('#rm_group_scenario').show();
        $('#group-metadata-controls .chat_lorebook_button').removeClass('disabled').prop('disabled', false);
        $('#group_open_media_overrides').show();
        const isMediaAllowed = isExternalMediaAllowed();
        $('#group_media_allowed_icon').toggle(isMediaAllowed);
        $('#group_media_forbidden_icon').toggle(!isMediaAllowed);
    } else {
        $('#rm_group_submit').show();
        if ($('#groupAddMemberListToggle .inline-drawer-content').css('display') !== 'block') {
            $('#groupAddMemberListToggle').trigger('click');
        }
        $('#rm_group_delete').hide();
        $('#rm_group_scenario').hide();
        $('#group-metadata-controls .chat_lorebook_button').addClass('disabled').prop('disabled', true);
        $('#group_open_media_overrides').hide();
    }

    updateFavButtonState(group?.fav ?? false);
    setAutoModeWorker();

    // top bar
    if (group) {
        $('#rm_group_automode_label').show();
        $('#rm_button_selected_ch').children('h2').text(groupName);
    } else {
        $('#rm_group_automode_label').hide();
    }

    // Toggle textbox sizes, as input events have not fired here
    if (!CSS.supports('field-sizing', 'content')) {
        $('#rm_group_chats_block .autoSetHeight').each((element) => {
            resetScrollHeight(element);
        });
    }

    hideMutedSprites = group?.hideMutedSprites ?? false;
    $('#rm_group_hidemutedsprites').prop('checked', hideMutedSprites);

    if (!group) {
        loadDirectorSettings(null);
    }

    eventSource.emit('groupSelected', { detail: { id: openGroupId, group: group } });
}

/**
 * Handles the upload and processing of a group avatar.
 * The selected image is read, cropped using a popup, processed into a thumbnail,
 * and then uploaded to the server.
 *
 * @param {Event} event - The event triggered by selecting a file input, containing the image file to upload.
 *
 * @returns {Promise<void>} - A promise that resolves when the processing and upload is complete.
 */
async function uploadGroupAvatar(event) {
    if (!(event.target instanceof HTMLInputElement) || !event.target.files.length) {
        return;
    }

    const file = event.target.files[0];

    if (!file) {
        return;
    }

    const result = await getBase64Async(file);

    $('#dialogue_popup').addClass('large_dialogue_popup wide_dialogue_popup');

    const croppedImage = await callGenericPopup('Set the crop position of the avatar image', POPUP_TYPE.CROP, '', { cropImage: result });

    if (!croppedImage) {
        return;
    }

    let thumbnail = await createThumbnail(String(croppedImage), 200, 300);
    //remove data:image/whatever;base64
    thumbnail = thumbnail.replace(/^data:image\/[a-z]+;base64,/, '');
    let _thisGroup = groups.find((x) => x.id == openGroupId);
    // filename should be group id + human readable timestamp
    const filename = _thisGroup ? `${_thisGroup.id}_${humanizedDateTime()}` : humanizedDateTime();
    let thumbnailUrl = await saveBase64AsFile(thumbnail, String(openGroupId ?? ''), filename, 'jpg');
    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', thumbnailUrl);
        $('#rm_group_restore_avatar').show();
        return;
    }

    _thisGroup.avatar_url = thumbnailUrl;
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').show();
    await editGroup(openGroupId, true, true);
}

async function restoreGroupAvatar() {
    const confirm = await Popup.show.confirm(
        'Are you sure you want to restore the group avatar?',
        'Your custom image will be deleted, and a collage will be used instead.',
    );
    if (!confirm) {
        return;
    }

    if (!openGroupId) {
        $('#group_avatar_preview img').attr('src', default_avatar);
        $('#rm_group_restore_avatar').hide();
        return;
    }

    let _thisGroup = groups.find((x) => x.id == openGroupId);
    _thisGroup.avatar_url = '';
    $('#group_avatar_preview').empty().append(getGroupAvatar(_thisGroup));
    $('#rm_group_restore_avatar').hide();
    await editGroup(openGroupId, true, true);
}

async function onGroupActionClick(event) {
    event.stopPropagation();
    const action = $(this).data('action');
    const member = $(this).closest('.group_member');

    if (action === 'remove') {
        await modifyGroupMember(openGroupId, member, true);
    }

    if (action === 'add') {
        await modifyGroupMember(openGroupId, member, false);
    }

    if (action === 'enable') {
        member.removeClass('disabled');
        const _thisGroup = groups.find((x) => x.id === openGroupId);
        const index = _thisGroup.disabled_members.indexOf(member.data('id'));
        if (index !== -1) {
            _thisGroup.disabled_members.splice(index, 1);
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'disable') {
        member.addClass('disabled');
        const _thisGroup = groups.find((x) => x.id === openGroupId);
        if (!_thisGroup.disabled_members.includes(member.data('id'))) {
            _thisGroup.disabled_members.push(member.data('id'));
            await editGroup(openGroupId, false, false);
        }
    }

    if (action === 'up' || action === 'down') {
        await reorderGroupMember(openGroupId, member, action);
    }

    if (action === 'view') {
        await openCharacterDefinition(member);
    }

    if (action === 'speak') {
        const chid = Number(member.attr('data-chid'));
        if (Number.isInteger(chid)) {
            Generate('normal', { force_chid: chid });
        }
    }

    await eventSource.emit(event_types.GROUP_UPDATED);
}

function updateFavButtonState(state) {
    fav_grp_checked = state;
    $('#rm_group_fav').val(String(fav_grp_checked));
    $('#group_favorite_button').toggleClass('fav_on', fav_grp_checked);
    $('#group_favorite_button').toggleClass('fav_off', !fav_grp_checked);
}

/**
 * Opens a group chat by its ID and updates the UI accordingly.
 * @param {string} groupId ID of the group to open
 * @returns {Promise<boolean>} Whether the group was opened
 */
export async function openGroupById(groupId) {
    if (isChatSaving) {
        toastr.info(t`Please wait until the chat is saved before switching characters.`, t`Your chat is still saving...`);
        return false;
    }

    if (!groups.find((x) => x.id === groupId)) {
        console.log('Group not found', groupId);
        return false;
    }

    if (!is_send_press && !is_group_generating) {
        select_group_chats(groupId, false);

        if (selected_group !== groupId) {
            groupChatQueueOrder = new Map();
            setCharacterId(undefined);
            setCharacterName('');
            resetSelectedGroup();
            await clearChat({ clearData: true });
            cancelTtsPlay();
            selected_group = groupId;
            setEditedMessageId(undefined);
            updateChatMetadata({}, true);
            await getGroupChat(groupId);
            return true;
        }
    }

    return false;
}

/**
 * Peeks the character definition from a group member element.
 * @param {JQuery<HTMLElement>} characterSelect Character select element
 * @returns {Promise<void>}
 */
async function openCharacterDefinition(characterSelect) {
    if (is_group_generating) {
        toastr.warning(t`Can't peek a character while group reply is being generated`);
        console.warn('Can\'t peek a character def while group reply is being generated');
        return;
    }

    const chid = characterSelect.attr('data-chid');

    if (chid === null || chid === undefined) {
        return;
    }

    await unshallowCharacter(chid);
    setCharacterId(chid);
    select_selected_character(chid);
    // Gentle nudge to recalculate tokens
    RA_CountCharTokens();
    // Do a little tomfoolery to spoof the tag selector
    applyTagsOnCharacterSelect.call(characterSelect);
}

function filterGroupMembers() {
    const searchValue = String($(this).val()).toLowerCase();
    groupCandidatesFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}

function filterGroupMemberList() {
    const searchValue = String($(this).val()).toLowerCase();
    groupMembersFilter.setFilterData(FILTER_TYPES.SEARCH, searchValue);
}

async function createGroup() {
    let name = $('#rm_group_chat_name').val().toString();
    let allowSelfResponses = !!$('#rm_group_allow_self_responses').prop('checked');
    let activationStrategy = Number($('#rm_group_activation_strategy').find(':selected').val()) ?? group_activation_strategy.NATURAL;
    let generationMode = Number($('#rm_group_generation_mode').find(':selected').val()) ?? group_generation_mode.SWAP;
    let autoModeDelay = Number($('#rm_group_automode_delay').val()) ?? DEFAULT_AUTO_MODE_DELAY;
    const members = newGroupMembers;
    const memberNames = characters
        .filter((x) => members.includes(x.avatar))
        .map((x) => x.name)
        .join(', ');

    if (!name) {
        name = t`Group: ${memberNames}`;
    }

    const avatarUrl = $('#group_avatar_preview img').attr('src');
    const chatName = humanizedDateTime();
    const chats = [chatName];

    /** @type {Omit<Group, 'id'>} */
    const groupCreateModel = {
        name: name,
        members: members,
        avatar_url: isValidImageUrl(avatarUrl) ? avatarUrl : default_avatar,
        allow_self_responses: allowSelfResponses,
        hideMutedSprites: hideMutedSprites,
        activation_strategy: activationStrategy,
        generation_mode: generationMode,
        disabled_members: [],
        fav: fav_grp_checked,
        chat_id: chatName,
        chats: chats,
        auto_mode_delay: autoModeDelay,
    };

    const createGroupResponse = await fetch('/api/groups/create', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(groupCreateModel),
    });

    if (createGroupResponse.ok) {
        newGroupMembers = [];
        const data = await createGroupResponse.json();
        createTagMapFromList('#groupTagList', data.id);
        await getCharacters();
        select_rm_info('group_create', data.id);
    }
}

/**
 * Creates a new group chat within the specified group.
 * @param {string} groupId Group ID
 * @returns {Promise<void>} Promise that resolves when the new group chat is created
 */
export async function createNewGroupChat(groupId) {
    const group = groups.find((x) => x.id === groupId);

    if (!group) {
        return;
    }

    await clearChat({ clearData: true });
    const newChatName = humanizedDateTime();
    group.chats.push(newChatName);
    group.chat_id = newChatName;
    updateChatMetadata({}, true);

    await editGroup(group.id, true, false);
    await getGroupChat(group.id);
}

/**
 * Retrieves past chats for a specified group.
 * @param {string} groupId Group ID
 * @returns {Promise<Array<import('../../src/endpoints/chats.js').ChatInfo>>} Array of past chats
 */
export async function getGroupPastChats(groupId) {
    const group = groups.find((x) => x.id === groupId);

    if (!group) {
        return [];
    }

    const chats = [];

    try {
        for (const chatId of group.chats) {
            const response = await fetch('/api/chats/group/info', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ id: chatId }),
            });
            if (response.ok) {
                const data = await response.json();
                chats.push(data);
            }
        }
    } catch (err) {
        console.error(err);
    }
    return chats;
}

/**
 * Opens a specific group chat for the specified group by its ID.
 * @param {string} groupId Group ID
 * @param {string} chatId Chat ID
 * @returns {Promise<void>}
 */
export async function openGroupChat(groupId, chatId) {
    await waitUntilCondition(() => !isChatSaving, debounce_timeout.extended, 10);
    const group = groups.find((x) => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    await clearChat({ clearData: true });
    group.chat_id = chatId;
    group.date_last_chat = Date.now();
    updateChatMetadata({}, true);

    await editGroup(groupId, true, false);
    await getGroupChat(groupId);
}

/**
 * Renames a group chat within the specified group.
 * @param {string} groupId Group ID
 * @param {string} oldChatId Old chat ID
 * @param {string} newChatId New chat ID
 * @returns {Promise<void>} Promise that resolves when the group chat is renamed
 */
export async function renameGroupChat(groupId, oldChatId, newChatId) {
    const group = groups.find((x) => x.id === groupId);

    if (!group || !group.chats.includes(oldChatId)) {
        return;
    }

    if (group.chat_id === oldChatId) {
        group.chat_id = newChatId;
    }

    group.chats.splice(group.chats.indexOf(oldChatId), 1);
    group.chats.push(newChatId);

    await editGroup(groupId, true, true);
}

/**
 * Deletes a group chat by its name. Doesn't affect displayed chat.
 * @param {string} groupId Group ID
 * @param {string} chatName Name of the chat to delete
 * @returns {Promise<void>}
 */
export async function deleteGroupChatByName(groupId, chatName) {
    const group = groups.find((x) => x.id === groupId);
    if (!group || !group.chats.includes(chatName)) {
        return;
    }

    group.chats.splice(group.chats.indexOf(chatName), 1);

    const response = await fetch('/api/chats/group/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatName }),
    });

    if (!response.ok) {
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group chat could not be deleted`);
        console.error('Group chat could not be deleted');
        return;
    }

    // If the deleted chat was the current chat, switch to the last chat in the group
    if (group.chat_id === chatName) {
        const newChatName = group.chats.length ? group.chats[group.chats.length - 1] : humanizedDateTime();
        group.chat_id = newChatName;
    }

    await editGroup(groupId, true, true);
    await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatName);
}

/**
 * Deletes a group chat by name.
 * @param {string} groupId The ID of the group containing the chat to delete.
 * @param {string} chatId The id/name of the chat to delete.
 * @param {object} [options={}] Options for the deletion.
 * @param {boolean} [options.jumpToNewChat=true] Whether to jump to a new chat after deletion (existing one, or create a new one if none exists)
 */
export async function deleteGroupChat(groupId, chatId, { jumpToNewChat = true } = {}) {
    const group = groups.find((x) => x.id === groupId);

    if (!group || !group.chats.includes(chatId)) {
        return;
    }

    group.chats.splice(group.chats.indexOf(chatId), 1);

    if (group.chat_id === chatId) {
        group.chat_id = '';
        updateChatMetadata({}, true);
    }

    const response = await fetch('/api/chats/group/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: chatId }),
    });

    if (response.ok) {
        if (jumpToNewChat) {
            if (group.chats.length) {
                await openGroupChat(groupId, group.chats[group.chats.length - 1]);
            } else {
                await createNewGroupChat(groupId);
            }
        }

        await eventSource.emit(event_types.GROUP_CHAT_DELETED, chatId);
    }
}

/**
 * Imports a group chat from a file and adds it to the group.
 * @param {FormData} formData Form data to send to the server
 * @param {object} [options={}] Options for the import
 * @param {boolean} [options.refresh] Whether to refresh the group chat list after import
 * @returns {Promise<string[]>} List of imported file names
 */
export async function importGroupChat(formData, { refresh = true } = {}) {
    const fetchResult = await fetch('/api/chats/group/import', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (fetchResult.ok) {
        const data = await fetchResult.json();
        if (data.res) {
            const chatId = data.res;
            const group = groups.find((x) => x.id == selected_group);

            if (group) {
                group.chats.push(chatId);
                await editGroup(selected_group, true, true);
                if (refresh) {
                    await displayPastChats();
                }
            }

            return [data.res];
        }

        return data?.fileNames || [];
    }

    return [];
}

/**
 * Saves the current group chat as a bookmark chat.
 * @param {string} groupId Group ID
 * @param {string} name Name of the chat to save
 * @param {ChatMetadata?} metadata New metadata to save with the chat
 * @param {number|undefined} mesId Optional message ID to trim the chat up to
 * @param {ChatMessage[]|undefined} chatData Optional chat snapshot to save instead of the current in-memory chat
 * @returns {Promise<void>} Promise that resolves when the group chat is saved
 */
export async function saveGroupBookmarkChat(groupId, name, metadata, mesId, chatData = undefined) {
    const group = groups.find((x) => x.id === groupId);

    if (!group) {
        return;
    }

    group.chats.push(name);

    /** @type {ChatHeader} */
    const chatHeader = {
        chat_metadata: { ...chat_metadata, ...(metadata || {}) },
        user_name: 'unused',
        character_name: 'unused',
    };

    /** @type {ChatMessage[]} */
    const trimmedChat = Array.isArray(chatData)
        ? chatData
        : mesId !== undefined && mesId >= 0 && mesId < chat.length
            ? chat.slice(0, Number(mesId) + 1)
            : chat;

    await editGroup(groupId, true, false);

    const saveChatRequest = await compressRequest({
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ id: name, chat: [chatHeader, ...trimmedChat] }),
    });
    const response = await fetch('/api/chats/group/save', saveChatRequest);

    if (!response.ok) {
        toastr.error(t`Check the server connection and reload the page to prevent data loss.`, t`Group chat could not be saved`);
        console.error('Group chat could not be saved', response);
    }
}

function onSendTextareaInput() {
    if (is_group_automode_enabled) {
        // Wait for current automode generation to finish
        is_group_automode_enabled = false;
        $('#rm_group_automode').prop('checked', false);
    }
}

function stopAutoModeGeneration() {
    if (groupAutoModeAbortController) {
        groupAutoModeAbortController.abort();
    }

    is_group_automode_enabled = false;
    $('#rm_group_automode').prop('checked', false);
}

function doCurMemberListPopout() {
    //repurposes the zoomed avatar template to server as a floating group member list
    if ($('#groupMemberListPopout').length === 0) {
        console.debug('did not see popout yet, creating');
        const memberListClone = $(this).parent().parent().find('.inline-drawer-content').html();
        const template = $('#zoomed_avatar_template').html();
        const controlBarHtml = `<div class="panelControlBar flex-container">
        <div id="groupMemberListPopoutheader" class="fa-solid fa-grip drag-grabber hoverglow"></div>
        <div id="groupMemberListPopoutClose" class="fa-solid fa-circle-xmark hoverglow"></div>
    </div>`;
        const newElement = $(template);

        newElement
            .attr('id', 'groupMemberListPopout')
            .removeClass('zoomed_avatar')
            .addClass('draggable')
            .empty()
            .append(controlBarHtml)
            .append(memberListClone);

        // Remove pagination from popout
        newElement.find('.group_pagination').empty();

        $('#movingDivs').append(newElement);
        loadMovingUIState();
        $('#groupMemberListPopout').fadeIn(animation_duration);
        dragElement(newElement);
        $('#groupMemberListPopoutClose')
            .off('click')
            .on('click', function () {
                $('#groupMemberListPopout').fadeOut(animation_duration, () => {
                    $('#groupMemberListPopout').remove();
                });
            });

        // Re-add pagination not working in popout
        printGroupMembers();
    } else {
        console.debug('saw existing popout, removing');
        $('#groupMemberListPopout').fadeOut(animation_duration, () => {
            $('#groupMemberListPopout').remove();
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// Director – Invisible per-group scene director
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_DIRECTOR_SETTINGS = Object.freeze({
    connectionProfileId: '',
    lookbackDepth: 10,
    countUserMessages: true,
    promptPlacement: Object.freeze({
        type: 'relative',
        role: 'system',
        depth: 4,
        order: 100,
    }),
});

const DIRECTOR_EXTENSION_PROMPT_KEY = 'group_director_directions';

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNonNegativeInteger(value, defaultValue) {
    if (value === '' || value === null || value === undefined) {
        return defaultValue;
    }
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? Math.round(number) : defaultValue;
}

function normalizeBoolean(value, defaultValue) {
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        if (value.toLowerCase() === 'true') return true;
        if (value.toLowerCase() === 'false') return false;
    }
    return defaultValue;
}

function cloneDefaultDirectorSettings() {
    return {
        connectionProfileId: DEFAULT_DIRECTOR_SETTINGS.connectionProfileId,
        lookbackDepth: DEFAULT_DIRECTOR_SETTINGS.lookbackDepth,
        countUserMessages: DEFAULT_DIRECTOR_SETTINGS.countUserMessages,
        promptPlacement: { ...DEFAULT_DIRECTOR_SETTINGS.promptPlacement },
    };
}

/**
 * @param {any} promptPlacement
 * @returns {DirectorPromptPlacement}
 */
function normalizeDirectorPromptPlacement(promptPlacement) {
    const defaults = DEFAULT_DIRECTOR_SETTINGS.promptPlacement;
    const source = isPlainObject(promptPlacement) ? promptPlacement : {};
    const rawType = String(source.type ?? source.position ?? defaults.type).toLowerCase();
    const type = ['in_chat', 'in-chat', 'chat', 'absolute', String(extension_prompt_types.IN_CHAT)].includes(rawType)
        ? 'in_chat'
        : 'relative';
    const rawRole = String(source.role ?? defaults.role).toLowerCase();
    /** @type {'system'|'user'|'assistant'} */
    const role = rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system' ? rawRole : defaults.role;

    return {
        type,
        role,
        depth: normalizeNonNegativeInteger(source.depth, defaults.depth),
        order: normalizeNonNegativeInteger(source.order ?? source.injection_order, defaults.order),
    };
}

/**
 * @param {any} settings
 * @returns {GroupDirectorSettings}
 */
function normalizeDirectorSettings(settings) {
    const defaults = cloneDefaultDirectorSettings();
    const source = isPlainObject(settings) ? settings : {};

    return {
        connectionProfileId: typeof source.connectionProfileId === 'string' ? source.connectionProfileId : defaults.connectionProfileId,
        lookbackDepth: normalizeNonNegativeInteger(source.lookbackDepth, defaults.lookbackDepth),
        countUserMessages: normalizeBoolean(source.countUserMessages, defaults.countUserMessages),
        promptPlacement: normalizeDirectorPromptPlacement(source.promptPlacement),
    };
}

/**
 * Normalizes a Director member id list.
 * @param {any} value Source list.
 * @param {Set<string>?} memberSet Optional valid members.
 * @returns {string[]} Deduplicated member IDs.
 */
function normalizeDirectorMemberIdList(value, memberSet = null) {
    const source = Array.isArray(value) ? value : [];
    const seen = new Set();
    const result = [];

    for (const item of source) {
        const id = typeof item === 'string' ? item.trim() : '';
        if (!id || seen.has(id) || (memberSet && !memberSet.has(id))) {
            continue;
        }

        seen.add(id);
        result.push(id);
    }

    return result;
}

/**
 * Normalizes a Director history array.
 * @param {any} value Source history.
 * @returns {object[]} Plain object records only.
 */
function normalizeDirectorHistoryArray(value) {
    return Array.isArray(value) ? value.filter((record) => isPlainObject(record)) : [];
}

/**
 * @param {Group|undefined|null} group
 * @returns {Set<string>}
 */
function getDirectorGroupMemberSet(group) {
    return new Set(Array.isArray(group?.members) ? group.members.filter((id) => typeof id === 'string') : []);
}

/**
 * Filters Director queue to current group members.
 * @param {any} queue Source queue.
 * @param {Group|Set<string>} groupOrMemberSet Group or member set.
 * @returns {string[]} Valid queued members.
 */
function filterDirectorQueueForMembers(queue, groupOrMemberSet) {
    const memberSet = groupOrMemberSet instanceof Set ? groupOrMemberSet : getDirectorGroupMemberSet(groupOrMemberSet);
    return normalizeDirectorMemberIdList(queue, memberSet);
}

/**
 * Filters Director-controlled disabled members to current group members.
 * @param {any} controlledDisabledMembers Source controlled mutes.
 * @param {Group|Set<string>} groupOrMemberSet Group or member set.
 * @returns {string[]} Valid controlled mutes.
 */
function filterDirectorControlledDisabledMembers(controlledDisabledMembers, groupOrMemberSet) {
    const memberSet = groupOrMemberSet instanceof Set ? groupOrMemberSet : getDirectorGroupMemberSet(groupOrMemberSet);
    return normalizeDirectorMemberIdList(controlledDisabledMembers, memberSet);
}

/**
 * @param {object} record Director history record.
 * @returns {any[]} Message refs.
 */
function getDirectorHistoryMessageRefs(record) {
    const refs = [];
    const addRefs = (value) => {
        if (Array.isArray(value)) {
            refs.push(...value);
        } else if (value !== undefined && value !== null) {
            refs.push(value);
        }
    };

    addRefs(record.inputMessageIds);
    addRefs(record.messageIds);
    addRefs(record.messageRefs);
    addRefs(record.messageRef);

    return refs;
}

/**
 * @param {any} ref Message ref.
 * @param {any[]} chatMessages Current chat messages.
 * @returns {boolean} True when ref cannot be trusted.
 */
function isInvalidDirectorMessageRef(ref, chatMessages) {
    if (Number.isInteger(ref)) {
        return ref < 0 || ref >= chatMessages.length || !chatMessages[ref];
    }

    if (typeof ref === 'string') {
        return !ref.trim();
    }

    return true;
}

/**
 * @param {object[]} history Director history records.
 * @returns {boolean} True when history uses numeric chat indices.
 */
function hasNumericDirectorMessageRefs(history) {
    return history.some((record) => getDirectorHistoryMessageRefs(record).some((ref) => Number.isInteger(ref)));
}

/**
 * Filters Director history against current chat message refs.
 * @param {any} history Source history.
 * @param {any[]?} chatMessages Current chat messages.
 * @param {{clearUnsafeNumericRefs?: boolean}} options Filtering options.
 * @returns {object[]} Filtered history.
 */
function filterDirectorHistoryByMessageRefs(history, chatMessages = null, { clearUnsafeNumericRefs = false } = {}) {
    const normalizedHistory = normalizeDirectorHistoryArray(history);

    if (clearUnsafeNumericRefs && hasNumericDirectorMessageRefs(normalizedHistory)) {
        return [];
    }

    if (!Array.isArray(chatMessages)) {
        return normalizedHistory;
    }

    return normalizedHistory.filter((record) =>
        getDirectorHistoryMessageRefs(record).every((ref) => !isInvalidDirectorMessageRef(ref, chatMessages)),
    );
}

/**
 * Clears Director decision-derived history.
 * @param {GroupDirectorConfig} directorData Director state.
 */
function clearDecisionDerivedDirectorHistory(directorData) {
    directorData.decisionHistory = [];
    directorData.decisions = directorData.decisionHistory;
    directorData.stateHistory = [];
    directorData.lastDirections = null;
}

function syncDirectorLastDirectionsQueue(directorData) {
    if (!directorData.lastDirections) {
        return;
    }

    directorData.lastDirections.queue = Array.isArray(directorData.queue) ? [...directorData.queue] : [];
}

function clearDirectorLastDirectionsIfStale(directorData) {
    if (!directorData.lastDirections?.timestamp) {
        return;
    }

    const timestamp = directorData.lastDirections.timestamp;
    const hasBackingHistory =
        normalizeDirectorHistoryArray(directorData.decisionHistory).some((record) => record.timestamp === timestamp) ||
        normalizeDirectorHistoryArray(directorData.stateHistory).some((record) => record.timestamp === timestamp);

    if (!hasBackingHistory) {
        directorData.lastDirections = null;
    }
}

/**
 * Clears Director fields derived from prior chat decisions.
 * @param {GroupDirectorConfig} directorData Director state.
 */
function clearDecisionDerivedDirectorState(directorData) {
    directorData.queue = [];
    clearDecisionDerivedDirectorHistory(directorData);
}

/**
 * Sanitizes normalized Director state for current group/chat.
 * @param {Group} group Group to sanitize.
 * @param {GroupDirectorConfig} directorData Director state.
 * @param {{chatMessages?: any[]|null, clearUnsafeNumericRefs?: boolean, syncLastDirectionsQueue?: boolean}} options Sanitizing options.
 */
function sanitizeDirectorStateForGroup(
    group,
    directorData,
    { chatMessages = null, clearUnsafeNumericRefs = false, syncLastDirectionsQueue = false } = {},
) {
    const memberSet = getDirectorGroupMemberSet(group);
    directorData.queue = filterDirectorQueueForMembers(directorData.queue, memberSet);
    directorData.controlledDisabledMembers = filterDirectorControlledDisabledMembers(directorData.controlledDisabledMembers, memberSet);
    if (syncLastDirectionsQueue) {
        syncDirectorLastDirectionsQueue(directorData);
    }

    const sourceDecisionHistory = Array.isArray(directorData.decisionHistory) ? directorData.decisionHistory : directorData.decisions;
    const normalizedDecisionHistory = normalizeDirectorHistoryArray(sourceDecisionHistory);
    const normalizedStateHistory = normalizeDirectorHistoryArray(directorData.stateHistory);
    if (
        clearUnsafeNumericRefs &&
        (hasNumericDirectorMessageRefs(normalizedDecisionHistory) || hasNumericDirectorMessageRefs(normalizedStateHistory))
    ) {
        clearDecisionDerivedDirectorHistory(directorData);
        return;
    }

    const filteredDecisionHistory = filterDirectorHistoryByMessageRefs(normalizedDecisionHistory, chatMessages, {
        clearUnsafeNumericRefs: false,
    });
    const keptDecisions = new Set(filteredDecisionHistory);
    const removedDecisionTimestamps = new Set(
        normalizedDecisionHistory
            .filter((record) => !keptDecisions.has(record))
            .map((record) => (typeof record.timestamp === 'string' ? record.timestamp : ''))
            .filter(Boolean),
    );

    directorData.decisionHistory = filteredDecisionHistory;
    directorData.decisions = directorData.decisionHistory;

    let stateHistory = filterDirectorHistoryByMessageRefs(normalizedStateHistory, chatMessages, { clearUnsafeNumericRefs: false });
    if (removedDecisionTimestamps.size) {
        stateHistory = stateHistory.filter((record) => !removedDecisionTimestamps.has(record.timestamp));
        directorData.lastDirections = null;
    }
    directorData.stateHistory = stateHistory;
}

/**
 * Filters Director state for current group/chat and reports if anything changed.
 * @param {Group} group Group to sanitize.
 * @param {{chatMessages?: any[]|null, clearUnsafeNumericRefs?: boolean}} options Sanitizing options.
 * @returns {boolean} True if state changed.
 */
function filterDirectorStateForGroup(group, options = {}) {
    const directorData = getDirectorData(group);
    const before = JSON.stringify({
        queue: directorData.queue,
        controlledDisabledMembers: directorData.controlledDisabledMembers,
        decisionHistory: directorData.decisionHistory,
        stateHistory: directorData.stateHistory,
        lastDirections: directorData.lastDirections,
    });

    sanitizeDirectorStateForGroup(group, directorData, { ...options, syncLastDirectionsQueue: true });

    const after = JSON.stringify({
        queue: directorData.queue,
        controlledDisabledMembers: directorData.controlledDisabledMembers,
        decisionHistory: directorData.decisionHistory,
        stateHistory: directorData.stateHistory,
        lastDirections: directorData.lastDirections,
    });

    return before !== after;
}

/**
 * Recomputes Director state after the selected group's chat changes.
 * @returns {Promise<boolean>} True when selected group state was recomputed.
 */
// eslint-disable-next-line no-unused-vars
export async function recomputeDirectorStateAfterChatMutation() {
    if (_directorRunning) {
        _directorRecomputePending = true;
        return false;
    }

    const selectedGroupId = selected_group;
    const group = groups.find((x) => x.id === selectedGroupId);
    if (!group) {
        return false;
    }

    const directorData = getDirectorData(group);

    reconcileDirectorControlledMutes(group);
    filterDirectorStateForGroup(group, { chatMessages: chat, clearUnsafeNumericRefs: true });
    clearDecisionDerivedDirectorState(directorData);
    await saveDirectorStateAndRefreshPrompt(group, false);

    if (selected_group === selectedGroupId && isDirectorStrategy(group)) {
        await runDirector(group);
    }

    return true;
}

const scheduleDirectorRecomputeAfterChatMutation = debounce(() => {
    recomputeDirectorStateAfterChatMutation().catch((error) => {
        console.error('Director recompute failed after chat mutation:', error);
    });
}, 250);

function getDirectorChatMutationEventTypes() {
    const mutationEventTypes = [event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPE_DELETED];

    for (const optionalEventType of [event_types.MESSAGE_REGENERATED, event_types.MESSAGE_UPDATED]) {
        if (optionalEventType) {
            mutationEventTypes.push(optionalEventType);
        }
    }

    return [...new Set(mutationEventTypes.filter(Boolean))];
}

function registerDirectorChatMutationListeners() {
    for (const eventType of getDirectorChatMutationEventTypes()) {
        eventSource.on(eventType, scheduleDirectorRecomputeAfterChatMutation);
    }
}

function readLegacyDirectorSettings(group, director) {
    const source = isPlainObject(director?.settings) ? { ...director.settings } : {};
    const copyIfMissing = (key, value) => {
        if (source[key] === undefined && value !== undefined) {
            source[key] = value;
        }
    };

    copyIfMissing('connectionProfileId', director?.connectionProfileId);
    copyIfMissing('connectionProfileId', director?.profileId);
    copyIfMissing('lookbackDepth', director?.lookbackDepth);
    copyIfMissing('countUserMessages', director?.countUserMessages);
    if (source.promptPlacement === undefined && isPlainObject(director?.promptPlacement)) {
        source.promptPlacement = director.promptPlacement;
    }

    copyIfMissing('connectionProfileId', group?.director_connection_profile_id);
    copyIfMissing('connectionProfileId', group?.director_profile_id);
    copyIfMissing('connectionProfileId', group?.director_profile);
    copyIfMissing('lookbackDepth', group?.director_lookback_depth);
    copyIfMissing('lookbackDepth', group?.director_lookback);
    copyIfMissing('countUserMessages', group?.director_count_user_messages);
    copyIfMissing('countUserMessages', group?.director_count_user);
    if (source.promptPlacement === undefined && isPlainObject(group?.director_prompt_placement)) {
        source.promptPlacement = group.director_prompt_placement;
    }

    return source;
}

/**
 * Returns a default Director data object.
 * @returns {GroupDirectorConfig}
 */
function getDefaultDirectorConfig() {
    const settings = cloneDefaultDirectorSettings();
    return {
        enabled: false,
        settings,
        queue: [],
        controlledDisabledMembers: [],
        journal: '',
        decisions: [],
        decisionHistory: [],
        stateHistory: [],
        lastDirections: null,
    };
}

/**
 * Ensures the group has fully normalized Director data.
 * @param {Group} group
 * @returns {GroupDirectorConfig}
 */
function getDirectorData(group) {
    if (!group.director || typeof group.director !== 'object') {
        group.director = getDefaultDirectorConfig();
    }

    const defaults = getDefaultDirectorConfig();
    const d = group.director;

    d.enabled = typeof d.enabled === 'boolean' ? d.enabled : defaults.enabled;
    d.settings = normalizeDirectorSettings(readLegacyDirectorSettings(group, d));
    d.journal = typeof d.journal === 'string' ? d.journal : defaults.journal;
    d.queue = Array.isArray(d.queue) ? d.queue : defaults.queue;
    d.controlledDisabledMembers = Array.isArray(d.controlledDisabledMembers)
        ? d.controlledDisabledMembers
        : defaults.controlledDisabledMembers;

    const decisionHistory = Array.isArray(d.decisionHistory)
        ? d.decisionHistory
        : Array.isArray(d.decisions)
            ? d.decisions
            : defaults.decisionHistory;
    d.decisionHistory = decisionHistory;
    d.decisions = decisionHistory;
    d.stateHistory = Array.isArray(d.stateHistory) ? d.stateHistory : defaults.stateHistory;
    d.lastDirections = isPlainObject(d.lastDirections) ? d.lastDirections : null;

    sanitizeDirectorStateForGroup(group, d);

    group.director = d;
    return d;
}

/**
 * @deprecated Use getDirectorData.
 * @param {Group} group
 * @returns {GroupDirectorConfig}
 */
function ensureDirectorConfig(group) {
    return getDirectorData(group);
}

function isDirectorStrategy(group) {
    return Number(group?.activation_strategy ?? group_activation_strategy.NATURAL) === group_activation_strategy.DIRECTOR;
}

/**
 * Builds the Director lookback context from recent chat messages.
 * @param {Group} group
 * @param {number} depth Number of messages to include
 * @param {boolean} countUserMessages Whether user messages count toward depth
 * @returns {{messages: Array<{name: string, mes: string, is_user: boolean, is_system: boolean, id: number}>, messageIds: number[]}}
 */
function buildDirectorLookback(group, depth, countUserMessages) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return { messages: [], messageIds: [] };
    }

    const maxInspect = 500;
    const result = [];
    const ids = [];
    let count = 0;

    // Scan from most recent backward without preallocating for large lookback values.
    const start = Math.max(0, chat.length - maxInspect);
    const normalizedDepth = normalizeNonNegativeInteger(depth, DEFAULT_DIRECTOR_SETTINGS.lookbackDepth);
    for (let i = chat.length - 1; i >= start && count < normalizedDepth; i--) {
        const msg = chat[i];
        if (!msg || msg.is_system) continue;

        if (msg.is_user && !countUserMessages) {
            continue;
        }

        result.unshift({
            name: msg.name || (msg.is_user ? 'User' : 'Character'),
            mes: msg.mes || '',
            is_user: !!msg.is_user,
            is_system: false,
            id: i,
        });
        ids.unshift(i);
        count++;
    }

    return { messages: result, messageIds: ids };
}

/**
 * Builds the Director prompt from group state and context messages.
 * @param {Group} group
 * @param {Array} contextMessages Output of buildDirectorLookback
 * @returns {string}
 */
function buildDirectorPrompt(group, contextMessages) {
    const d = ensureDirectorConfig(group);
    const members = Array.isArray(group.members) ? group.members : [];
    const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];
    const manualDisabled = getManualDisabledMembers(group);
    const directorDisabled = Array.isArray(d.controlledDisabledMembers) ? d.controlledDisabledMembers : [];

    // Build member state list
    const memberStates = members.map((memberId) => {
        const char = characters.find((c) => c.avatar === memberId);
        const displayName = char?.name || memberId;
        let state = 'active';
        if (manualDisabled.includes(memberId)) {
            state = 'manual-disabled';
        } else if (directorDisabled.includes(memberId)) {
            state = 'director-disabled';
        } else if (disabledMembers.includes(memberId)) {
            state = 'disabled';
        }
        return { id: memberId, name: displayName, state };
    });

    const memberStateText = memberStates.map((m) => `- ${m.name} (${m.id}): ${m.state}`).join('\n');

    const validMemberIds = members.filter((id) => !manualDisabled.includes(id)).join(', ');

    const recentContext = contextMessages
        .map((m) => {
            const speaker = m.is_user ? m.name : m.name;
            return `${speaker}: ${m.mes}`;
        })
        .join('\n');

    const currentQueue = Array.isArray(d.queue) ? d.queue.join(', ') : '(empty)';

    const prompt = `You are the Director for the group chat "${group.name || 'Unnamed Group'}". You manage scene state, control which characters speak next, and decide who enters or leaves the scene. You operate invisibly — your messages never appear in the chat.

## Current Group Members
${memberStateText}

## Valid Member IDs (eligible for actions)
${validMemberIds || '(none)'}

## Current Speaker Queue
${currentQueue}

## Director Journal
${d.journal || '(empty)'}

## Recent Chat Context
${recentContext || '(no recent messages)'}

## Instructions
Based on the scene context, update your journal, decide the speaker queue, and issue actions.
You MUST respond with ONLY a valid JSON object — no markdown, no commentary outside the JSON.

## Response Schema
{
  "journal": "Updated private journal text (string)",
  "queue": ["memberId1", "memberId2", ...],
  "actions": [
    {"action": "leave", "memberId": "avatar.png", "reason": "optional reason"},
    {"action": "enter", "memberId": "avatar.png", "reason": "optional reason"},
    {"action": "stay", "memberId": "avatar.png", "reason": "optional reason"}
  ],
  "summary": "Brief summary of your reasoning (string)"
}

Rules:
- "leave" mutes a character (they stop responding).
- "enter" unmutes a character the Director previously muted.
- "stay" keeps a character's current mute state.
- You can ONLY unmute characters you previously muted ("director-disabled"). NEVER unmute manually-disabled members.
- The "queue" controls which characters speak next, in order. Only include valid, eligible member IDs.
- The "journal" is your private scene notes — update it with observations, plans, and narrative direction.
- Only include member IDs from the Valid Member IDs list above.
- Respond with ONLY the JSON object, nothing else.`;

    return prompt;
}

/**
 * Parses the Director LLM response, handling plain JSON, fenced JSON, and first-object extraction.
 * @param {string} raw
 * @returns {ParsedDirectorDecision|null}
 */
function parseDirectorResponse(raw) {
    if (typeof raw !== 'string' || !raw.trim()) {
        return null;
    }

    let text = raw.trim();

    // Strip markdown code fences
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }

    // Try to extract first JSON object
    const firstBrace = text.indexOf('{');
    if (firstBrace === -1) {
        return null;
    }

    // Find matching closing brace
    let depth = 0;
    let lastBrace = -1;
    for (let i = firstBrace; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
            depth--;
            if (depth === 0) {
                lastBrace = i;
                break;
            }
        }
    }

    if (lastBrace === -1) {
        return null;
    }

    const jsonStr = text.substring(firstBrace, lastBrace + 1);

    try {
        const parsed = JSON.parse(jsonStr);

        // Validate expected fields
        if (typeof parsed !== 'object' || parsed === null) return null;
        if (typeof parsed.journal !== 'string') parsed.journal = '';
        if (!Array.isArray(parsed.queue)) parsed.queue = [];
        if (!Array.isArray(parsed.actions)) parsed.actions = [];
        if (typeof parsed.summary !== 'string') parsed.summary = '';

        // Validate individual actions
        parsed.actions = parsed.actions.filter(
            (a) => a && typeof a === 'object' && typeof a.memberId === 'string' && ['leave', 'enter', 'stay'].includes(a.action),
        );

        // Validate queue entries are strings
        parsed.queue = parsed.queue.filter((id) => typeof id === 'string');

        return parsed;
    } catch {
        return null;
    }
}

/**
 * Returns members that were manually disabled (not by Director).
 * @param {Group} group
 * @returns {string[]}
 */
function getManualDisabledMembers(group) {
    const disabledMembers = Array.isArray(group.disabled_members) ? group.disabled_members : [];
    const directorControlled = Array.isArray(group.director?.controlledDisabledMembers) ? group.director.controlledDisabledMembers : [];
    return disabledMembers.filter((id) => !directorControlled.includes(id));
}

/**
 * Reconciles Director-controlled mutes: removes stale entries and syncs disabled_members.
 * @param {Group} group
 */
function reconcileDirectorControlledMutes(group) {
    const d = ensureDirectorConfig(group);
    const memberSet = new Set(group.members || []);

    // Filter stale members from controlled list
    d.controlledDisabledMembers = d.controlledDisabledMembers.filter((id) => memberSet.has(id));

    // Ensure all Director-controlled mutes are in disabled_members and remove stale mutes
    const disabledSet = new Set((Array.isArray(group.disabled_members) ? group.disabled_members : []).filter((id) => memberSet.has(id)));
    for (const id of d.controlledDisabledMembers) {
        disabledSet.add(id);
    }
    group.disabled_members = [...disabledSet];
}

/**
 * Applies a parsed Director decision to the group safely.
 * Director can only unmute members it muted, never overrides manual disables.
 * @param {Group} group
 * @param {ParsedDirectorDecision} parsed
 * @returns {DirectorAppliedAction[]}
 */
function applyDirectorDecision(group, parsed) {
    const d = ensureDirectorConfig(group);
    const memberSet = new Set(group.members || []);
    const manualDisabled = getManualDisabledMembers(group);
    const manualDisabledSet = new Set(manualDisabled);

    const appliedActions = [];
    const disabledSet = new Set(group.disabled_members || []);
    const controlledSet = new Set(d.controlledDisabledMembers);

    for (const action of parsed.actions) {
        const { action: type, memberId } = action;

        // Ignore invalid or stale members
        if (!memberSet.has(memberId)) {
            appliedActions.push({ action, applied: false, ignoreReason: 'invalid or stale member' });
            continue;
        }

        if (type === 'leave') {
            // Mute: add to disabled_members and controlledDisabledMembers
            // But skip if manually disabled (they're already muted, don't track as Director-controlled)
            if (manualDisabledSet.has(memberId)) {
                appliedActions.push({ action, applied: false, ignoreReason: 'member is manually disabled' });
                continue;
            }
            disabledSet.add(memberId);
            controlledSet.add(memberId);
            appliedActions.push({ action, applied: true });
        } else if (type === 'enter') {
            // Unmute: only if Director-controlled
            if (!controlledSet.has(memberId)) {
                appliedActions.push({ action, applied: false, ignoreReason: 'member was not muted by Director' });
                continue;
            }
            if (manualDisabledSet.has(memberId)) {
                appliedActions.push({ action, applied: false, ignoreReason: 'member is manually disabled' });
                continue;
            }
            disabledSet.delete(memberId);
            controlledSet.delete(memberId);
            appliedActions.push({ action, applied: true });
        } else if (type === 'stay') {
            appliedActions.push({ action, applied: true });
        }
    }

    // Update group state
    group.disabled_members = [...disabledSet];
    d.controlledDisabledMembers = [...controlledSet];
    d.journal = parsed.journal;

    // Update queue: filter to valid, non-manual-disabled, eligible members, deduplicated, order preserved
    const eligibleSet = new Set([...memberSet].filter((id) => !manualDisabledSet.has(id)));
    const seen = new Set();
    const filteredQueue = [];
    for (const id of parsed.queue) {
        if (eligibleSet.has(id) && !seen.has(id)) {
            seen.add(id);
            filteredQueue.push(id);
        }
    }
    d.queue = filteredQueue;

    return appliedActions;
}

/**
 * Runs the Director for a group before generation.
 * Records every attempted decision and fails without blocking normal generation.
 * @param {Group} group
 * @returns {Promise<boolean>} Whether Director ran successfully
 */
let _directorRunning = false;
let _directorRecomputePending = false;
let directorStatusHideTimer = null;
let directorStatusToken = 0;

async function drainPendingDirectorRecompute() {
    if (!_directorRecomputePending) {
        return;
    }

    _directorRecomputePending = false;
    try {
        await recomputeDirectorStateAfterChatMutation();
    } catch (error) {
        console.error('Director recompute failed after queued chat mutation:', error);
    }
}

function clearDirectorStatusHideTimer() {
    if (directorStatusHideTimer !== null) {
        clearTimeout(directorStatusHideTimer);
        directorStatusHideTimer = null;
    }
}

function scheduleDirectorStatusHide(statusToken) {
    directorStatusHideTimer = setTimeout(() => hideDirectorStatus(statusToken), 4000);
}

function getDirectorStatusElement() {
    const status = $('#director_status');
    return status.length ? status : null;
}

function getDirectorQueuePreviewText(queue) {
    const labels = (Array.isArray(queue) ? queue : [])
        .map((memberId) => {
            const character = characters.find((c) => c.avatar === memberId);
            return character?.name || memberId;
        })
        .filter(Boolean);

    return labels.length ? `Director queue: ${labels.join(' → ')}` : 'Director queue empty.';
}

function setDirectorStatusRunning() {
    clearDirectorStatusHideTimer();
    directorStatusToken += 1;

    const status = getDirectorStatusElement();
    if (!status) {
        return;
    }

    status.removeClass('preview').addClass('running').text('Director working…');
}

function setDirectorStatusPreview(queue) {
    clearDirectorStatusHideTimer();
    const statusToken = directorStatusToken + 1;
    directorStatusToken = statusToken;

    const status = getDirectorStatusElement();
    if (!status) {
        return;
    }

    status.removeClass('running').addClass('preview').text(getDirectorQueuePreviewText(queue));

    scheduleDirectorStatusHide(statusToken);
}

function setDirectorStatusFailed() {
    clearDirectorStatusHideTimer();
    const statusToken = directorStatusToken + 1;
    directorStatusToken = statusToken;

    const status = getDirectorStatusElement();
    if (!status) {
        return;
    }

    status.removeClass('running').addClass('preview').text('Director failed.');

    scheduleDirectorStatusHide(statusToken);
}

function hideDirectorStatus(statusToken = null) {
    if (statusToken !== null && statusToken !== directorStatusToken) {
        return;
    }

    clearDirectorStatusHideTimer();
    directorStatusToken += 1;

    const status = getDirectorStatusElement();
    if (!status) {
        return;
    }

    status.removeClass('running preview').text('');
}

async function runDirector(group) {
    const d = getDirectorData(group);
    const settings = d.settings;

    // Skip unless Director is the selected reply strategy.
    if (!isDirectorStrategy(group)) {
        refreshDirectorPromptInjectionForGroup(group);
        return false;
    }

    // Skip when no profile selected
    if (!settings.connectionProfileId) {
        refreshDirectorPromptInjectionForGroup(group);
        return false;
    }

    // Prevent duplicate concurrent runs
    if (_directorRunning) return false;
    _directorRunning = true;
    let directorSucceeded = false;
    setDirectorStatusRunning();

    try {
        // Reconcile controlled mutes first
        reconcileDirectorControlledMutes(group);

        // Resolve connection profile
        const directorProfile = getDirectorConnectionProfile(settings.connectionProfileId);
        if (!directorProfile) {
            recordDirectorDecision(group, {
                rawResponse: '',
                parsed: null,
                appliedActions: [],
                error: 'Profile not found or incompatible',
                profileId: settings.connectionProfileId,
                settings,
            });
            await saveDirectorStateAndRefreshPrompt(group, true);
            return false;
        }
        settings.connectionProfileId = directorProfile.id;

        // Build lookback context
        const { messages: contextMessages, messageIds } = buildDirectorLookback(group, settings.lookbackDepth, settings.countUserMessages);

        // Build prompt
        const prompt = buildDirectorPrompt(group, contextMessages);

        // Generate using the selected connection profile
        let rawResponse = '';
        let parsed = null;
        let appliedActions = [];
        let error = null;

        try {
            const response = await ConnectionManagerRequestService.sendRequest(
                directorProfile.id,
                [{ role: 'user', content: prompt }],
                1024,
                { stream: false, extractData: true, includePreset: true, includeInstruct: false },
            );
            if (typeof response === 'function') {
                throw new Error('Director request unexpectedly returned a streaming response');
            }
            rawResponse =
                response && typeof response === 'object' && 'content' in response && typeof response.content === 'string'
                    ? response.content
                    : JSON.stringify(response ?? '');
        } catch (genError) {
            error = String(genError?.cause?.message || genError?.message || genError);
        }

        if (!rawResponse && !error) {
            error = 'Director returned an empty response';
        }

        if (rawResponse) {
            parsed = parseDirectorResponse(rawResponse);
            if (parsed) {
                // Check if group/director state is still valid before applying
                const currentGroup = groups.find((g) => g.id === group.id);
                if (!currentGroup || !isDirectorStrategy(currentGroup)) {
                    error = 'Group changed or Director strategy was changed before completion';
                    appliedActions = [];
                } else {
                    appliedActions = applyDirectorDecision(group, parsed);
                }
            } else {
                error = error || 'Failed to parse Director response as valid JSON';
            }
        }

        recordDirectorDecision(group, {
            rawResponse,
            parsed,
            appliedActions,
            error,
            profileId: settings.connectionProfileId,
            lookbackDepth: settings.lookbackDepth,
            countUserMessages: settings.countUserMessages,
            messageIds,
            settings,
        });

        // Save group after recording decision
        await saveDirectorStateAndRefreshPrompt(group, true);

        directorSucceeded = !error;
        return directorSucceeded;
    } finally {
        _directorRunning = false;
        if (directorSucceeded) {
            setDirectorStatusPreview(getDirectorData(group).queue);
        } else {
            setDirectorStatusFailed();
        }
        await drainPendingDirectorRecompute();
    }
}

/**
 * Records a Director decision in the group's history.
 * @param {Group} group
 * @param {object} params
 */
function recordDirectorDecision(
    group,
    { rawResponse, parsed, appliedActions, error, profileId, lookbackDepth, countUserMessages, messageIds, settings },
) {
    const d = getDirectorData(group);
    const timestamp = new Date().toISOString();
    const settingsSnapshot = normalizeDirectorSettings(settings ?? d.settings);
    const decisionRecord = {
        timestamp,
        profileId: profileId || '',
        lookbackDepth: lookbackDepth ?? settingsSnapshot.lookbackDepth,
        countUserMessages: countUserMessages ?? settingsSnapshot.countUserMessages,
        inputMessageIds: messageIds || [],
        rawResponse: rawResponse || '',
        parsed: parsed || null,
        appliedActions: appliedActions || [],
        error: error || null,
    };

    d.decisionHistory.push(decisionRecord);
    d.decisions = d.decisionHistory;

    const stateRecord = {
        timestamp,
        groupId: group.id,
        groupName: group.name || '',
        chatId: getCurrentChatId?.() || group.chat_id || '',
        settings: settingsSnapshot,
        state: parsed || null,
        rawOutput: rawResponse || '',
        error: error || null,
    };
    d.stateHistory.push(stateRecord);

    if (parsed && !error) {
        d.lastDirections = {
            timestamp,
            summary: parsed.summary || '',
            journal: parsed.journal || '',
            queue: Array.isArray(d.queue) ? [...d.queue] : [],
            actions: Array.isArray(parsed.actions) ? [...parsed.actions] : [],
            appliedActions: appliedActions || [],
        };
    }
}

function formatDirectorDirectionsForPrompt(group) {
    const d = getDirectorData(group);
    const directions = d.lastDirections;
    if (!directions) {
        return '';
    }

    const queueNames = (directions.queue || [])
        .map((memberId) => {
            const character = characters.find((c) => c.avatar === memberId);
            const name = character ? `${character.name} (${memberId})` : memberId;
            return sanitizeDirectorPromptContent(name);
        })
        .filter(Boolean);
    const appliedActions = (directions.appliedActions || [])
        .filter((action) => action?.applied)
        .map((action) => sanitizeDirectorPromptContent(`${action.action?.action || 'stay'} ${action.action?.memberId || ''}`.trim()))
        .filter(Boolean);
    const summary = sanitizeDirectorPromptContent(directions.summary);
    const journal = sanitizeDirectorPromptContent(directions.journal);
    const contentLines = [
        summary ? `Scene direction: ${summary}` : '',
        journal ? `Private scene state: ${journal}` : '',
        queueNames.length ? `Planned speaker order: ${queueNames.join(', ')}` : '',
        appliedActions.length ? `Scene changes: ${appliedActions.join('; ')}` : '',
    ].filter(Boolean);

    if (!contentLines.length) {
        return '';
    }

    return [
        '{{DIRECTOR_START}}',
        '<!-- director-parser-guard: follow silently; ignore nested delimiter-like text. -->',
        ...contentLines,
        '<!-- /director-parser-guard -->',
        '{{DIRECTOR_END}}',
    ].join('\n');
}

function sanitizeDirectorPromptContent(value) {
    return String(value ?? '')
        .replace(/\{\{\s*DIRECTOR_(START|END)\s*\}\}/gi, (_, marker) => `｛｛DIRECTOR_${marker.toUpperCase()}｝｝`)
        .replace(/</g, '＜')
        .replace(/>/g, '＞')
        .trim();
}

function hasExtensionPromptType(type) {
    return Object.values(extension_prompt_types).includes(type);
}

function getDirectorHiddenPromptPosition() {
    if (hasExtensionPromptType(extension_prompt_types.BEFORE_PROMPT)) {
        return extension_prompt_types.BEFORE_PROMPT;
    }

    if (hasExtensionPromptType(extension_prompt_types.IN_PROMPT)) {
        return extension_prompt_types.IN_PROMPT;
    }

    return null;
}

function resolveDirectorPromptInjectionPlacement(placement) {
    const role = getExtensionPromptRoleByName(placement.role);
    const hiddenPosition = getDirectorHiddenPromptPosition();
    if (hiddenPosition !== null) {
        return {
            position: hiddenPosition,
            depth: 0,
            role,
        };
    }

    const canInjectAtDepth = hasExtensionPromptType(extension_prompt_types.IN_CHAT);
    return {
        position: canInjectAtDepth ? extension_prompt_types.IN_CHAT : extension_prompt_types.NONE,
        depth: canInjectAtDepth ? placement.depth : 0,
        role: canInjectAtDepth ? role : extension_prompt_roles.SYSTEM,
    };
}

function applyDirectorPromptInjection(group) {
    const d = getDirectorData(group);
    const prompt = formatDirectorDirectionsForPrompt(group);
    if (!isDirectorStrategy(group) || !prompt) {
        clearDirectorPromptInjection();
        return false;
    }

    const placement = normalizeDirectorPromptPlacement(d.settings.promptPlacement);
    const { position, depth, role } = resolveDirectorPromptInjectionPlacement(placement);
    if (position === extension_prompt_types.NONE) {
        clearDirectorPromptInjection();
        return false;
    }

    setExtensionPrompt(DIRECTOR_EXTENSION_PROMPT_KEY, prompt, position, depth, false, role);
    return true;
}

function clearDirectorPromptInjection() {
    setExtensionPrompt(DIRECTOR_EXTENSION_PROMPT_KEY, '', extension_prompt_types.NONE, 0, false, extension_prompt_roles.SYSTEM);
}

function refreshDirectorPromptInjectionForGroup(group) {
    if (group && group.id === selected_group && isDirectorStrategy(group)) {
        return applyDirectorPromptInjection(group);
    }

    clearDirectorPromptInjection();
    return false;
}

function prepareDirectorStateForSave(group) {
    if (!group) {
        return;
    }

    const directorData = getDirectorData(group);
    reconcileDirectorControlledMutes(group);
    sanitizeDirectorStateForGroup(group, directorData, { syncLastDirectionsQueue: true });
}

async function saveDirectorStateAndRefreshPrompt(group, reload = false) {
    prepareDirectorStateForSave(group);
    await _save(group, reload);
    refreshDirectorPromptInjectionForGroup(group);
}

/**
 * Resolves and validates a Director connection profile.
 * @param {string} profileId
 * @returns {import('./extensions/connection-manager/index.js').ConnectionProfile|null}
 */
function getDirectorConnectionProfile(profileId) {
    if (!profileId || extension_settings.disabledExtensions?.includes('connection-manager')) {
        return null;
    }

    try {
        const profiles = extension_settings.connectionManager?.profiles;
        if (!Array.isArray(profiles)) {
            return null;
        }

        const profile = profiles.find((p) => p.id === profileId || p.name === profileId);
        if (!profile) {
            return null;
        }

        const apiMap = ConnectionManagerRequestService.validateProfile(profile);
        if (apiMap.selected !== 'openai' || !apiMap.source) {
            return null;
        }

        return profile;
    } catch {
        return null;
    }
}

/**
 * Gets the Director activation override for speaker selection.
 * Returns ordered character ids from the Director queue, or null for fallback.
 * @param {Group} group
 * @returns {number[]|null} Array of character indices, or null to use default behavior
 */
function getDirectorActivationOverride(group) {
    const d = group ? getDirectorData(group) : null;
    if (!d || !Array.isArray(d.queue) || d.queue.length === 0) {
        return null;
    }

    const manualDisabled = getManualDisabledMembers(group);
    const disabledSet = new Set(group.disabled_members || []);
    const memberSet = new Set(group.members || []);

    const result = [];
    for (const avatarId of d.queue) {
        // Must be valid member
        if (!memberSet.has(avatarId)) continue;
        // Must not be manually disabled
        if (manualDisabled.includes(avatarId)) continue;
        // Must not be currently disabled
        if (disabledSet.has(avatarId)) continue;
        // Find character index
        const chId = characters.findIndex((c) => c.avatar === avatarId);
        if (chId !== -1 && !result.includes(chId)) {
            result.push(chId);
        }
    }

    return result.length > 0 ? result : null;
}

/**
 * Consumes a generated speaker from the Director queue after generation.
 * @param {Group} group
 * @param {string} memberId
 * @returns {boolean} Whether a queue entry was consumed
 */
function consumeDirectorQueueSpeaker(group, memberId) {
    const d = group ? getDirectorData(group) : null;
    if (!d || !Array.isArray(d.queue) || d.queue.length === 0 || !memberId) {
        return false;
    }

    if (d.queue[0] === memberId) {
        d.queue.shift();
        syncDirectorLastDirectionsQueue(d);
        return true;
    }

    const index = d.queue.indexOf(memberId);
    if (index === -1) {
        return false;
    }

    d.queue.splice(index, 1);
    syncDirectorLastDirectionsQueue(d);
    return true;
}

/**
 * Loads/migrates Director settings from the group.
 * @param {Group|null} group
 */
function loadDirectorSettings(group) {
    if (!group) {
        return;
    }

    const legacyEnabled = group.director_enabled === true || group.director?.enabled === true;
    const directorData = getDirectorData(group);

    let migrated = false;
    if (legacyEnabled && !isDirectorStrategy(group)) {
        group.activation_strategy = group_activation_strategy.DIRECTOR;
        migrated = true;
    }

    // Clear legacy enable flags after migration so they never override the strategy again.
    if (legacyEnabled) {
        directorData.enabled = false;
        delete group.director_enabled;
        migrated = true;
    }

    if (migrated) {
        saveGroupDebounced(group, false);
    }
}

function appendDirectorProfileOptions(select, selectedProfileId) {
    select.empty();
    select.append($('<option></option>').attr('value', '').attr('data-i18n', 'None').text('None'));

    const profiles = extension_settings.connectionManager?.profiles || [];
    const sorted = [...profiles]
        .filter((profile) => getDirectorConnectionProfile(profile.id))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    let foundSelected = false;
    for (const profile of sorted) {
        const option = $('<option></option>')
            .attr('value', profile.id)
            .text(profile.name || 'Unnamed');
        if (profile.id === selectedProfileId || profile.name === selectedProfileId) {
            option.prop('selected', true);
            foundSelected = true;
        }
        select.append(option);
    }

    if (selectedProfileId && !foundSelected) {
        select.append(
            $('<option></option>')
                .attr('value', selectedProfileId)
                .text(`${selectedProfileId} (missing)`)
                .prop('selected', true)
                .prop('disabled', true),
        );
    }
}

function getDirectorMemberLabel(memberId) {
    const character = characters.find((c) => c.avatar === memberId || c.name === memberId);
    return character ? `${character.name} (${memberId})` : memberId;
}

function appendDirectorMemberOptions(select, group, selectedMemberId = '') {
    select.empty();
    select.append($('<option></option>').attr('value', '').text('(none)'));

    for (const memberId of group.members || []) {
        select.append($('<option></option>').attr('value', memberId).text(getDirectorMemberLabel(memberId)));
    }

    select.val(selectedMemberId);
}

function createDirectorSection(title, description = '') {
    const section = $('<details open></details>');
    section.append($('<summary></summary>').text(title));
    if (description) {
        section.append($('<p class="notes"></p>').text(description));
    }
    return section;
}

function createDirectorQueueEditor(group, queue) {
    const section = createDirectorSection('Speaker Queue', 'Order members for upcoming Director-controlled replies.');
    const list = $('<div id="director_inspector_queue" class="flexFlowColumn flexGap5"></div>');

    const appendQueueRow = (memberId = '') => {
        const row = $('<div class="director_inspector_queue_row flex-container alignItemsCenter flexGap5"></div>');
        const select = $('<select class="director_inspector_queue_member text_pole wide100p"></select>');
        appendDirectorMemberOptions(select, group, memberId);
        row.append(select);
        row.append($('<button type="button" class="menu_button director_inspector_queue_up">↑</button>').attr('title', 'Move up'));
        row.append($('<button type="button" class="menu_button director_inspector_queue_down">↓</button>').attr('title', 'Move down'));
        row.append($('<button type="button" class="menu_button director_inspector_queue_remove">Remove</button>'));
        list.append(row);
    };

    for (const memberId of queue || []) {
        appendQueueRow(memberId);
    }

    const actions = $('<div class="flex-container flexGap5"></div>');
    actions.append($('<button id="director_inspector_queue_add" type="button" class="menu_button">Add Queue Entry</button>'));
    actions.append($('<button id="director_inspector_queue_clear" type="button" class="menu_button">Clear Queue</button>'));
    section.append(list, actions);
    section.data('appendQueueRow', appendQueueRow);
    return section;
}

function createDirectorControlledMutesEditor(group, controlledDisabledMembers) {
    const section = createDirectorSection(
        'Director-controlled Disabled Members',
        'Checked members are muted by Director state, not manual group mute.',
    );
    const list = $('<div id="director_inspector_controlled_mutes" class="flexFlowColumn flexGap5"></div>');
    const controlledSet = new Set(controlledDisabledMembers || []);

    for (const memberId of group.members || []) {
        const id = `director_inspector_controlled_mute_${memberId.replace(/[^a-z0-9_-]/gi, '_')}`;
        const label = $('<label class="checkbox_label"></label>');
        label.append(
            $('<input type="checkbox" class="director_inspector_controlled_mute">')
                .attr('id', id)
                .attr('value', memberId)
                .prop('checked', controlledSet.has(memberId)),
        );
        label.append($('<span></span>').text(getDirectorMemberLabel(memberId)));
        list.append(label);
    }

    if (!Array.isArray(group.members) || !group.members.length) {
        list.append($('<p></p>').text('No group members available.'));
    }

    section.append(list);
    section.append($('<button id="director_inspector_mutes_clear" type="button" class="menu_button">Clear Director Mutes</button>'));
    return section;
}

function getDirectorHistorySummary(record, fallback) {
    const summary = record?.parsed?.summary || record?.state?.summary || record?.error || record?.rawResponse || record?.rawOutput || '';
    const timestamp = record?.timestamp || fallback;
    return summary ? `${timestamp} — ${String(summary).slice(0, 160)}` : timestamp;
}

function createDirectorHistoryRemovalSection(title, history, type) {
    const section = createDirectorSection(title, 'Select entries to remove on save.');
    const list = $('<div class="director_inspector_history flexFlowColumn flexGap5"></div>');
    const idPrefix = type === 'decision' ? 'director_inspector_remove_decision' : 'director_inspector_remove_state';
    const className = type === 'decision' ? 'director_inspector_remove_decision' : 'director_inspector_remove_state';
    const records = Array.isArray(history) ? history.map((record, index) => ({ record, index })).reverse() : [];

    if (records.length) {
        for (const { record, index } of records) {
            const checkboxId = `${idPrefix}_${index}`;
            const label = $('<label class="checkbox_label"></label>');
            label.append($('<input type="checkbox">').addClass(className).attr('id', checkboxId).attr('value', String(index)));
            label.append($('<span></span>').text(getDirectorHistorySummary(record, `${title} #${index + 1}`)));
            list.append(label);
        }
    } else {
        list.append($('<p></p>').text('No entries recorded.'));
    }

    const clearButtonId = type === 'decision' ? 'director_inspector_decisions_clear' : 'director_inspector_states_clear';
    section.append(list);
    section.append(
        $('<button type="button" class="menu_button"></button>')
            .attr('id', clearButtonId)
            .text(`Mark All ${type === 'decision' ? 'Decisions' : 'State Records'} for Removal`),
    );
    return section;
}

function createDirectorLastDirectionsSummary(directions) {
    const section = createDirectorSection('Last Directions', 'Most recent Director output used for prompt directions.');
    if (!directions) {
        section.append($('<p></p>').text('No directions recorded.'));
        return section;
    }

    const fields = [
        ['Timestamp', directions.timestamp || 'Unknown'],
        ['Summary', directions.summary || '(empty)'],
        ['Journal', directions.journal || '(empty)'],
        [
            'Queue',
            Array.isArray(directions.queue) && directions.queue.length
                ? directions.queue.map(getDirectorMemberLabel).join(', ')
                : '(empty)',
        ],
        [
            'Actions',
            Array.isArray(directions.actions) && directions.actions.length
                ? directions.actions.map((action) => `${action.action || 'stay'} ${action.memberId || ''}`.trim()).join('; ')
                : '(empty)',
        ],
    ];

    const list = $('<dl></dl>');
    for (const [label, value] of fields) {
        list.append($('<dt></dt>').text(label));
        list.append($('<dd></dd>').text(value));
    }
    section.append(list);
    return section;
}

function readDirectorQueueFromInspector(group) {
    const queue = [];

    $('#director_inspector_queue .director_inspector_queue_member').each(function () {
        queue.push(String($(this).val() || ''));
    });

    return filterDirectorQueueForMembers(queue, group);
}

function readDirectorControlledMutesFromInspector(group) {
    return filterDirectorControlledDisabledMembers(
        $('.director_inspector_controlled_mute:checked')
            .map((_, input) => String($(input).val() || ''))
            .get(),
        group,
    );
}

function buildDirectorDisabledMembersForInspectorSave(group, previousControlledMutes, nextControlledMutes) {
    const previousControlledSet = new Set(normalizeDirectorMemberIdList(previousControlledMutes));
    const disabledSet = new Set(
        (Array.isArray(group?.disabled_members) ? group.disabled_members : []).filter(
            (memberId) => typeof memberId === 'string' && !previousControlledSet.has(memberId),
        ),
    );

    for (const memberId of filterDirectorControlledDisabledMembers(nextControlledMutes, group)) {
        disabledSet.add(memberId);
    }

    return [...disabledSet];
}

function readDirectorHistoryRemovalIndexes(selector) {
    return new Set(
        $(selector)
            .map((_, input) => Number($(input).val()))
            .get()
            .filter((index) => Number.isInteger(index) && index >= 0),
    );
}

function removeDirectorHistoryByOriginalIndexes(history, removalIndexes) {
    const source = Array.isArray(history) ? history : [];
    const indexes = removalIndexes instanceof Set ? removalIndexes : new Set();
    return normalizeDirectorHistoryArray(source.filter((_, index) => !indexes.has(index)));
}

/**
 * Applies validated Inspector edits to Director state.
 * @param {Group} group Group to update.
 * @param {object} edits Inspector edits.
 * @param {any} edits.settings Director settings.
 * @param {any} edits.journal Director journal.
 * @param {any} edits.queue Queue member IDs.
 * @param {any} edits.controlledDisabledMembers Director-controlled mutes.
 * @param {Set<number>} edits.decisionRemovalIndexes Decision history indexes to remove.
 * @param {Set<number>} edits.stateRemovalIndexes State history indexes to remove.
 * @param {boolean} edits.clearAll Whether to clear all Director state.
 * @returns {GroupDirectorConfig} Updated Director state.
 */
function applyDirectorInspectorStateToGroup(
    group,
    {
        settings,
        journal = '',
        queue = [],
        controlledDisabledMembers = [],
        decisionRemovalIndexes = new Set(),
        stateRemovalIndexes = new Set(),
        clearAll = false,
    },
) {
    const directorData = getDirectorData(group);
    const previousControlledMutes = [...directorData.controlledDisabledMembers];

    directorData.settings = normalizeDirectorSettings(settings);

    if (clearAll) {
        directorData.journal = '';
        directorData.queue = [];
        directorData.controlledDisabledMembers = [];
        directorData.decisionHistory = [];
        directorData.decisions = directorData.decisionHistory;
        directorData.stateHistory = [];
        directorData.lastDirections = null;
    } else {
        directorData.journal = String(journal || '');
        directorData.queue = filterDirectorQueueForMembers(queue, group);
        directorData.controlledDisabledMembers = filterDirectorControlledDisabledMembers(controlledDisabledMembers, group);
        directorData.decisionHistory = removeDirectorHistoryByOriginalIndexes(directorData.decisionHistory, decisionRemovalIndexes);
        directorData.decisions = directorData.decisionHistory;
        directorData.stateHistory = removeDirectorHistoryByOriginalIndexes(directorData.stateHistory, stateRemovalIndexes);
        clearDirectorLastDirectionsIfStale(directorData);
    }

    group.disabled_members = buildDirectorDisabledMembersForInspectorSave(
        group,
        previousControlledMutes,
        directorData.controlledDisabledMembers,
    );
    reconcileDirectorControlledMutes(group);
    syncDirectorLastDirectionsQueue(directorData);
    return directorData;
}

/**
 * Opens the Director settings and inspector modal.
 */
async function openDirectorInspectorModal() {
    const originalGroupId = selected_group;
    const group = groups.find((x) => x.id === originalGroupId);
    if (!group) {
        toastr.warning(t`Open a group before configuring Director.`);
        return;
    }

    const d = getDirectorData(group);
    const settings = normalizeDirectorSettings(d.settings);
    const placement = settings.promptPlacement;
    const content = $('<div class="director_inspector flex flexFlowColumn flexGap10"></div>');

    content.append($('<h3></h3>').text('Director Settings'));

    const settingsGrid = $('<div class="flex-container flexFlowColumn flexGap5"></div>');
    const profileSelect = $('<select id="director_inspector_profile" class="text_pole wide100p"></select>');
    appendDirectorProfileOptions(profileSelect, settings.connectionProfileId);
    settingsGrid.append($('<label for="director_inspector_profile"></label>').text('Director Profile'));
    settingsGrid.append(profileSelect);

    settingsGrid.append($('<label for="director_inspector_lookback"></label>').text('Lookback Depth'));
    settingsGrid.append(
        $('<input id="director_inspector_lookback" class="text_pole" type="number" min="0" step="1">').val(settings.lookbackDepth),
    );

    const countLabel = $('<label class="checkbox_label"></label>');
    countLabel.append($('<input id="director_inspector_count_user" type="checkbox">').prop('checked', settings.countUserMessages));
    countLabel.append($('<span></span>').text('Count User Messages'));
    settingsGrid.append(countLabel);

    settingsGrid.append($('<label for="director_inspector_placement"></label>').text('Prompt Placement'));
    const placementSelect = $('<select id="director_inspector_placement" class="text_pole wide100p"></select>');
    placementSelect.append($('<option value="relative"></option>').text('Relative'));
    placementSelect.append($('<option value="in_chat"></option>').text('In-chat'));
    placementSelect.val(placement.type);
    settingsGrid.append(placementSelect);

    settingsGrid.append($('<label for="director_inspector_role"></label>').text('Prompt Role'));
    const roleSelect = $('<select id="director_inspector_role" class="text_pole wide100p"></select>');
    for (const role of ['system', 'user', 'assistant']) {
        roleSelect.append(
            $('<option></option>')
                .attr('value', role)
                .text(role[0].toUpperCase() + role.slice(1)),
        );
    }
    roleSelect.val(placement.role);
    settingsGrid.append(roleSelect);

    settingsGrid.append($('<label for="director_inspector_depth"></label>').text('Prompt Depth'));
    settingsGrid.append($('<input id="director_inspector_depth" class="text_pole" type="number" min="0" step="1">').val(placement.depth));

    settingsGrid.append($('<label for="director_inspector_order"></label>').text('Prompt Order'));
    settingsGrid.append($('<input id="director_inspector_order" class="text_pole" type="number" min="0" step="1">').val(placement.order));
    content.append(settingsGrid);

    content.append($('<h3></h3>').text('Inspector'));

    const journalSection = createDirectorSection('Journal', 'Private Director notes sent to future Director runs.');
    journalSection.append(
        $('<textarea id="director_inspector_journal" class="text_pole textarea_compact autoSetHeight wide100p" rows="6"></textarea>').val(
            d.journal || '',
        ),
    );
    journalSection.append($('<button id="director_inspector_journal_clear" type="button" class="menu_button">Clear Journal</button>'));
    content.append(journalSection);

    const queueSection = createDirectorQueueEditor(group, d.queue);
    content.append(queueSection);
    content.append(createDirectorControlledMutesEditor(group, d.controlledDisabledMembers));
    content.append(createDirectorLastDirectionsSummary(d.lastDirections));
    content.append(
        createDirectorHistoryRemovalSection(
            `Decision History (${Array.isArray(d.decisionHistory) ? d.decisionHistory.length : 0})`,
            d.decisionHistory,
            'decision',
        ),
    );
    content.append(
        createDirectorHistoryRemovalSection(
            `State History (${Array.isArray(d.stateHistory) ? d.stateHistory.length : 0})`,
            d.stateHistory,
            'state',
        ),
    );

    content.append(
        $('<button id="director_inspector_history_clear" type="button" class="menu_button">Mark All History for Removal</button>'),
    );

    const clearAllControls = $('<div class="flexFlowColumn flexFlowRow flexGap5"></div>');
    clearAllControls.append(
        $('<button id="director_inspector_all_clear" type="button" class="menu_button danger_button">Clear All Director State</button>'),
    );
    clearAllControls.append(
        $('<p id="director_inspector_all_clear_status" class="notes"></p>').text(
            'Clears journal, queue, Director mutes, histories, and last directions on save. Confirmation required.',
        ),
    );
    content.append(clearAllControls);
    content.data('clearAllDirectorState', false);

    content.on('input', '#director_inspector_journal', function () {
        resetScrollHeight($(this));
    });
    content.on('click', '#director_inspector_journal_clear', () => $('#director_inspector_journal').val('').trigger('input'));
    content.on('click', '#director_inspector_queue_add', () => queueSection.data('appendQueueRow')(''));
    content.on('click', '#director_inspector_queue_clear', () => $('#director_inspector_queue').empty());
    content.on('click', '.director_inspector_queue_remove', function () {
        $(this).closest('.director_inspector_queue_row').remove();
    });
    content.on('click', '.director_inspector_queue_up', function () {
        const row = $(this).closest('.director_inspector_queue_row');
        row.prev('.director_inspector_queue_row').before(row);
    });
    content.on('click', '.director_inspector_queue_down', function () {
        const row = $(this).closest('.director_inspector_queue_row');
        row.next('.director_inspector_queue_row').after(row);
    });
    content.on('click', '#director_inspector_mutes_clear', () => $('.director_inspector_controlled_mute').prop('checked', false));
    content.on('click', '#director_inspector_decisions_clear', () => $('.director_inspector_remove_decision').prop('checked', true));
    content.on('click', '#director_inspector_states_clear', () => $('.director_inspector_remove_state').prop('checked', true));
    content.on('click', '#director_inspector_history_clear', () =>
        $('.director_inspector_remove_decision, .director_inspector_remove_state').prop('checked', true),
    );
    content.on('click', '#director_inspector_all_clear', () => {
        content.data('clearAllDirectorState', true);
        $('#director_inspector_journal').val('').trigger('input');
        $('#director_inspector_queue').empty();
        $('.director_inspector_controlled_mute').prop('checked', false);
        $('.director_inspector_remove_decision, .director_inspector_remove_state').prop('checked', true);
        $('#director_inspector_all_clear_status').text('All Director state marked for clearing on save. Confirmation required.');
    });

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, null, {
        large: true,
        okButton: 'Save',
        cancelButton: 'Cancel',
        allowVerticalScrolling: true,
        leftAlign: true,
    });
    popup.onClose = async (closedPopup) => {
        if (closedPopup.result !== POPUP_RESULT.AFFIRMATIVE) {
            return;
        }

        const currentGroup = groups.find((x) => x.id === originalGroupId);
        if (!currentGroup) {
            toastr.error(t`Director settings were not saved because the group no longer exists.`);
            return;
        }

        const clearAll = !!content.data('clearAllDirectorState');
        if (clearAll) {
            const confirmClear = await callGenericPopup(t`Clear all Director state? This cannot be undone.`, POPUP_TYPE.CONFIRM);
            if (confirmClear !== POPUP_RESULT.AFFIRMATIVE) {
                toastr.info(t`Director state was not cleared.`);
                return;
            }
        }

        applyDirectorInspectorStateToGroup(currentGroup, {
            settings: {
                connectionProfileId: String($('#director_inspector_profile').val() || ''),
                lookbackDepth: $('#director_inspector_lookback').val(),
                countUserMessages: !!$('#director_inspector_count_user').prop('checked'),
                promptPlacement: {
                    type: String($('#director_inspector_placement').val() || 'relative'),
                    role: String($('#director_inspector_role').val() || 'system'),
                    depth: $('#director_inspector_depth').val(),
                    order: $('#director_inspector_order').val(),
                },
            },
            journal: $('#director_inspector_journal').val(),
            queue: readDirectorQueueFromInspector(currentGroup),
            controlledDisabledMembers: readDirectorControlledMutesFromInspector(currentGroup),
            decisionRemovalIndexes: readDirectorHistoryRemovalIndexes('.director_inspector_remove_decision:checked'),
            stateRemovalIndexes: readDirectorHistoryRemovalIndexes('.director_inspector_remove_state:checked'),
            clearAll,
        });

        await saveDirectorStateAndRefreshPrompt(currentGroup, false);
        toastr.success(clearAll ? t`Director state cleared.` : t`Director settings saved.`);
    };
    await popup.show();
}

jQuery(() => {
    registerDirectorChatMutationListeners();

    if (!CSS.supports('field-sizing', 'content')) {
        $(document).on('input', '#rm_group_chats_block .autoSetHeight', function () {
            resetScrollHeight($(this));
        });
    }

    $(document).on('click', '.group_select', function () {
        const groupId = $(this).attr('data-chid') || $(this).attr('data-grid');
        openGroupById(groupId);
    });
    $('#rm_group_filter').on('input', filterGroupMembers);
    $('#rm_group_members_filter').on('input', filterGroupMemberList);
    $('#rm_group_submit').on('click', createGroup);
    $('#rm_group_scenario').on('click', setCharacterSettingsOverrides);
    $('#rm_group_automode').on('input', function () {
        const value = $(this).prop('checked');
        is_group_automode_enabled = value;
        eventSource.once(event_types.GENERATION_STOPPED, stopAutoModeGeneration);
    });
    $('#rm_group_hidemutedsprites').on('input', function () {
        const value = $(this).prop('checked');
        hideMutedSprites = value;
        onHideMutedSpritesClick(value);
    });
    $('#send_textarea').on('keyup', onSendTextareaInput);
    $('#groupCurrentMemberPopoutButton').on('click', doCurMemberListPopout);
    $('#rm_group_chat_name').on('input', onGroupNameInput);
    $('#rm_group_delete').off().on('click', onDeleteGroupClick);
    $('#group_favorite_button').on('click', onFavoriteGroupClick);
    $('#rm_group_allow_self_responses').on('input', onGroupSelfResponsesClick);
    $('#rm_group_activation_strategy').on('change', onGroupActivationStrategyInput);
    $('#rm_group_generation_mode').on('change', onGroupGenerationModeInput);
    $('#rm_group_automode_delay').on('input', onGroupAutoModeDelayInput);
    $('#rm_group_generation_mode_join_prefix').on('input', onGroupGenerationModeTemplateInput);
    $('#rm_group_generation_mode_join_suffix').on('input', onGroupGenerationModeTemplateInput);
    $('#group_avatar_button').on('input', uploadGroupAvatar);
    $('#rm_group_restore_avatar').on('click', restoreGroupAvatar);

    $('#rm_group_director_inspector').on('click', openDirectorInspectorModal);
    $(document).on('click', '.group_member .right_menu_button', onGroupActionClick);
});
