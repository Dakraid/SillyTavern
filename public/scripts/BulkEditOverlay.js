'use strict';

import {
    characterGroupOverlay,
    characters,
    event_types,
    eventSource,
    generateQuietPrompt,
    getCharacters,
    getRequestHeaders,
    buildAvatarList,
    characterToEntity,
    printCharactersDebounced,
    deleteCharacter,
    saveSettingsDebounced,
    substituteParams,
    unshallowCharacter,
    getThumbnailUrl,
    main_api,
    amount_gen,
    max_context,
    getVirtualCharacterList,
    getEntitiesList,
} from '../script.js';

import { favsToHotswap } from './RossAscends-mods.js';
import { loader } from './action-loader.js';
import { convertCharacterToPersona } from './personas.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import {
    DEFAULT_GROUP_CARD_COMBINE_PROMPT,
    DEFAULT_POST_MERGE_PROMPT,
    power_user,
} from './power-user.js';
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
import { newWorldInfoEntryTemplate, world_names } from './world-info.js';
import { escapeHtml } from './utils.js';
import {
    validateGeneratedGroupCardDescription,
    extractTopLevelXmlBlocks,
    extractXmlBlocksByTag,
    countXmlCorpus,
    autoFixXml,
    extractFirstMessage,
    extractGreetingBlocks,
    parseGreetingsFromGeneratedOutput,
    stripGreetingBlocks,
    stripSummaryFromCharacterBlock,
    buildSummaryCharacterBlock,
    minifyXml,
} from './group-card-xml-parser.js';
import { oai_settings } from './openai.js';
import { textgenerationwebui_settings } from './textgen-settings.js';
import { nai_settings } from './nai-settings.js';
import { kai_settings } from './kai-settings.js';
import { horde_settings } from './horde.js';

const GROUP_CARD_JOB_SESSION_KEY = 'groupCardJobId';

/** @type {Map<string, {jobId: string, groupName: string, loaderHandle: import('./action-loader.js').ActionLoaderHandle, source: EventSource|null, startedAt: number, status: string}>} */
const groupCardJobs = new Map();
let globalJobEventSource = null;

function toGroupCardJobState(job) {
    return {
        jobId: job.id,
        groupName: job.config?.groupName ?? '',
        loaderHandle: null,
        source: null,
        startedAt: job.createdAt,
        status: job.status,
    };
}

const CORE_CHARACTER_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
];
const ALWAYS_INCLUDED_CHARACTER_FIELDS = ['name', 'description'];
const OPTIONAL_CHARACTER_FIELDS = [
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
];
const GROUP_CARD_WIZARD_METADATA_KEY = 'group_card_wizard';

function getGroupCardWizardMetadata(character) {
    return character?.data?.extensions?.[GROUP_CARD_WIZARD_METADATA_KEY] ?? null;
}

function isGroupCardWizardCharacter(character) {
    return Boolean(getGroupCardWizardMetadata(character));
}
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

    const selectedFields = new Set(
        (Array.isArray(selected) ? selected : []).filter((field) =>
            OPTIONAL_CHARACTER_FIELDS.includes(field),
        ),
    );
    const includedFields = new Set([
        ...ALWAYS_INCLUDED_CHARACTER_FIELDS,
        ...selectedFields,
    ]);
    return CORE_CHARACTER_FIELDS.filter((field) => includedFields.has(field));
}

/**
 * Normalizes names for duplicate checks.
 *
 * @param {string} name Name to normalize.
 * @returns {string} Trimmed lowercase name.
 */
function normalizeName(name) {
    return String(name ?? '')
        .trim()
        .toLowerCase();
}

/**
 * Gets a character name from top-level or data fields.
 *
 * @param {object} character Character object.
 * @returns {string} Character name.
 */
function getCharacterName(character) {
    return (
        character?.name ??
		character?.ch_name ??
		character?.data?.name ??
		character?.data?.ch_name ??
		''
    );
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
        .map((character) =>
            typeof character === 'number'
                ? availableCharacters[character]
                : character,
        )
        .filter((character) => normalizeName(getCharacterName(character)));
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
        .map((field) => {
            const value =
				field === 'name'
				    ? payload[field]
				    : substituteParams(payload[field], { name2Override: characterName });
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
    const payload = selectedCharacters
        .map((character) => buildCoreCharacterPromptBlock(character, fields))
        .join('\n\n');

    return `${String(prompt ?? '').trim()}\n\nInput characters:\n${payload}`;
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
        includedFields.includes('personality')
            ? formatLorebookSummaryField('Personality', payload.personality)
            : '',
        includedFields.includes('scenario')
            ? formatLorebookSummaryField('Scenario', payload.scenario)
            : '',
        includedFields.includes('first_mes')
            ? formatLorebookSummaryField('First message', payload.first_mes)
            : '',
        includedFields.includes('mes_example')
            ? formatLorebookSummaryField('Example messages', payload.mes_example)
            : '',
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
        aiFunctionName: name
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+/, ''),
        aiDescription: `Content for ${name}`,
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
    const entries = Object.fromEntries(
        (selectedCharacters ?? []).map((character, index) => {
            const entry = buildLorebookEntry(character, index, fields);
            return [entry.uid, entry];
        }),
    );

    return { entries };
}

/**
 * Extracts all top-level XML blocks without preferring character blocks.
 *
 * @param {string} xmlString XML text.
 * @returns {Array<{tag: string, content: string, raw: string, openTag: string}>} Top-level XML blocks.
 */
function extractAllTopLevelXmlBlocks(xmlString) {
    const text = String(xmlString ?? '').trim();
    const anyOpenRegex = /<([a-zA-Z_][\w.-]*)(?:\s+[^>]*[^/])?>/g;
    const blocks = [];
    let consumedUpTo = 0;
    let match;

    while ((match = anyOpenRegex.exec(text)) !== null) {
        const blockStart = match.index;
        if (blockStart < consumedUpTo) {
            continue;
        }

        const tagName = match[1];
        const subBlocks = extractXmlBlocksByTag(text.slice(blockStart), tagName);
        const block = subBlocks[0];
        const nextSearchIndex = blockStart + match[0].length;

        if (!block) {
            consumedUpTo = Math.max(consumedUpTo, nextSearchIndex);
            anyOpenRegex.lastIndex = consumedUpTo;
            continue;
        }

        const blockEnd = blockStart + block.raw.length;
        blocks.push({
            tag: block.tag,
            content: block.content,
            raw: text.slice(blockStart, blockEnd),
            openTag: block.openTag,
        });
        consumedUpTo = blockEnd;
        anyOpenRegex.lastIndex = Math.max(consumedUpTo, nextSearchIndex);
    }

    return blocks;
}

/**
 * Dynamic lorebook: builds lorebook entries from generated XML blocks.
 * Each character's full XML (minus summary) becomes a lorebook entry.
 *
 * @param {string} generatedXml Generated XML text.
 * @returns {{ entries: object }} World info data.
 */
function buildDynamicLorebookData(generatedXml) {
    const characterBlocks = extractAllTopLevelXmlBlocks(
        String(generatedXml ?? ''),
    ).filter((block) => block.tag === 'character');
    const entries = Object.fromEntries(
        characterBlocks.map((block, index) => {
            const uid = Number.isInteger(index) && index >= 0 ? index : 0;
            const characterName = String(
                extractXmlBlocksByTag(block.content, 'name')[0]?.content ?? '',
            ).trim();
            const entry = {
                uid,
                ...structuredClone(newWorldInfoEntryTemplate),
                key: [characterName],
                comment: characterName,
                content: stripSummaryFromCharacterBlock(block.raw),
                addMemo: true,
                order: 100 - uid,
                aiFunctionName: characterName
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_+/, ''),
                aiDescription: `Content for ${characterName}`,
            };
            return [entry.uid, entry];
        }),
    );

    return { entries };
}

/**
 * Builds a summary-only XML description for dynamic lorebook cards.
 * Character blocks become name + summary blocks; non-character blocks stay intact.
 *
 * @param {string} generatedXml Generated XML text.
 * @returns {string} Main card description XML.
 */
function buildDynamicSummaryDescription(
    generatedXml,
    fallbackTags = ['summary'],
) {
    return extractAllTopLevelXmlBlocks(String(generatedXml ?? ''))
        .map((block) =>
            block.tag === 'character'
                ? buildSummaryCharacterBlock(block.raw, fallbackTags)
                : block.raw,
        )
        .join('\n\n');
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
function findGroupCardCombinePromptPresetIndex(
    name,
    presets = getGroupCardCombinePromptPresets(),
) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return -1;
    }

    return presets.findIndex(
        (preset) => normalizeName(preset?.name) === normalizedName,
    );
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
async function saveGroupCardCombinePromptPreset(
    name,
    prompt,
    { toaster = globalThis.toastr } = {},
) {
    const trimmedName = String(name ?? '').trim();

    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', 'Combine into Group Card');
        return null;
    }

    const presets = getGroupCardCombinePromptPresets();
    const existingIndex = findGroupCardCombinePromptPresetIndex(
        trimmedName,
        presets,
    );
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        const overwrite = await callGenericPopup(
            `Overwrite prompt preset "${escapeHtml(trimmedName)}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: 'Overwrite',
                cancelButton: 'Cancel',
            },
        );

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

    if (
        !Number.isInteger(presetIndex) ||
		presetIndex < 0 ||
		presetIndex >= presets.length
    ) {
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
function renderGroupCardCombinePromptPresetSelect(
    presetSelect,
    selectedIndex = '',
) {
    const presets = getGroupCardCombinePromptPresets();
    presetSelect.empty();
    presetSelect.append($('<option></option>').val('').text('— Load preset —'));

    presets.forEach((preset, index) => {
        presetSelect.append(
            $('<option></option>').val(String(index)).text(preset.name),
        );
    });

    presetSelect.val(selectedIndex === '' ? '' : String(selectedIndex));
}

/**
 * Gets persisted group-card post-merge prompt presets.
 *
 * @returns {Array<{ name: string, prompt: string }>} Prompt presets.
 */
function getGroupCardPostMergePromptPresets() {
    if (!Array.isArray(power_user.group_card_post_merge_prompt_presets)) {
        power_user.group_card_post_merge_prompt_presets = [];
    }

    return power_user.group_card_post_merge_prompt_presets;
}

/**
 * Finds a post-merge prompt preset by name.
 *
 * @param {string} name Preset name.
 * @param {Array<{ name: string, prompt: string }>} [presets] Prompt presets.
 * @returns {number} Preset index, or -1.
 */
function findGroupCardPostMergePromptPresetIndex(
    name,
    presets = getGroupCardPostMergePromptPresets(),
) {
    const normalizedName = normalizeName(name);

    if (!normalizedName) {
        return -1;
    }

    return presets.findIndex(
        (preset) => normalizeName(preset?.name) === normalizedName,
    );
}

/**
 * Saves a named post-merge prompt preset, optionally overwriting an existing preset.
 *
 * @param {string} name Preset name.
 * @param {string} prompt Preset prompt.
 * @param {object} [options] Save dependencies.
 * @param {object} [options.toaster] Toastr-compatible notifier.
 * @returns {Promise<{ name: string, prompt: string }|null>} Saved preset, or null when cancelled.
 */
async function saveGroupCardPostMergePromptPreset(
    name,
    prompt,
    { toaster = globalThis.toastr } = {},
) {
    const trimmedName = String(name ?? '').trim();

    if (!trimmedName) {
        toaster?.warning?.('Enter a preset name.', 'Combine into Group Card');
        return null;
    }

    const presets = getGroupCardPostMergePromptPresets();
    const existingIndex = findGroupCardPostMergePromptPresetIndex(
        trimmedName,
        presets,
    );
    const savedPreset = { name: trimmedName, prompt: String(prompt ?? '') };

    if (existingIndex !== -1) {
        const overwrite = await callGenericPopup(
            `Overwrite prompt preset "${escapeHtml(trimmedName)}"?`,
            POPUP_TYPE.CONFIRM,
            '',
            {
                okButton: 'Overwrite',
                cancelButton: 'Cancel',
            },
        );

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
 * Deletes a post-merge prompt preset by index.
 *
 * @param {number} presetIndex Preset index.
 * @returns {boolean} True if deleted.
 */
function deleteGroupCardPostMergePromptPreset(presetIndex) {
    const presets = getGroupCardPostMergePromptPresets();

    if (
        !Number.isInteger(presetIndex) ||
		presetIndex < 0 ||
		presetIndex >= presets.length
    ) {
        return false;
    }

    presets.splice(presetIndex, 1);
    saveSettingsDebounced();
    return true;
}

/**
 * Populates the post-merge prompt preset selector.
 *
 * @param {JQuery<HTMLElement>} presetSelect Preset select element.
 * @param {number|string} [selectedIndex] Selected preset index.
 */
function renderGroupCardPostMergePromptPresetSelect(
    presetSelect,
    selectedIndex = '',
) {
    const presets = getGroupCardPostMergePromptPresets();
    presetSelect.empty();
    presetSelect.append($('<option></option>').val('').text('— Load preset —'));

    presets.forEach((preset, index) => {
        presetSelect.append(
            $('<option></option>').val(String(index)).text(preset.name),
        );
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
        const response = await sendJsonRequest('/api/worldinfo/delete', {
            name: groupName,
        });
        await throwIfNotOk(
            response,
            `Failed to roll back lorebook "${groupName}".`,
        );
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
        const response = await sendJsonRequest('/api/characters/delete', {
            avatar_url: avatar,
            delete_chats: false,
        });
        await throwIfNotOk(
            response,
            `Failed to roll back character "${groupName}" (avatar "${avatar}").`,
        );
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
        throw new Error(
            `Character "${groupName}" create response did not include avatar.`,
        );
    }

    if (responseText.startsWith('{')) {
        const data = JSON.parse(responseText);
        const avatar = String(data?.avatar ?? '').trim();

        if (!avatar) {
            throw new Error(
                `Character "${groupName}" create response did not include avatar.`,
            );
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
 * @param {boolean} [dynamicLorebook] Whether to create lorebook entries from generated XML.
 * @param {string} [dynamicLorebookSourceXml] Full generated XML used for dynamic lorebook entries.
 * @param {object|null} [wizardMeta] Group card wizard metadata for future re-runs.
 * @param {boolean} [minify] Whether to minify lorebook entry content.
 * @param {boolean} [minifySingleLine] Whether minified lorebook entry content should be single-line.
 * @param {string} [firstMes] First message.
 * @param {Array<string>} [alternateGreetings] Alternate greetings.
 * @returns {Promise<{ avatar: string, world: string }>} Created avatar and linked world name.
 */
async function createGeneratedGroupCard(
    groupName,
    generatedDescription,
    selectedChars,
    createLorebook = true,
    fields = undefined,
    dynamicLorebook = false,
    dynamicLorebookSourceXml = generatedDescription,
    wizardMeta = null,
    minify = false,
    minifySingleLine = false,
    firstMes = '',
    alternateGreetings = [],
) {
    const request = validateGroupCardRequest(groupName, selectedChars, {
        createLorebook,
    });

    if (!request) {
        throw new Error('Group card request is no longer valid.');
    }

    if (request.collisions?.character || request.collisions?.lorebook) {
        const collisionParts = [];
        if (request.collisions.character) {
            collisionParts.push(
                `A character named "${request.groupName}" already exists.`,
            );
        }
        if (request.collisions.lorebook) {
            collisionParts.push(
                `A lorebook named "${request.groupName}" already exists.`,
            );
        }

        const overwrite = await callGenericPopup(
            `${collisionParts.join('\n\n')}\n\nOverwrite existing item(s)?`,
            POPUP_TYPE.CONFIRM,
            'Name Collision',
            { okButton: 'Overwrite Existing', cancelButton: 'Rename Automatically' },
        );

        if (overwrite === POPUP_RESULT.AFFIRMATIVE) {
            request.collisionResolution = 'overwrite';
        } else {
            request.collisionResolution = 'rename';
            const characterList = characters ?? [];
            const worldNames = world_names ?? [];
            let counter = 1;
            let resolvedName = `${request.groupName} (${counter})`;

            while (
                characterList.some(
                    (character) =>
                        normalizeName(getCharacterName(character)) ===
						normalizeName(resolvedName),
                ) ||
				(createLorebook &&
					worldNames.some(
					    (name) => normalizeName(name) === normalizeName(resolvedName),
					))
            ) {
                counter++;
                resolvedName = `${request.groupName} (${counter})`;
            }

            request.groupName = resolvedName;
        }
    }

    const sourceNames = request.characters
        .map((character) => getCoreCharacterField(character, 'name').trim())
        .join(', ');

    if (createLorebook) {
        const lorebookData = dynamicLorebook
            ? buildDynamicLorebookData(dynamicLorebookSourceXml)
            : buildLorebookData(request.characters, fields);

        if (minify) {
            const minifyOptions = {
                compact: !minifySingleLine,
                singleLine: minifySingleLine,
            };
            for (const entry of Object.values(lorebookData.entries)) {
                if (entry.content) {
                    entry.content = minifyXml(entry.content, minifyOptions);
                }
            }
        }

        const worldResponse = await sendJsonRequest('/api/worldinfo/edit', {
            name: request.groupName,
            data: lorebookData,
        });
        await throwIfNotOk(
            worldResponse,
            `Failed to create lorebook "${request.groupName}".`,
        );
    }

    const characterData = {
        name: request.groupName,
        ch_name: request.groupName,
        description: generatedDescription,
        personality: '',
        scenario: '',
        first_mes: firstMes,
        mes_example: '',
        creator_notes: wizardMeta
            ? `Generated group card from: ${sourceNames}\n[group_card_wizard]`
            : `Generated group card from: ${sourceNames}`,
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
        alternate_greetings: alternateGreetings ?? [],
        extensions: {
            ...(createLorebook ? {} : { world: '' }),
            ...(wizardMeta ? { [GROUP_CARD_WIZARD_METADATA_KEY]: wizardMeta } : {}),
        },
    };

    const overwritingCharacter =
		request.collisionResolution === 'overwrite' &&
		request.collisions?.character;
    const overwritingLorebook =
		createLorebook &&
		request.collisionResolution === 'overwrite' &&
		request.collisions?.lorebook;

    let avatar = '';

    if (overwritingCharacter) {
        const existingCharacter = (characters ?? []).find(
            (character) =>
                normalizeName(getCharacterName(character)) ===
				normalizeName(request.groupName),
        );
        avatar = String(existingCharacter?.avatar ?? '');

        if (!avatar) {
            const rollbackMessage =
				createLorebook && !overwritingLorebook
				    ? await rollbackGeneratedLorebook(request.groupName)
				    : '';
            throw new Error(
                `Failed to find existing character "${request.groupName}" avatar. ${rollbackMessage}`,
            );
        }

        const characterResponse = await sendJsonRequest(
            '/api/characters/merge-attributes',
            {
                avatar,
                data: characterData,
            },
        );

        if (!characterResponse.ok) {
            const responseText = await characterResponse.text();
            const rollbackMessage =
				createLorebook && !overwritingLorebook
				    ? await rollbackGeneratedLorebook(request.groupName)
				    : '';
            const artifactMessage = createLorebook
                ? ` after lorebook "${request.groupName}" was created`
                : '';
            throw new Error(
                `Failed to update character "${request.groupName}"${artifactMessage}. ${responseText || 'No response body.'} ${rollbackMessage}`,
            );
        }
    } else {
        const characterResponse = await sendJsonRequest(
            '/api/characters/create',
            characterData,
        );

        if (!characterResponse.ok) {
            const responseText = await characterResponse.text();
            const rollbackMessage =
				createLorebook && !overwritingLorebook
				    ? await rollbackGeneratedLorebook(request.groupName)
				    : '';
            const artifactMessage = createLorebook
                ? ` after lorebook "${request.groupName}" was created`
                : '';
            throw new Error(
                `Failed to create character "${request.groupName}"${artifactMessage}. ${responseText || 'No response body.'} ${rollbackMessage}`,
            );
        }

        try {
            avatar = await readCreatedCharacterAvatar(
                characterResponse,
                request.groupName,
            );
        } catch (error) {
            const rollbackMessage =
				createLorebook && !overwritingLorebook
				    ? await rollbackGeneratedLorebook(request.groupName)
				    : '';
            throw new Error(`${error?.message ?? error} ${rollbackMessage}`);
        }
    }

    if (!createLorebook) {
        return { avatar, world: '' };
    }

    const linkResponse = await sendJsonRequest(
        '/api/characters/merge-attributes',
        {
            avatar,
            data: {
                extensions: {
                    world: request.groupName,
                },
            },
        },
    );

    if (!linkResponse.ok) {
        const responseText = await linkResponse.text();
        const characterRollbackMessage = overwritingCharacter
            ? ''
            : await rollbackGeneratedCharacter(request.groupName, avatar);
        const lorebookRollbackMessage = overwritingLorebook
            ? ''
            : await rollbackGeneratedLorebook(request.groupName);
        throw new Error(
            `Failed to link lorebook "${request.groupName}" to character "${request.groupName}" (avatar "${avatar}"). ${responseText || 'No response body.'} ${characterRollbackMessage} ${lorebookRollbackMessage}`,
        );
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
 * @returns {{ groupName: string, characters: Array<object>, collisions: { character: boolean, lorebook: boolean }, collisionResolution?: string }|null} Valid request data, or null when blocked.
 */
function validateGroupCardRequest(
    groupName,
    selectedCharacters,
    {
        characterList = characters,
        worldNames = world_names,
        toaster = globalThis.toastr,
        createLorebook = true,
    } = {},
) {
    const trimmedName = String(groupName ?? '').trim();
    const normalizedName = normalizeName(trimmedName);

    if (!normalizedName) {
        toaster?.warning?.('Enter a group card name.', 'Combine into Group Card');
        return null;
    }

    const validCharacters = getValidSelectedCharacters(
        selectedCharacters,
        characterList,
    );

    if (validCharacters.length < 2) {
        toaster?.warning?.(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );
        return null;
    }

    const hasCharacterNameCollision = (characterList ?? []).some(
        (character) =>
            normalizeName(getCharacterName(character)) === normalizedName,
    );

    const hasLorebookNameCollision =
		createLorebook &&
		(worldNames ?? []).some((name) => normalizeName(name) === normalizedName);

    return {
        groupName: trimmedName,
        characters: validCharacters,
        collisions: {
            character: hasCharacterNameCollision,
            lorebook: hasLorebookNameCollision,
        },
    };
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
        await eventSource.emit(event_types.CHARACTER_DUPLICATED, {
            oldAvatar: body.avatar_url,
            newAvatar: data.path,
        });
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

    static setRerunVisibility = (selectedCharacters) => {
        const button = document.getElementById('bulk_select_rerun_group_card');
        if (!button) {
            return;
        }

        const selectedIds = Array.isArray(selectedCharacters)
            ? selectedCharacters
            : [];
        const wizardCharacterIds = selectedIds.filter((characterId) =>
            isGroupCardWizardCharacter(
                CharacterContextMenu.#getCharacter(characterId),
            ),
        );
        button.style.display = wizardCharacterIds.length === 1 ? '' : 'none';
    };

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
                id: 'character_context_menu_persona',
                callback: characterGroupOverlay.handleContextMenuPersona,
            },
            {
                id: 'bulk_select_combine_group_card',
                callback: characterGroupOverlay.handleContextMenuCombineGroupCard,
            },
            {
                id: 'bulk_select_rerun_group_card',
                callback: characterGroupOverlay.handleContextMenuRerunGroupCard,
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

    static #syncGlobalGroupCardJobs = (jobs) => {
        for (const job of jobs ?? []) {
            if (job?.managerType !== 'group-card') {
                continue;
            }

            const existing = groupCardJobs.get(job.id);
            if (existing) {
                existing.status = job.status;
                existing.startedAt = job.createdAt;
                existing.groupName = job.config?.groupName ?? existing.groupName;
            } else {
                groupCardJobs.set(job.id, toGroupCardJobState(job));
            }
        }

        BulkEditOverlay.#renderGroupCardJobIndicator();
    };

    static #fetchGlobalJobs = async () => {
        try {
            const response = await fetch('/api/characters/jobs');
            if (!response.ok) {
                return;
            }

            const { jobs } = await response.json();
            BulkEditOverlay.#syncGlobalGroupCardJobs(jobs);
        } catch {
            // Ignore discovery failures; per-job SSE still handles local jobs.
        }
    };

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

            if (jobs.length === 0) {
                container.innerHTML =
					'<div class="active-jobs-empty">No active tasks.</div>';
                return;
            }

            container.innerHTML = `<div class="active-jobs-list">${jobs
                .map((job) => {
                    const icon = job.managerType === 'group-card' ? '📝' : '📖';
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
                    const cancelBtn = isTerminal
                        ? ''
                        : `<div class="menu_button active-job-cancel" data-job-id="${escapeHtml(String(job.id))}" data-job-type="${escapeHtml(String(job.managerType))}" title="Cancel"><i class="fa-solid fa-xmark"></i></div>`;
                    return `<div class="active-job-item">
                    <span class="active-job-icon">${icon}</span>
                    <span class="active-job-name">${escapeHtml(String(name))}</span>
                    <span class="active-job-status ${statusClass}">${escapeHtml(status)}</span>
                    <small>${elapsedStr}</small>
                    ${cancelBtn}
                </div>`;
                })
                .join('')}</div>`;

            container.querySelectorAll('.active-job-cancel').forEach((btn) => {
                if (!(btn instanceof HTMLElement)) {
                    return;
                }

                btn.addEventListener('click', async () => {
                    const jobId = btn.dataset.jobId;
                    const jobType = btn.dataset.jobType;
                    if (!jobId) {
                        return;
                    }

                    const endpoint =
						jobType === 'group-card'
						    ? `/api/characters/group-card-job/${encodeURIComponent(jobId)}/cancel`
						    : `/api/worldinfo/ai-jobs/${encodeURIComponent(jobId)}/cancel`;
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
            container.innerHTML =
				'<div class="active-jobs-empty">Failed to load tasks.</div>';
        }
    };

    static #initGlobalJobSync = () => {
        if (globalJobEventSource) {
            return;
        }

        BulkEditOverlay.#fetchGlobalJobs();
        globalJobEventSource = new EventSource('/api/characters/jobs/events');

        globalJobEventSource.addEventListener('state', (event) => {
            try {
                const { jobs } = JSON.parse(event.data || '{}');
                BulkEditOverlay.#syncGlobalGroupCardJobs(jobs);
                BulkEditOverlay.#renderActiveJobsList();
            } catch {
                // Ignore malformed sync events.
            }
        });

        globalJobEventSource.addEventListener('job_started', (event) => {
            try {
                const data = JSON.parse(event.data || '{}');
                if (data.managerType === 'group-card') {
                    BulkEditOverlay.#fetchGlobalJobs();
                }
                BulkEditOverlay.#renderActiveJobsList();
            } catch {
                // Ignore malformed sync events.
            }
        });

        globalJobEventSource.addEventListener('job_completed', (event) => {
            try {
                const data = JSON.parse(event.data || '{}');
                if (data.managerType === 'group-card') {
                    BulkEditOverlay.#removeGroupCardJob(data.jobId);
                }
                BulkEditOverlay.#renderActiveJobsList();
            } catch {
                // Ignore malformed sync events.
            }
        });

        globalJobEventSource.addEventListener('job_failed', (event) => {
            try {
                const data = JSON.parse(event.data || '{}');
                if (data.managerType === 'group-card') {
                    BulkEditOverlay.#updateGroupCardJobStatus(data.jobId, 'failed');
                }
                BulkEditOverlay.#renderActiveJobsList();
            } catch {
                // Ignore malformed sync events.
            }
        });

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
        CharacterContextMenu.setRerunVisibility(this.selectedCharacters);
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
    handleContextMenuDuplicate = () =>
        Promise.all(
            this.selectedCharacters.map(async (characterId) =>
                CharacterContextMenu.duplicate(characterId),
            ),
        )
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
        const combineIntoGroupCard =
        /** @type {(characterIds: number[]) => Promise<void>} */ (
                BulkEditOverlay[methodName]
            );

        try {
            await combineIntoGroupCard(characterIds);
        } finally {
            this.browseState();
        }
    };

    handleContextMenuRerunGroupCard = async () => {
        const wizardCharacterIds = this.selectedCharacters.filter((characterId) =>
            isGroupCardWizardCharacter(characters[characterId]),
        );
        if (wizardCharacterIds.length !== 1) {
            toastr.warning(
                'Select one wizard-generated group card.',
                'Combine into Group Card',
            );
            return;
        }

        try {
            await BulkEditOverlay.rerunGroupCardWizard(wizardCharacterIds[0]);
        } finally {
            this.browseState();
        }
    };

    /**
	 * Gets the HTML as a string that is displayed inside the group card combine wizard.
	 *
	 * @param {number} characterCount Selected valid character count.
	 * @returns {string} Popup content HTML.
	 */
    static #getCombineGroupCardWizardHtml = (characterCount) => {
        return `
            <div id="bulk_combine_wizard" class="bcw">
                <div class="header">
                    <h3>Combine into Group Card</h3>
                    <div class="stages">
                        <div class="stage-indicator active" data-stage="1">1. Config</div>
                        <div class="stage-indicator" data-stage="2">2. Results</div>
                        <div class="stage-indicator" data-stage="3">3. Post-Process</div>
                        <div class="stage-indicator" data-stage="4">4. Review</div>
                    </div>
                </div>
                <div class="body">
                    <div id="bulk_combine_stage_1" class="stage active">
                        <small class="desc">Generate a group card from ${characterCount} selected characters.</small>
                        <div id="bulk_combine_group_card_characters" class="config-section">
                            <div class="char-lists-row">
                                <div class="char-list-panel">
                                    <h4>Selected Characters</h4>
                                    <div id="bulk_combine_group_card_selected_list"></div>
                                </div>
                                <div id="bulk_combine_group_card_add_section" class="char-list-panel">
                                    <h4>Add Characters</h4>
                                    <input id="bulk_combine_group_card_search" class="text_pole" type="text" placeholder="Search characters..." />
                                    <div id="bulk_combine_group_card_available_list"></div>
                                </div>
                            </div>
                        </div>
                        <label for="bulk_combine_group_card_name" class="text_label">
                            <span>Group name</span>
                            <input id="bulk_combine_group_card_name" class="text_pole" type="text" autocomplete="off" autofocus />
                        </label>
                        <label for="bulk_combine_group_card_prompt" class="text_label">
                            <span>Prompt</span>
                            <textarea id="bulk_combine_group_card_prompt" class="text_pole" rows="12"></textarea>
                        </label>
                        <div id="bulk_combine_group_card_preset_controls" class="preset-controls">
                            <select id="bulk_combine_group_card_preset_select" class="text_pole">
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
                        <div class="field-group">
                            <label for="bulk_combine_group_card_concurrency" class="text_label">
                                <span>Max concurrency</span>
                                <input id="bulk_combine_group_card_concurrency" class="text_pole" type="number" min="1" max="50" value="10" style="width:80px;" />
                            </label>
                        </div>
                        <div class="field-group">
                            <small>Avatar layout & crop</small>
                            <div class="layout-controls">
                                <label class="text_label">
                                    <span>Layout mode</span>
                                    <select id="bulk_combine_group_card_layout" class="text_pole">
                                        <option value="voronoi">Voronoi (organic)</option>
                                        <option value="grid-portrait">Grid (9:16 portrait)</option>
                                        <option value="grid-square">Grid (1:1 square)</option>
                                    </select>
                                </label>
                                <label id="bulk_combine_gap_container" class="text_label" style="display:none;">
                                    <span>Cell gap: <span id="bulk_combine_gap_value">2</span>px</span>
                                    <input id="bulk_combine_gap" type="range" min="0" max="10" value="2" />
                                </label>
                            </div>
                            <div id="bulk_combine_group_card_crop" class="crop-controls">
                                <label class="text_label">
                                    <span>Focus strategy</span>
                                    <select id="bulk_combine_group_card_crop_strategy" class="text_pole">
                                        <option value="attention">Attention (auto)</option>
                                        <option value="entropy">Entropy</option>
                                        <option value="center">Center</option>
                                        <option value="top">Top</option>
                                        <option value="face">Face (heuristic)</option>
                                    </select>
                                </label>
                                <label class="text_label">
                                    <span>Padding: <span id="bulk_combine_group_card_crop_padding_value">15</span>%</span>
                                    <input id="bulk_combine_group_card_crop_padding" type="range" min="0" max="50" value="15" />
                                </label>
                            </div>
                        </div>
                        <div class="field-group">
                            <small>Included fields</small>
                            <div id="bulk_combine_group_card_field_toggles">
                                <label class="checkbox_label"><input type="checkbox" data-field="personality" /><span>Personality</span></label>
                                <label class="checkbox_label"><input type="checkbox" data-field="scenario" /><span>Scenario</span></label>
                                <label class="checkbox_label"><input type="checkbox" data-field="first_mes" /><span>First message</span></label>
                                <label class="checkbox_label"><input type="checkbox" data-field="mes_example" /><span>Example messages</span></label>
                            </div>
                        </div>
                        <label for="bulk_combine_group_card_lorebook_toggle" class="checkbox_label">
                            <input type="checkbox" id="bulk_combine_group_card_lorebook_toggle" />
                            <span>Create lorebook with original character data</span>
                        </label>
                        <label for="bulk_combine_group_card_dynamic_lorebook_toggle" class="checkbox_label">
                            <input type="checkbox" id="bulk_combine_group_card_dynamic_lorebook_toggle" />
                            <span>Use dynamic lorebook</span>
                        </label>
                        <label class="text_label">
                            <span>Summary fallback tags (comma-separated)</span>
                            <input id="bulk_combine_fallback_tags" class="text_pole" type="text" />
                        </label>
                        <div id="bulk_combine_minify_section" class="field-group">
                            <label for="bulk_combine_group_card_minify_toggle" class="checkbox_label">
                                <input type="checkbox" id="bulk_combine_group_card_minify_toggle" />
                                <span>Minify XML output</span>
                            </label>
                            <label for="bulk_combine_group_card_minify_single_line" class="checkbox_label" id="bulk_combine_minify_single_line_label">
                                <input type="checkbox" id="bulk_combine_group_card_minify_single_line" />
                                <span>Single line</span>
                            </label>
                        </div>
                    </div>
                    <div id="bulk_combine_stage_2" class="stage" style="display:none;">
                        <h4>Generation Results</h4>
                        <div id="bulk_combine_results_content">Generation results will appear here.</div>
                    </div>
                    <div id="bulk_combine_stage_3" class="stage" style="display:none;">
                        <h4>Post-Processing</h4>
                        <div id="bulk_combine_postprocess_content">Post-processing controls will appear here.</div>
                    </div>
                    <div id="bulk_combine_stage_4" class="stage" style="display:none;">
                        <h4>Final Review</h4>
                        <div id="bulk_combine_review_content">Final review will appear here.</div>
                    </div>
                </div>
                <div class="footer">
                    <div id="bulk_combine_wizard_back" class="menu_button" style="display:none;">
                        <i class="fa-solid fa-chevron-left"></i> Back
                    </div>
                    <div id="bulk_combine_wizard_cancel" class="menu_button">Cancel</div>
                    <div id="bulk_combine_wizard_save_as_is" class="menu_button" style="display:none;">Save As Is</div>
                    <div id="bulk_combine_wizard_next" class="menu_button">Generate</div>
                </div>
            </div>`;
    };

    /**
	 * Moves the combine wizard to one stage.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 * @param {number} stage Target stage.
	 */
    static #wizardGoToStage = (popupContent, wizardState, stage) => {
        const normalizedStage = Math.max(1, Math.min(4, Number(stage) || 1));
        popupContent.find('.stage').removeClass('active').hide();
        popupContent
            .find(`#bulk_combine_stage_${normalizedStage}`)
            .addClass('active')
            .show();

        popupContent.find('.stage-indicator').removeClass('active completed');
        for (let i = 1; i < normalizedStage; i++) {
            popupContent
                .find(`.stage-indicator[data-stage="${i}"]`)
                .addClass('completed');
        }
        popupContent
            .find(`.stage-indicator[data-stage="${normalizedStage}"]`)
            .addClass('active');

        const backButton = popupContent.find('#bulk_combine_wizard_back');
        const nextButton = popupContent.find('#bulk_combine_wizard_next');
        const saveAsIsButton = popupContent.find('#bulk_combine_wizard_save_as_is');
        backButton.toggle(normalizedStage > 1);
        saveAsIsButton.toggle(normalizedStage === 2);

        switch (normalizedStage) {
            case 1:
                nextButton.text('Generate');
                break;
            case 2:
                nextButton.html(
                    'Apply Processing <i class="fa-solid fa-chevron-right"></i>',
                );
                break;
            case 3:
                nextButton.html(
                    'Apply Changes <i class="fa-solid fa-chevron-right"></i>',
                );
                break;
            case 4:
                nextButton.text('Create Character');
                break;
        }

        wizardState.stage = normalizedStage;
    };

    /**
	 * Toggles wizard next button disabled state.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {boolean} disabled Whether button is disabled.
	 */
    static #setCombineWizardNextDisabled = (popupContent, disabled) => {
        popupContent
            .find('#bulk_combine_wizard_next')
            .toggleClass('disabled', disabled)
            .css('pointer-events', disabled ? 'none' : '')
            .attr('aria-disabled', String(disabled));
    };

    /**
	 * Runs Stage 1 generation for wizard without client-side character creation.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 * @returns {Promise<unknown>} Generation result.
	 */
    static #runCombineWizardStage1Generation = async (
        popupContent,
        wizardState,
    ) => {
        const config = wizardState.config;
        const selectedCharacters =
			BulkEditOverlay.#getWizardSourceCharacters(wizardState);

        if (!BulkEditOverlay.#canUseServerGroupCardJob()) {
            const quiet_prompt = buildGroupCardCombineQuietPrompt(
                config.prompt,
                selectedCharacters,
                config.fields,
            );
            const generatedDescription = String(
                (await generateQuietPrompt({
                    quietPrompt: quiet_prompt,
                    quietToLoud: true,
                    skipWIAN: true,
                })) ?? '',
            );
            const validatedDescription = validateGeneratedGroupCardDescription(
                generatedDescription,
                selectedCharacters.length,
            );
            const blocks = extractTopLevelXmlBlocks(validatedDescription);
            wizardState.characterOutputs = blocks.map((block, index) =>
                BulkEditOverlay.#normalizeWizardCharacterOutput({
                    characterIndex: index,
                    characterName:
						getCoreCharacterField(selectedCharacters[index] ?? {}, 'name') ||
						`Character ${index + 1}`,
                    xmlOutput: block.raw,
                    parseStatus: 'ok',
                }),
            );
            BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
            return {
                description: validatedDescription,
                characterOutputs: wizardState.characterOutputs,
            };
        }

        const jobConfig = BulkEditOverlay.#buildGroupCardJobConfig(
            config.groupName,
            config.prompt,
            selectedCharacters,
            Boolean(config.createLorebook || config.dynamicLorebook),
            config.fields,
            config.concurrency,
            // Initial generation stops at per-character outputs.
            // Stage 3 applies post-processing after review.
            false,
            config.postMergePrompt,
            config.cropStrategy,
            config.cropPadding,
            config.postProcessMode,
            config.dynamicLorebook,
            config.minify,
            config.minifySingleLine,
        );
        let jobEventSource = null;
        let jobId = '';
        let cancelRequested = false;
        const loaderHandle = loader.show({
            slug: 'combine-group-card-wizard',
            title: t`Combine into Group Card`,
            message: t`Starting server-side generation for "${config.groupName}"…`,
            blocking: false,
            toastMode: loader.ToastMode.STOPPABLE,
            stopTooltip: t`Cancel`,
            onStop: async () => {
                cancelRequested = true;
                jobEventSource?.close();
                if (jobId) {
                    await BulkEditOverlay.#cancelGroupCardJob(jobId);
                    BulkEditOverlay.#removeGroupCardJob(jobId);
                }
                await loaderHandle.hide();
            },
        });

        try {
            const jobResponse = await fetch('/api/characters/group-card-job', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ config: jobConfig }),
            });
            if (jobResponse.status === 404) {
                loaderHandle.setMessage(
                    t`Server job endpoint unavailable. Using local generation…`,
                );
                const quiet_prompt = buildGroupCardCombineQuietPrompt(
                    config.prompt,
                    selectedCharacters,
                    config.fields,
                );
                const generatedDescription = String(
                    (await generateQuietPrompt({
                        quietPrompt: quiet_prompt,
                        quietToLoud: true,
                        skipWIAN: true,
                    })) ?? '',
                );
                const validatedDescription = validateGeneratedGroupCardDescription(
                    generatedDescription,
                    selectedCharacters.length,
                );
                const blocks = extractTopLevelXmlBlocks(validatedDescription);
                wizardState.characterOutputs = blocks.map((block, index) =>
                    BulkEditOverlay.#normalizeWizardCharacterOutput({
                        characterIndex: index,
                        characterName:
							getCoreCharacterField(selectedCharacters[index] ?? {}, 'name') ||
							`Character ${index + 1}`,
                        xmlOutput: block.raw,
                    }),
                );
                BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                return {
                    description: validatedDescription,
                    characterOutputs: wizardState.characterOutputs,
                };
            }
            await throwIfNotOk(
                jobResponse,
                'Failed to start server-side group card generation.',
            );
            const jobData = await jobResponse.json();
            jobId = String(jobData.jobId ?? jobData.id ?? '');
            if (!jobId) throw new Error('Server did not return a group card job ID.');
            sessionStorage.setItem(GROUP_CARD_JOB_SESSION_KEY, jobId);

            const SSE_TIMEOUT_MS = 10 * 60 * 1000;
            const result = await new Promise((resolve, reject) => {
                let settled = false;
                const parseEvent = (event) => JSON.parse(event.data || '{}');
                const timeoutId = setTimeout(() => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    jobEventSource?.close();
                    sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                    BulkEditOverlay.#removeGroupCardJob(jobId);
                    void BulkEditOverlay.#cancelGroupCardJob(jobId);
                    reject(new Error('Generation timed out.'));
                }, SSE_TIMEOUT_MS);
                const settle = (callback) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    clearTimeout(timeoutId);
                    sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                    BulkEditOverlay.#removeGroupCardJob(jobId);
                    jobEventSource?.close();
                    callback();
                };

                jobEventSource = new EventSource(
                    `/api/characters/group-card-job/${encodeURIComponent(jobId)}/events`,
                );
                groupCardJobs.set(jobId, {
                    jobId,
                    groupName: config.groupName,
                    loaderHandle,
                    source: jobEventSource,
                    startedAt: Date.now(),
                    status: 'running',
                });
                BulkEditOverlay.#renderGroupCardJobIndicator();
                jobEventSource.addEventListener('character_started', (event) => {
                    const data = parseEvent(event);
                    loaderHandle.setMessage(
                        `Processing character ${Number(data.index ?? 0) + 1}/${selectedCharacters.length}: ${data.name ?? ''}…`,
                    );
                });
                jobEventSource.addEventListener('character_completed', (event) => {
                    const data = parseEvent(event);
                    const index = Number(
                        data.index ?? wizardState.characterOutputs.length,
                    );
                    wizardState.characterOutputs[index] =
						BulkEditOverlay.#normalizeWizardCharacterOutput({
						    characterIndex: index,
						    characterName: String(
						        data.name ??
									getCoreCharacterField(
									    selectedCharacters[index] ?? {},
									    'name',
									),
						    ),
						    xmlOutput: String(data.output ?? ''),
						});
                    BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                    const completedCount =
						wizardState.characterOutputs.filter(Boolean).length;
                    loaderHandle.setMessage(
                        `Completed character ${completedCount}/${selectedCharacters.length}…`,
                    );
                });
                jobEventSource.addEventListener('character_failed', (event) => {
                    const data = parseEvent(event);
                    const index = Number(
                        data.index ?? wizardState.characterOutputs.length,
                    );
                    wizardState.characterOutputs[index] =
						BulkEditOverlay.#normalizeWizardCharacterOutput({
						    characterIndex: index,
						    characterName: String(
						        data.name ??
									getCoreCharacterField(
									    selectedCharacters[index] ?? {},
									    'name',
									),
						    ),
						    xmlOutput: '',
						    parseStatus: 'error',
						    error: String(data.error ?? 'Generation failed.'),
						});
                    BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                });
                jobEventSource.addEventListener('merge_completed', () => {
                    loaderHandle.setMessage(
                        t`Characters generated. Running post-processing…`,
                    );
                });
                jobEventSource.addEventListener('post_merge_started', () => {
                    loaderHandle.setMessage(t`Post-processing generated characters…`);
                });
                jobEventSource.addEventListener('post_merge_completed', () => {
                    loaderHandle.setMessage(
                        t`Post-processing complete. Creating assets…`,
                    );
                });
                jobEventSource.addEventListener('avatar_started', () => {
                    loaderHandle.setMessage(t`Generating group card avatar…`);
                });
                jobEventSource.addEventListener('job_completed', (event) => {
                    const data = parseEvent(event);
                    settle(() => resolve(data));
                });
                jobEventSource.addEventListener('job_failed', (event) => {
                    const data = parseEvent(event);
                    settle(() =>
                        reject(
                            new Error(
                                data.error || 'Server-side group card generation failed.',
                            ),
                        ),
                    );
                });
                jobEventSource.onerror = () => {
                    if (jobEventSource.readyState === EventSource.CLOSED || settled) {
                        return;
                    }
                    loaderHandle.setMessage(
                        t`Connection lost. Reconnecting to server job…`,
                    );
                };
            });
            wizardState.serverCreated = true;
            if (Array.isArray(result?.characterOutputs)) {
                for (const serverOutput of result.characterOutputs) {
                    const idx = Number(
                        serverOutput.characterIndex ?? serverOutput.index ?? 0,
                    );
                    if (idx >= 0 && !wizardState.characterOutputs[idx]) {
                        wizardState.characterOutputs[idx] =
							BulkEditOverlay.#normalizeWizardCharacterOutput(serverOutput);
                    }
                }
            }
            // Fallback: Combined mode doesn't emit character_completed events.
            // Parse the combined output into per-character blocks.
            if (!wizardState.characterOutputs.filter(Boolean).length) {
                const combinedSource = String(
                    result?.combinedOutput ??
						result?.description ??
						wizardState.mergedXml ??
						'',
                ).trim();
                if (combinedSource) {
                    const blocks = extractTopLevelXmlBlocks(combinedSource);
                    wizardState.characterOutputs = blocks.map((block, index) =>
                        BulkEditOverlay.#normalizeWizardCharacterOutput({
                            characterIndex: index,
                            characterName:
								getCoreCharacterField(
								    selectedCharacters[index] ?? {},
								    'name',
								) || `Character ${index + 1}`,
                            xmlOutput: block.raw,
                            parseStatus: 'ok',
                        }),
                    );
                }
            }
            wizardState.characterOutputs = wizardState.characterOutputs
                .filter(Boolean)
                .sort((a, b) => (a.characterIndex ?? 0) - (b.characterIndex ?? 0));
            BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
            return result;
        } catch (error) {
            if (cancelRequested) throw new Error('Group card generation cancelled.');
            throw error;
        } finally {
            jobEventSource?.close();
            await loaderHandle.hide();
        }
    };

    /**
	 * Normalizes wizard character output parse state.
	 * @param {object} output Output object.
	 * @returns {object} Normalized output.
	 */
    static #normalizeWizardCharacterOutput = (output) => {
        const xmlOutput = String(output?.xmlOutput ?? output?.output ?? '').trim();
        const blocks = extractTopLevelXmlBlocks(xmlOutput);
        return {
            ...output,
            characterIndex: Number(output?.characterIndex ?? output?.index ?? 0),
            characterName: String(
                output?.characterName ?? output?.name ?? 'Character',
            ),
            xmlOutput,
            parseStatus: blocks.length > 0 ? 'ok' : 'error',
            error: output?.error ? String(output.error) : '',
        };
    };

    /**
	 * Rebuilds merged XML from valid per-character outputs.
	 * @param {object} wizardState Wizard state.
	 */
    static #updateWizardMergedXml = (wizardState) => {
        wizardState.characterOutputs = (wizardState.characterOutputs ?? []).map(
            (output) => BulkEditOverlay.#normalizeWizardCharacterOutput(output),
        );
        wizardState.mergedXml = wizardState.characterOutputs
            .filter((output) => output.parseStatus === 'ok')
            .map((output) => output.xmlOutput)
            .join('\n\n');
    };

    /**
	 * Gets selected source character objects for wizard state.
	 * @param {object} wizardState Wizard state.
	 * @returns {Array<object>} Source characters.
	 */
    static #getWizardSourceCharacters = (wizardState) =>
        (wizardState.config?.characters ?? []).filter(
            (character) => character && typeof character === 'object',
        );

    /**
	 * Renders generation result cards.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #renderStage2Content = (popupContent, wizardState) => {
        BulkEditOverlay.#updateWizardMergedXml(wizardState);
        const content = popupContent.find('#bulk_combine_results_content');
        content.empty();

        const cards = $('<div></div>').addClass('results-cards');
        const sourceCharacters =
			BulkEditOverlay.#getWizardSourceCharacters(wizardState);

        wizardState.characterOutputs.filter(Boolean).forEach((output, index) => {
            const character =
				sourceCharacters[output.characterIndex] ??
				sourceCharacters[index] ??
				{};
            const ok = output.parseStatus === 'ok';
            const card = $('<div></div>')
                .addClass('result-card')
                .attr('data-index', String(index));
            const header = $('<div></div>').addClass('card-header');
            header.append(
                $('<img alt="Avatar" />')
                    .addClass('avatar')
                    .attr('src', getThumbnailUrl('avatar', character?.avatar ?? '')),
            );
            header.append(
                $('<span></span>').addClass('name').text(output.characterName),
            );
            header.append(
                $('<span></span>')
                    .addClass('status')
                    .text(ok ? '✅' : '❌'),
            );
            header.append(
                $('<input type="checkbox" />')
                    .addClass('regen-checkbox')
                    .prop('checked', !ok),
            );
            card.append(header);
            card.append(
                $('<textarea></textarea>')
                    .addClass('text_pole xml')
                    .attr('rows', '8')
                    .prop('readonly', true)
                    .val(output.xmlOutput || output.error || ''),
            );
            const actions = $('<div></div>').addClass('actions').toggle(!ok);
            actions.append(
                $('<div></div>').addClass('menu_button autofix').text('Auto-fix'),
            );
            actions.append(
                $('<div></div>').addClass('menu_button edit-btn').text('Edit'),
            );
            card.append(actions);
            const nudgeRow = $('<div></div>').addClass('nudge-row');
            nudgeRow.append(
                $('<input type="text">')
                    .addClass('text_pole nudge-input')
                    .attr('placeholder', 'Nudge prompt...'),
            );
            card.append(nudgeRow);
            cards.append(card);
        });

        content.append(
            $('<style></style>').text(`
                .result-card.regenerating { opacity: 0.75; }
                .result-card .nudge-row { display: flex; margin-top: 0.5em; }
                .result-card .nudge-input { flex: 1; }
            `),
        );
        content.append(cards);
        const successful = wizardState.characterOutputs
            .filter(Boolean)
            .filter((output) => output.parseStatus === 'ok').length;
        content.append(
            $('<div></div>')
                .addClass('results-summary')
                .append(
                    $('<span></span>').text(
                        `${successful}/${wizardState.characterOutputs.length} characters generated successfully.`,
                    ),
                ),
        );
        content.append(
            $('<div></div>')
                .addClass('results-actions')
                .append(
                    $('<div></div>')
                        .attr('id', 'bulk_combine_regen_selected')
                        .addClass('menu_button')
                        .text('Regen Selected'),
                )
                .append(
                    $('<div></div>')
                        .attr('id', 'bulk_combine_regen_failed')
                        .addClass('menu_button')
                        .text('Regen Failed'),
                ),
        );
        content.append(
            $('<label></label>')
                .addClass('checkbox_label skip-postprocess')
                .append(
                    $('<input type="checkbox" />')
                        .attr('id', 'bulk_combine_skip_postprocess')
                        .prop('checked', false),
                )
                .append(
                    $('<span></span>').text(
                        'Skip post-processing (use raw merged output)',
                    ),
                ),
        );

        content.find('.autofix').on('click', function () {
            const card = $(this).closest('.result-card');
            const index = Number(card.data('index'));
            const textarea = card.find('.xml');
            const fixed = autoFixXml(String(textarea.val() ?? ''));
            textarea.val(fixed.fixed);
            wizardState.characterOutputs[index].xmlOutput = fixed.fixed;
            wizardState.characterOutputs[index].parseStatus = fixed.succeeded
                ? 'ok'
                : 'error';
            if (fixed.succeeded) {
                BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
            } else {
                textarea.prop('readonly', false);
                $(this)
                    .text('Re-parse')
                    .off('click')
                    .on('click', () => {
                        const blocks = extractTopLevelXmlBlocks(
                            String(textarea.val() ?? ''),
                        );
                        wizardState.characterOutputs[index].xmlOutput = String(
                            textarea.val() ?? '',
                        );
                        wizardState.characterOutputs[index].parseStatus =
							blocks.length > 0 ? 'ok' : 'error';
                        BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                    });
            }
        });

        content.find('.edit-btn').on('click', function () {
            const card = $(this).closest('.result-card');
            const index = Number(card.data('index'));
            const textarea = card.find('.xml');
            textarea.prop('readonly', false).trigger('focus');
            $(this)
                .text('Re-parse')
                .off('click')
                .on('click', () => {
                    const blocks = extractTopLevelXmlBlocks(String(textarea.val() ?? ''));
                    wizardState.characterOutputs[index].xmlOutput = String(
                        textarea.val() ?? '',
                    );
                    wizardState.characterOutputs[index].parseStatus =
						blocks.length > 0 ? 'ok' : 'error';
                    BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                });
        });

        content.find('#bulk_combine_regen_failed').on('click', async () => {
            content.find('.result-card').each((_, element) => {
                const index = Number($(element).data('index'));
                $(element)
                    .find('.regen-checkbox')
                    .prop(
                        'checked',
                        wizardState.characterOutputs[index]?.parseStatus !== 'ok',
                    );
            });
            await BulkEditOverlay.#regenWizardSelectedOutputs(
                popupContent,
                wizardState,
            );
        });
        content.find('#bulk_combine_regen_selected').on('click', async () => {
            await BulkEditOverlay.#regenWizardSelectedOutputs(
                popupContent,
                wizardState,
            );
        });
    };

    /**
	 * Regenerates checked Stage 2 cards.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #regenWizardSelectedOutputs = async (popupContent, wizardState) => {
        const checkedIndexes = popupContent
            .find('.result-card')
            .toArray()
            .filter((element) => $(element).find('.regen-checkbox').prop('checked'))
            .map((element) => Number($(element).data('index')))
            .filter((index) => Number.isInteger(index));

        if (!checkedIndexes.length) {
            toastr.warning(
                'Select at least one result to regenerate.',
                'Combine into Group Card',
            );
            return;
        }

        BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);
        try {
            const sourceCharacters =
				BulkEditOverlay.#getWizardSourceCharacters(wizardState);
            const setRegenButtonsDisabled = (disabled) => {
                popupContent
                    .find('#bulk_combine_regen_selected, #bulk_combine_regen_failed')
                    .toggleClass('disabled', disabled)
                    .css('pointer-events', disabled ? 'none' : '')
                    .attr('aria-disabled', String(disabled));
            };
            setRegenButtonsDisabled(true);

            if (BulkEditOverlay.#canUseServerGroupCardJob()) {
                let jobEventSource = null;
                let jobId = '';
                const regenItems = checkedIndexes
                    .map((outputIndex) => {
                        const oldOutput = wizardState.characterOutputs[outputIndex];
                        return {
                            outputIndex,
                            character:
								sourceCharacters[oldOutput?.characterIndex ?? outputIndex],
                        };
                    })
                    .filter((item) => item.character);
                const regenOutputIndexes = regenItems.map((item) => item.outputIndex);
                const regenCharacters = regenItems.map((item) => item.character);
                if (!regenCharacters.length) {
                    throw new Error('No source characters found for selected output.');
                }
                const nudges = {};
                regenOutputIndexes.forEach((outputIndex, regenIndex) => {
                    const nudge = String(
                        popupContent
                            .find(`.result-card[data-index="${outputIndex}"] .nudge-input`)
                            .val() ?? '',
                    ).trim();
                    if (nudge) {
                        nudges[String(regenIndex)] = nudge;
                    }
                });
                const response = await sendJsonRequest(
                    '/api/characters/group-card-job/regen',
                    {
                        characters: regenCharacters,
                        prompt: wizardState.config.prompt,
                        nudges,
                        fields: wizardState.config.fields,
                        concurrency: wizardState.config.concurrency,
                        llm: BulkEditOverlay.#getGroupCardJobLlmConfig(),
                    },
                );
                await throwIfNotOk(
                    response,
                    'Failed to start server-side regeneration.',
                );
                const data = await response.json();
                jobId = String(data.jobId ?? data.id ?? '');
                if (!jobId) {
                    throw new Error('Server did not return a regeneration job ID.');
                }
                sessionStorage.setItem(GROUP_CARD_JOB_SESSION_KEY, jobId);

                const SSE_TIMEOUT_MS = 10 * 60 * 1000;
                await new Promise((resolve, reject) => {
                    let settled = false;
                    let reconnectNotified = false;
                    const parseEvent = (event) => JSON.parse(event.data || '{}');
                    const updateCardStatus = (originalIndex, status, regenerating) => {
                        const card = popupContent.find(
                            `.result-card[data-index="${originalIndex}"]`,
                        );
                        card.toggleClass('regenerating', regenerating);
                        card.find('.status').text(status);
                    };
                    const timeoutId = setTimeout(() => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        jobEventSource?.close();
                        sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                        BulkEditOverlay.#removeGroupCardJob(jobId);
                        void BulkEditOverlay.#cancelGroupCardJob(jobId);
                        reject(new Error('Regeneration timed out.'));
                    }, SSE_TIMEOUT_MS);
                    const settle = (callback) => {
                        if (settled) {
                            return;
                        }
                        settled = true;
                        clearTimeout(timeoutId);
                        sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                        BulkEditOverlay.#removeGroupCardJob(jobId);
                        jobEventSource?.close();
                        callback();
                    };

                    jobEventSource = new EventSource(
                        `/api/characters/group-card-job/${encodeURIComponent(jobId)}/events`,
                    );
                    jobEventSource.addEventListener('character_started', (event) => {
                        const eventData = parseEvent(event);
                        const regenIndex = Number(eventData.index ?? 0);
                        const originalIndex = regenOutputIndexes[regenIndex];
                        if (Number.isInteger(originalIndex)) {
                            updateCardStatus(originalIndex, '🔄', true);
                        }
                    });
                    jobEventSource.addEventListener('character_completed', (event) => {
                        const eventData = parseEvent(event);
                        const regenIndex = Number(eventData.index ?? 0);
                        const originalIndex = regenOutputIndexes[regenIndex];
                        if (!Number.isInteger(originalIndex)) {
                            return;
                        }
                        const oldOutput = wizardState.characterOutputs[originalIndex];
                        const character =
							sourceCharacters[oldOutput?.characterIndex ?? originalIndex] ??
							{};
                        wizardState.characterOutputs[originalIndex] =
							BulkEditOverlay.#normalizeWizardCharacterOutput({
							    characterIndex: oldOutput?.characterIndex ?? originalIndex,
							    characterName: String(
							        eventData.name ??
										getCoreCharacterField(character, 'name') ??
										`Character ${originalIndex + 1}`,
							    ),
							    xmlOutput: String(eventData.output ?? ''),
							});
                        const card = popupContent.find(
                            `.result-card[data-index="${originalIndex}"]`,
                        );
                        card
                            .find('.xml')
                            .val(wizardState.characterOutputs[originalIndex].xmlOutput);
                        updateCardStatus(originalIndex, '✅', false);
                    });
                    jobEventSource.addEventListener('character_failed', (event) => {
                        const eventData = parseEvent(event);
                        const regenIndex = Number(eventData.index ?? 0);
                        const originalIndex = regenOutputIndexes[regenIndex];
                        if (!Number.isInteger(originalIndex)) {
                            return;
                        }
                        const oldOutput = wizardState.characterOutputs[originalIndex];
                        const character =
							sourceCharacters[oldOutput?.characterIndex ?? originalIndex] ??
							{};
                        wizardState.characterOutputs[originalIndex] =
							BulkEditOverlay.#normalizeWizardCharacterOutput({
							    characterIndex: oldOutput?.characterIndex ?? originalIndex,
							    characterName: String(
							        eventData.name ??
										getCoreCharacterField(character, 'name') ??
										`Character ${originalIndex + 1}`,
							    ),
							    xmlOutput: '',
							    parseStatus: 'error',
							    error: String(eventData.error ?? 'Generation failed.'),
							});
                        const card = popupContent.find(
                            `.result-card[data-index="${originalIndex}"]`,
                        );
                        card
                            .find('.xml')
                            .val(wizardState.characterOutputs[originalIndex].error);
                        updateCardStatus(originalIndex, '❌', false);
                    });
                    jobEventSource.addEventListener('job_completed', () => {
                        settle(() => resolve());
                    });
                    jobEventSource.addEventListener('job_failed', (event) => {
                        const eventData = parseEvent(event);
                        settle(() =>
                            reject(
                                new Error(
                                    eventData.error || 'Server-side regeneration failed.',
                                ),
                            ),
                        );
                    });
                    jobEventSource.onerror = () => {
                        if (jobEventSource.readyState === EventSource.CLOSED || settled) {
                            return;
                        }
                        if (reconnectNotified) {
                            return;
                        }
                        reconnectNotified = true;
                        toastr.info(
                            'Connection lost. Reconnecting to regeneration job…',
                            'Combine into Group Card',
                        );
                    };
                });
                BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
                toastr.success(
                    'Regenerated selected output.',
                    'Combine into Group Card',
                );
                return;
            }

            const tasks = checkedIndexes.map(async (outputIndex) => {
                const oldOutput = wizardState.characterOutputs[outputIndex];
                const character =
					sourceCharacters[oldOutput?.characterIndex ?? outputIndex];
                if (!character) {
                    return;
                }
                const quiet_prompt = buildGroupCardCombineQuietPrompt(
                    wizardState.config.prompt,
                    [character],
                    wizardState.config.fields,
                );
                const generated = String(
                    (await generateQuietPrompt({
                        quietPrompt: quiet_prompt,
                        quietToLoud: true,
                        skipWIAN: true,
                    })) ?? '',
                );
                const validated = validateGeneratedGroupCardDescription(generated, 1);
                wizardState.characterOutputs[outputIndex] =
					BulkEditOverlay.#normalizeWizardCharacterOutput({
					    characterIndex: oldOutput?.characterIndex ?? outputIndex,
					    characterName: getCoreCharacterField(character, 'name'),
					    xmlOutput: validated,
					    parseStatus: 'ok',
					});
            });
            await Promise.all(tasks);
            BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
            toastr.success('Regenerated selected output.', 'Combine into Group Card');
        } catch (error) {
            console.error(error);
            toastr.error(
                error?.message ?? 'Failed to regenerate selected output.',
                'Combine into Group Card',
            );
        } finally {
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
            popupContent
                .find('#bulk_combine_regen_selected, #bulk_combine_regen_failed')
                .removeClass('disabled')
                .css('pointer-events', '')
                .attr('aria-disabled', 'false');
        }
    };

    /**
	 * Renders post-processing controls.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #renderStage3Content = (popupContent, wizardState) => {
        BulkEditOverlay.#updateWizardMergedXml(wizardState);
        const content = popupContent.find('#bulk_combine_postprocess_content');
        content.empty();
        const mode = ['replace', 'prepend', 'append'].includes(
            wizardState.postProcessMode,
        )
            ? wizardState.postProcessMode
            : 'replace';
        const prompt = String(
            wizardState.config?.postMergePrompt || DEFAULT_POST_MERGE_PROMPT,
        );
        const html = $(`
            <div class="postprocess-mode">
              <small>Post-processing mode</small>
              <div id="bulk_combine_postprocess_mode_select" class="postprocess-mode-selector">
                <label class="checkbox_label"><input type="radio" name="bulk_combine_postprocess_mode" value="replace" /><span>Replace</span></label>
                <label class="checkbox_label"><input type="radio" name="bulk_combine_postprocess_mode" value="prepend" /><span>Prepend</span></label>
                <label class="checkbox_label"><input type="radio" name="bulk_combine_postprocess_mode" value="append" /><span>Append</span></label>
              </div>
            </div>
            <div class="field-group">
              <label class="text_label"><span>Post-processing prompt</span><textarea id="bulk_combine_postprocess_prompt" class="text_pole" rows="8"></textarea></label>
              <div id="bulk_combine_postprocess_preset_controls" class="postprocess-preset-controls">
                <select id="bulk_combine_postprocess_preset_select" class="text_pole"><option value="">— Load preset —</option></select>
                <div id="bulk_combine_postprocess_preset_save" class="menu_button" title="Save post-processing prompt as preset"><i class="fa-solid fa-floppy-disk"></i></div>
                <div id="bulk_combine_postprocess_preset_delete" class="menu_button" title="Delete selected preset"><i class="fa-solid fa-trash-can"></i></div>
                <div id="bulk_combine_postprocess_preset_restore" class="menu_button" title="Restore built-in default"><i class="fa-solid fa-rotate-left"></i></div>
              </div>
              <div id="bulk_combine_apply_postprocess" class="menu_button">Apply Post-Processing</div>
            </div>
            <div class="field-group">
              <label class="text_label"><span>Preview</span></label>
              <div id="bulk_combine_postprocess_preview" class="preview-area" style="max-height:300px;overflow-y:auto;"></div>
            </div>`);
        content.append(html);
        content
            .find(`input[name="bulk_combine_postprocess_mode"][value="${mode}"]`)
            .prop('checked', true);
        content.find('#bulk_combine_postprocess_prompt').val(prompt);
        const preview = content.find('#bulk_combine_postprocess_preview');
        if (wizardState.postProcessResult) {
            preview.text(String(wizardState.postProcessResult));
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
        } else {
            preview.append(
                $('<small></small>').text(
                    'Click "Apply Post-Processing" to see the result.',
                ),
            );
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);
        }

        const presetSelect = content.find(
            '#bulk_combine_postprocess_preset_select',
        );
        renderGroupCardPostMergePromptPresetSelect(presetSelect);
        presetSelect.on('change', () => {
            const preset =
				getGroupCardPostMergePromptPresets()[Number(presetSelect.val())];
            if (preset)
                content.find('#bulk_combine_postprocess_prompt').val(preset.prompt);
        });
        content
            .find('#bulk_combine_postprocess_preset_save')
            .on('click', async () => {
                const presetName = await callGenericPopup(
                    'Enter a post-processing prompt preset name:',
                    POPUP_TYPE.INPUT,
                    '',
                    { okButton: 'Save', cancelButton: 'Cancel' },
                );
                if (!presetName) return;
                const saved = await saveGroupCardPostMergePromptPreset(
                    String(presetName),
                    String(content.find('#bulk_combine_postprocess_prompt').val() ?? ''),
                );
                if (saved)
                    renderGroupCardPostMergePromptPresetSelect(
                        presetSelect,
                        findGroupCardPostMergePromptPresetIndex(saved.name),
                    );
            });
        content.find('#bulk_combine_postprocess_preset_delete').on('click', () => {
            if (deleteGroupCardPostMergePromptPreset(Number(presetSelect.val())))
                renderGroupCardPostMergePromptPresetSelect(presetSelect);
        });
        content.find('#bulk_combine_postprocess_preset_restore').on('click', () => {
            content
                .find('#bulk_combine_postprocess_prompt')
                .val(DEFAULT_POST_MERGE_PROMPT);
        });
        content
            .find('input[name="bulk_combine_postprocess_mode"]')
            .on('change', () => {
                wizardState.postProcessMode = String(
                    content
                        .find('input[name="bulk_combine_postprocess_mode"]:checked')
                        .val() ?? 'replace',
                );
            });
        content
            .find('#bulk_combine_apply_postprocess')
            .on('click', async function () {
                const button = $(this);
                if (button.hasClass('disabled')) {
                    return;
                }

                button
                    .addClass('disabled')
                    .css('pointer-events', 'none')
                    .text('Processing…');
                const preview = content.find('#bulk_combine_postprocess_preview');
                preview.html(
                    '<p><i class="fa-solid fa-spinner fa-spin"></i> Running post-processing…</p>',
                );

                try {
                    const applied = await BulkEditOverlay.#applyWizardPostProcessing(
                        popupContent,
                        wizardState,
                    );
                    if (applied) {
                        toastr.success(
                            'Post-processing complete.',
                            'Combine into Group Card',
                        );
                    } else if (!wizardState.postProcessResult) {
                        preview
                            .empty()
                            .append(
                                $('<small></small>').text(
                                    'Click "Apply Post-Processing" to see the result.',
                                ),
                            );
                    }
                } catch (error) {
                    console.error(error);
                    preview.html(
                        `<p class="error">Post-processing failed: ${escapeHtml(error?.message ?? 'Unknown error')}</p>`,
                    );
                    toastr.error(
                        error?.message ?? 'Post-processing failed.',
                        'Combine into Group Card',
                    );
                } finally {
                    button
                        .removeClass('disabled')
                        .css('pointer-events', '')
                        .text('Apply Post-Processing');
                }
            });
    };

    /**
	 * Applies Stage 3 post-processing.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 * @returns {Promise<boolean>} Whether post-processing completed.
	 */
    static #applyWizardPostProcessing = async (popupContent, wizardState) => {
        const content = popupContent.find('#bulk_combine_postprocess_content');
        const mode = String(
            content
                .find('input[name="bulk_combine_postprocess_mode"]:checked')
                .val() ?? 'replace',
        );
        const prompt = String(
            content.find('#bulk_combine_postprocess_prompt').val() ?? '',
        ).trim();
        if (!prompt) {
            toastr.warning(
                'Enter a post-processing prompt.',
                'Combine into Group Card',
            );
            return false;
        }
        BulkEditOverlay.#updateWizardMergedXml(wizardState);
        if (!wizardState.mergedXml) {
            toastr.warning(
                'At least one valid output required.',
                'Combine into Group Card',
            );
            return false;
        }
        const quiet_prompt =
			mode === 'replace'
			    ? `${prompt}\n\n${wizardState.mergedXml}`
			    : mode === 'append'
			        ? `${wizardState.mergedXml}\n\n${prompt}`
			        : `${prompt}\n\nMerged output:\n${wizardState.mergedXml}`;
        BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);
        try {
            const generated = String(
                (await generateQuietPrompt({
                    quietPrompt: quiet_prompt,
                    quietToLoud: true,
                    skipWIAN: true,
                    quietName: 'System',
                    removeReasoning: true,
                })) ?? '',
            ).trim();
            let result = generated;
            if (mode === 'replace') {
                const fixed = validateGeneratedGroupCardDescription(generated, 0);
                const inputCount = countXmlCorpus(wizardState.mergedXml);
                const outputCount = countXmlCorpus(fixed);
                if (inputCount > 0 && outputCount !== inputCount) {
                    toastr.error(
                        `Post-processing returned ${outputCount} XML block(s), expected ${inputCount}.`,
                        'Combine into Group Card',
                    );
                    return false;
                }
                result = fixed;
            } else if (mode === 'prepend') {
                result = `${generated}\n\n${wizardState.mergedXml}`;
            } else {
                result = `${wizardState.mergedXml}\n\n${generated}`;
            }
            wizardState.postProcessMode = mode;
            wizardState.postProcessResult = result;
            power_user.group_card_post_process_mode = mode;
            power_user.group_card_post_merge_prompt = prompt;
            saveSettingsDebounced();
            content.find('#bulk_combine_postprocess_preview').text(result);
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
            return true;
        } finally {
            if (!wizardState.postProcessResult) {
                BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);
            }
        }
    };

    /**
	 * Renders final review controls.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #renderStage4Content = (popupContent, wizardState) => {
        const existingFirstMesValue = String(
            popupContent.find('#bulk_combine_review_first_mes').val() ?? '',
        );
        const dynamicLorebookSourceXml = String(
            wizardState.postProcessResult || wizardState.mergedXml || '',
        );
        const greetingBlocks = extractGreetingBlocks(dynamicLorebookSourceXml);
        const greetings = parseGreetingsFromGeneratedOutput(
            dynamicLorebookSourceXml,
        );
        let description = stripGreetingBlocks(dynamicLorebookSourceXml);

        if (wizardState.config?.dynamicLorebook) {
            const fallbackTags = wizardState.config?.summaryFallbackTags ??
				power_user.summary_fallback_tags ?? ['summary'];
            description = buildDynamicSummaryDescription(description, fallbackTags);
        }

        if (wizardState.config?.minify) {
            description = minifyXml(description, {
                compact: !wizardState.config?.minifySingleLine,
                singleLine: wizardState.config?.minifySingleLine,
            });
        }

        const content = popupContent.find('#bulk_combine_review_content');
        content.empty();
        const html = $(`
            <div class="review-section"><label class="text_label"><span>Character Name</span><input id="bulk_combine_review_name" class="text_pole" type="text" /></label></div>
            <div class="review-section"><label class="text_label"><span>Description (merged XML)</span></label><textarea id="bulk_combine_review_description" class="text_pole" rows="12" readonly></textarea></div>
            <div class="review-section"><label class="text_label"><span>First Message</span><textarea id="bulk_combine_review_first_mes" class="text_pole" rows="4"></textarea></label></div>
            <div class="review-section"><label class="text_label"><span>Avatar Preview</span></label><div id="bulk_combine_avatar_preview" style="text-align:center;margin:0.5em 0;"><img id="bulk_combine_avatar_image" style="max-width:200px;max-height:300px;border-radius:8px;" /></div><div class="field-group layout-controls"><label class="text_label"><span>Layout mode</span><select id="bulk_combine_review_layout" class="text_pole"><option value="voronoi">Voronoi (organic)</option><option value="grid-portrait">Grid (9:16 portrait)</option><option value="grid-square">Grid (1:1 square)</option></select></label><label id="bulk_combine_review_gap_container" class="text_label" style="display:none;"><span>Cell gap: <span id="bulk_combine_review_gap_value">2</span>px</span><input id="bulk_combine_review_gap" type="range" min="0" max="10" value="2" /></label></div><div id="bulk_combine_avatar_offsets"></div><div class="field-group" style="text-align:center;"><div id="bulk_combine_regenerate_avatar" class="menu_button">Regenerate Avatar</div></div><div class="field-group" style="display:flex;align-items:center;gap:0.5em;justify-content:center;"><label class="text_label"><span>Voronoi Seed:</span> <input id="bulk_combine_voronoi_seed" class="text_pole" type="number" style="width:8em;" /></label><div id="bulk_combine_shuffle_seed" class="menu_button" title="Randomize pattern"><i class="fa-solid fa-shuffle"></i></div></div></div>
            <div class="review-section"><small id="bulk_combine_review_source_summary"></small></div>`);
        content.append(html);
        if (wizardState.config?.dynamicLorebook) {
            content
                .find('#bulk_combine_review_description')
                .closest('.review-section')
                .append(
                    $('<small></small>')
                        .addClass('dynamic-lorebook-info')
                        .text(
                            'Dynamic lorebook active: character summaries in card, full definitions in lorebook.',
                        ),
                );
        }
        content
            .find('#bulk_combine_review_name')
            .val(wizardState.config?.groupName ?? '');
        content.find('#bulk_combine_review_description').val(description);
        content
            .find('#bulk_combine_review_first_mes')
            .val(
                existingFirstMesValue ||
					greetings.first_mes ||
					extractFirstMessage(description),
            );
        if (greetingBlocks.length > 1 && greetings.alternate_greetings.length > 0) {
            const greetingsSection = $('<div class="review-section"></div>');
            greetingsSection.append(
                $('<label class="text_label"><span>Alternate Greetings</span></label>'),
            );
            greetings.alternate_greetings.forEach((greeting, idx) => {
                greetingsSection.append(
                    $('<textarea></textarea>')
                        .addClass('text_pole alt-greeting')
                        .attr('rows', '3')
                        .attr('data-greeting-index', String(idx))
                        .val(greeting),
                );
            });
            content.append(greetingsSection);
        }
        const avatar = wizardState.avatarUrl || wizardState.results?.avatar || '';
        if (avatar) {
            const avatarImage = content.find('#bulk_combine_avatar_image');
            avatarImage.attr(
                'src',
                String(avatar).startsWith('data:')
                    ? avatar
                    : getThumbnailUrl('avatar', avatar),
            );
            avatarImage.off('load.bcwAvatarEditor').on('load.bcwAvatarEditor', () => {
                BulkEditOverlay.#setupInteractiveEditor(popupContent, wizardState);
            });
        }
        const layout = ['voronoi', 'grid-portrait', 'grid-square'].includes(
            wizardState.config?.layout,
        )
            ? wizardState.config.layout
            : 'voronoi';
        const gap = Number.isFinite(Number(wizardState.config?.gap))
            ? Math.max(0, Math.min(10, Math.round(Number(wizardState.config.gap))))
            : 2;
        wizardState.config.layout = layout;
        wizardState.config.gap = gap;
        content.find('#bulk_combine_review_layout').val(layout);
        content.find('#bulk_combine_review_gap').val(String(gap));
        content.find('#bulk_combine_review_gap_value').text(String(gap));
        content
            .find('#bulk_combine_review_gap_container')
            .toggle(layout !== 'voronoi');
        content.find('#bulk_combine_review_layout').on('change', async function () {
            const nextLayout = String($(this).val() ?? 'voronoi');
            wizardState.config.layout = [
                'voronoi',
                'grid-portrait',
                'grid-square',
            ].includes(nextLayout)
                ? nextLayout
                : 'voronoi';
            content
                .find('#bulk_combine_review_gap_container')
                .toggle(wizardState.config.layout !== 'voronoi');
            await BulkEditOverlay.#regenerateWizardAvatar(popupContent, wizardState);
        });
        content.find('#bulk_combine_review_gap').on('input', async function () {
            const nextGap = Number($(this).val());
            wizardState.config.gap = Number.isFinite(nextGap)
                ? Math.max(0, Math.min(10, Math.round(nextGap)))
                : 2;
            content
                .find('#bulk_combine_review_gap_value')
                .text(String(wizardState.config.gap));
            await BulkEditOverlay.#regenerateWizardAvatar(popupContent, wizardState);
        });
        const offsets = content.find('#bulk_combine_avatar_offsets');
        const sourceCharacters =
			BulkEditOverlay.#getWizardSourceCharacters(wizardState);
        wizardState.avatarOffsets =
			wizardState.avatarOffsets?.length === sourceCharacters.length
			    ? wizardState.avatarOffsets
			    : sourceCharacters.map(() => ({ x: 0, y: 0, scale: 100 }));
        sourceCharacters.forEach((character, index) => {
            const offset = wizardState.avatarOffsets[index] ?? {
                x: 0,
                y: 0,
                scale: 100,
            };
            const card = $('<div></div>')
                .addClass('offset-card')
                .attr('data-index', String(index));
            card.append(
                $('<img alt="Avatar" />')
                    .addClass('avatar')
                    .attr('src', getThumbnailUrl('avatar', character?.avatar ?? '')),
            );
            card.append(
                $('<span></span>').text(getCoreCharacterField(character, 'name')),
            );
            for (const axis of ['x', 'y']) {
                card.append(
                    $('<label></label>')
                        .addClass('text_label')
                        .append(`${axis.toUpperCase()}: `)
                        .append(
                            $(
                                `<input type="range" class="offset-${axis}" min="-1000" max="1000" />`,
                            ).val(String(offset[axis] ?? 0)),
                        )
                        .append(
                            $(`<span class="offset-${axis}-val"></span>`).text(
                                String(offset[axis] ?? 0),
                            ),
                        ),
                );
            }
            card.append(
                $('<label></label>')
                    .addClass('text_label')
                    .append('Scale: ')
                    .append(
                        $(
                            '<input type="range" class="offset-scale" min="50" max="200" />',
                        ).val(String(offset.scale ?? 100)),
                    )
                    .append(
                        $('<span class="offset-scale-val"></span>').text(
                            `${offset.scale ?? 100}%`,
                        ),
                    ),
            );
            card.append(
                $('<div></div>').addClass('menu_button offset-reset').text('Reset'),
            );
            offsets.append(card);
        });
        content
            .find('#bulk_combine_review_source_summary')
            .text(
                `Source: ${sourceCharacters.length} characters | Fields: ${(wizardState.config?.fields ?? []).join(', ')}`,
            );
        content
            .find('#bulk_combine_avatar_offsets input[type="range"]')
            .on('input', function () {
                const card = $(this).closest('.offset-card');
                const index = Number(card.data('index'));
                const x = Number(card.find('.offset-x').val());
                const y = Number(card.find('.offset-y').val());
                const scale = Number(card.find('.offset-scale').val());
                wizardState.avatarOffsets[index] = { x, y, scale };
                card.find('.offset-x-val').text(String(x));
                card.find('.offset-y-val').text(String(y));
                card.find('.offset-scale-val').text(`${scale}%`);
                BulkEditOverlay.#updateAvatarEditorCellTransform(
                    popupContent,
                    wizardState,
                    index,
                );
            });
        content.find('.offset-reset').on('click', function () {
            const card = $(this).closest('.offset-card');
            card.find('.offset-x').val('0').trigger('input');
            card.find('.offset-y').val('0').trigger('input');
            card.find('.offset-scale').val('100').trigger('input');
        });
        content.find('#bulk_combine_regenerate_avatar').on('click', async () => {
            await BulkEditOverlay.#regenerateWizardAvatar(popupContent, wizardState);
        });
        content
            .find('#bulk_combine_voronoi_seed')
            .val(String(wizardState.voronoiSeed));
        content.find('#bulk_combine_voronoi_seed').on('change', function () {
            wizardState.voronoiSeed = Number($(this).val()) || 0;
        });
        content.find('#bulk_combine_shuffle_seed').on('click', function () {
            wizardState.voronoiSeed = Math.floor(Math.random() * 2147483647);
            content
                .find('#bulk_combine_voronoi_seed')
                .val(String(wizardState.voronoiSeed));
            BulkEditOverlay.#regenerateWizardAvatar(popupContent, wizardState);
        });
        BulkEditOverlay.#setupInteractiveEditor(popupContent, wizardState);
        BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
    };

    /**
	 * Sets up interactive per-cell avatar editor in review stage.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #setupInteractiveEditor = (popupContent, wizardState) => {
        const preview = popupContent.find('#bulk_combine_avatar_preview');
        const image = preview.find('#bulk_combine_avatar_image');
        const imageElement = /** @type {HTMLImageElement | undefined} */ (image[0]);
        const cells = Array.isArray(wizardState.cells) ? wizardState.cells : [];
        const sourceCharacters =
			BulkEditOverlay.#getWizardSourceCharacters(wizardState);

        if (wizardState.avatarEditorAbortController) {
            wizardState.avatarEditorAbortController.abort();
            wizardState.avatarEditorAbortController = null;
        }

        if (!imageElement || !cells.length || !sourceCharacters.length) {
            preview.find('.avatar-editor-cell').remove();
            return;
        }

        if (!imageElement.complete || !imageElement.naturalWidth) {
            image.one('load.bcwAvatarEditorSetup', () => {
                BulkEditOverlay.#setupInteractiveEditor(popupContent, wizardState);
            });
            return;
        }

        if (!image.parent().hasClass('avatar-editor')) {
            image.wrap('<div class="avatar-editor"></div>');
        }

        const editor = preview.find('.avatar-editor');
        editor.find('.avatar-editor-cell').remove();

        const imageRect = imageElement.getBoundingClientRect();
        const previewWidth = imageRect.width;
        const previewHeight = imageRect.height;

        if (!previewWidth || !previewHeight) {
            return;
        }

        editor.css({ width: `${previewWidth}px`, height: `${previewHeight}px` });

        const scaleX = previewWidth / 1024;
        const scaleY = previewHeight / 1536;
        const abortController = new AbortController();
        wizardState.avatarEditorAbortController = abortController;
        let dragState = null;
        let pinchState = null;

        const selectCell = (index) => {
            wizardState.avatarEditorSelectedIndex = index;
            editor
                .find('.avatar-editor-cell')
                .removeClass('selected')
                .filter(`[data-index="${index}"]`)
                .addClass('selected');
        };

        const startDrag = (event, index, clientX, clientY) => {
            selectCell(index);
            const offset = BulkEditOverlay.#normalizeAvatarOffset(
                wizardState.avatarOffsets?.[index],
            );
            const cell = editor.find(`.avatar-editor-cell[data-index="${index}"]`);
            dragState = {
                index,
                startX: clientX,
                startY: clientY,
                offsetX: offset.x,
                offsetY: offset.y,
                scaleX: Number(cell.attr('data-output-scale-x')) || scaleX,
                scaleY: Number(cell.attr('data-output-scale-y')) || scaleY,
            };
            event.preventDefault();
        };

        const updateDrag = (clientX, clientY) => {
            if (!dragState) {
                return;
            }

            const offset = BulkEditOverlay.#normalizeAvatarOffset(
                wizardState.avatarOffsets?.[dragState.index],
            );
            const x = BulkEditOverlay.#clampNumber(
                dragState.offsetX + (clientX - dragState.startX) / dragState.scaleX,
                -100,
                100,
                0,
            );
            const y = BulkEditOverlay.#clampNumber(
                dragState.offsetY + (clientY - dragState.startY) / dragState.scaleY,
                -100,
                100,
                0,
            );
            wizardState.avatarOffsets[dragState.index] = {
                x,
                y,
                scale: offset.scale,
            };
            BulkEditOverlay.#updateAvatarEditorCellTransform(
                popupContent,
                wizardState,
                dragState.index,
            );
        };

        const finishInteraction = () => {
            if (dragState) {
                BulkEditOverlay.#syncAvatarOffsetSliders(
                    popupContent,
                    wizardState,
                    dragState.index,
                );
            }
            dragState = null;
            pinchState = null;
        };

        cells.slice(0, sourceCharacters.length).forEach((cell, index) => {
            const bounds = BulkEditOverlay.#getAvatarEditorCellBounds(cell);
            if (!bounds) {
                return;
            }

            const overlay = $('<div></div>')
                .addClass('avatar-editor-cell')
                .attr('data-index', String(index))
                .attr('data-cell-type', cell.type === 'rect' ? 'rect' : 'polygon')
                .attr('data-output-scale-x', String((bounds.w * scaleX) / bounds.w))
                .attr('data-output-scale-y', String((bounds.h * scaleY) / bounds.h))
                .css({
                    left: `${bounds.x * scaleX}px`,
                    top: `${bounds.y * scaleY}px`,
                    width: `${bounds.w * scaleX}px`,
                    height: `${bounds.h * scaleY}px`,
                });

            if (cell.type !== 'rect' && Array.isArray(cell.points)) {
                const polygon = cell.points
                    .map(
                        ([x, y]) =>
                            `${((x - bounds.x) / bounds.w) * 100}% ${((y - bounds.y) / bounds.h) * 100}%`,
                    )
                    .join(', ');
                overlay.css('clip-path', `polygon(${polygon})`);
            }

            const character = sourceCharacters[index];
            const cellImage = $('<img alt="Avatar cell" />').attr(
                'src',
                getThumbnailUrl('avatar', character?.avatar ?? ''),
            );

            if (cell.type === 'rect') {
                cellImage.addClass('avatar-editor-cell-image-rect');
            } else {
                cellImage.addClass('avatar-editor-cell-image-polygon').css({
                    width: `${previewWidth}px`,
                    height: `${previewHeight}px`,
                    left: `${-bounds.x * scaleX}px`,
                    top: `${-bounds.y * scaleY}px`,
                });
            }

            overlay.append(cellImage);
            editor.append(overlay);
            BulkEditOverlay.#updateAvatarEditorCellTransform(
                popupContent,
                wizardState,
                index,
            );

            const overlayElement = /** @type {HTMLElement} */ (overlay[0]);
            overlayElement.addEventListener(
                'mousedown',
                (event) => startDrag(event, index, event.clientX, event.clientY),
                { signal: abortController.signal },
            );
            overlayElement.addEventListener(
                'wheel',
                (event) => {
                    if (wizardState.avatarEditorSelectedIndex !== index) {
                        selectCell(index);
                    }
                    event.preventDefault();
                    const offset = BulkEditOverlay.#normalizeAvatarOffset(
                        wizardState.avatarOffsets?.[index],
                    );
                    const nextScale = BulkEditOverlay.#clampNumber(
                        offset.scale + (event.deltaY > 0 ? -5 : 5),
                        50,
                        200,
                        100,
                    );
                    wizardState.avatarOffsets[index] = {
                        ...offset,
                        scale: nextScale,
                    };
                    BulkEditOverlay.#updateAvatarEditorCellTransform(
                        popupContent,
                        wizardState,
                        index,
                    );
                    BulkEditOverlay.#syncAvatarOffsetSliders(
                        popupContent,
                        wizardState,
                        index,
                    );
                },
                { passive: false, signal: abortController.signal },
            );
            overlayElement.addEventListener(
                'touchstart',
                (event) => {
                    selectCell(index);
                    if (event.touches.length === 2) {
                        const [first, second] = event.touches;
                        const offset = BulkEditOverlay.#normalizeAvatarOffset(
                            wizardState.avatarOffsets?.[index],
                        );
                        pinchState = {
                            index,
                            distance: Math.hypot(
                                first.clientX - second.clientX,
                                first.clientY - second.clientY,
                            ),
                            scale: offset.scale,
                        };
                        event.preventDefault();
                        return;
                    }

                    const touch = event.touches[0];
                    if (touch) {
                        startDrag(event, index, touch.clientX, touch.clientY);
                    }
                },
                { passive: false, signal: abortController.signal },
            );
        });

        document.addEventListener(
            'mousemove',
            (event) => updateDrag(event.clientX, event.clientY),
            { signal: abortController.signal },
        );
        document.addEventListener('mouseup', finishInteraction, {
            signal: abortController.signal,
        });
        document.addEventListener(
            'touchmove',
            (event) => {
                if (pinchState && event.touches.length === 2) {
                    const [first, second] = event.touches;
                    const distance = Math.hypot(
                        first.clientX - second.clientX,
                        first.clientY - second.clientY,
                    );
                    const nextScale = BulkEditOverlay.#clampNumber(
                        pinchState.scale + (distance - pinchState.distance) / 2,
                        50,
                        200,
                        100,
                    );
                    const offset = BulkEditOverlay.#normalizeAvatarOffset(
                        wizardState.avatarOffsets?.[pinchState.index],
                    );
                    wizardState.avatarOffsets[pinchState.index] = {
                        ...offset,
                        scale: nextScale,
                    };
                    BulkEditOverlay.#updateAvatarEditorCellTransform(
                        popupContent,
                        wizardState,
                        pinchState.index,
                    );
                    BulkEditOverlay.#syncAvatarOffsetSliders(
                        popupContent,
                        wizardState,
                        pinchState.index,
                    );
                    event.preventDefault();
                    return;
                }

                if (dragState && event.touches.length === 1) {
                    const touch = event.touches[0];
                    updateDrag(touch.clientX, touch.clientY);
                    event.preventDefault();
                }
            },
            { passive: false, signal: abortController.signal },
        );
        document.addEventListener('touchend', finishInteraction, {
            signal: abortController.signal,
        });

        if (Number.isInteger(wizardState.avatarEditorSelectedIndex)) {
            selectCell(wizardState.avatarEditorSelectedIndex);
        }
    };

    static #getAvatarEditorCellBounds = (cell) => {
        if (cell?.type === 'rect') {
            const x = Number(cell.x);
            const y = Number(cell.y);
            const w = Number(cell.w);
            const h = Number(cell.h);
            if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
                return { x, y, w, h };
            }
            return null;
        }

        if (!Array.isArray(cell?.points) || cell.points.length < 3) {
            return null;
        }

        const xs = cell.points
            .map((point) => Number(point?.[0]))
            .filter(Number.isFinite);
        const ys = cell.points
            .map((point) => Number(point?.[1]))
            .filter(Number.isFinite);
        if (!xs.length || !ys.length) {
            return null;
        }

        const x = Math.min(...xs);
        const y = Math.min(...ys);
        const w = Math.max(...xs) - x;
        const h = Math.max(...ys) - y;
        return w > 0 && h > 0 ? { x, y, w, h } : null;
    };

    static #normalizeAvatarOffset = (offset) => {
        return {
            x: BulkEditOverlay.#clampNumber(Number(offset?.x), -100, 100, 0),
            y: BulkEditOverlay.#clampNumber(Number(offset?.y), -100, 100, 0),
            scale: BulkEditOverlay.#clampNumber(Number(offset?.scale), 50, 200, 100),
        };
    };

    static #updateAvatarEditorCellTransform = (
        popupContent,
        wizardState,
        index,
    ) => {
        const cell = popupContent.find(
            `.avatar-editor-cell[data-index="${index}"]`,
        );
        const image = cell.find('img');
        if (!cell.length || !image.length) {
            return;
        }

        const offset = BulkEditOverlay.#normalizeAvatarOffset(
            wizardState.avatarOffsets?.[index],
        );
        wizardState.avatarOffsets[index] = offset;
        const scaleX = Number(cell.attr('data-output-scale-x')) || 1;
        const scaleY = Number(cell.attr('data-output-scale-y')) || 1;
        image.css(
            'transform',
            `translate(${offset.x * scaleX}px, ${offset.y * scaleY}px) scale(${offset.scale / 100})`,
        );
    };

    static #syncAvatarOffsetSliders = (popupContent, wizardState, index) => {
        const offset = BulkEditOverlay.#normalizeAvatarOffset(
            wizardState.avatarOffsets?.[index],
        );
        const card = popupContent.find(`.offset-card[data-index="${index}"]`);
        card.find('.offset-x').val(String(offset.x));
        card.find('.offset-y').val(String(offset.y));
        card.find('.offset-scale').val(String(offset.scale));
        card.find('.offset-x-val').text(String(offset.x));
        card.find('.offset-y-val').text(String(offset.y));
        card.find('.offset-scale-val').text(`${offset.scale}%`);
    };

    static #clampNumber = (value, min, max, fallback) => {
        const number = Number(value);
        if (!Number.isFinite(number)) {
            return fallback;
        }

        return Math.min(max, Math.max(min, Math.round(number)));
    };

    /**
	 * Regenerates review avatar preview.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #regenerateWizardAvatar = async (popupContent, wizardState) => {
        const avatars = BulkEditOverlay.#getWizardSourceCharacters(wizardState)
            .map((character) => character.avatar)
            .filter(Boolean);
        if (!avatars.length) {
            toastr.warning('No source avatars available.', 'Combine into Group Card');
            return;
        }
        try {
            const response = await fetch(
                '/api/characters/generate-voronoi-composite',
                {
                    method: 'POST',
                    headers: {
                        ...getRequestHeaders(),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        avatars,
                        offsets: wizardState.avatarOffsets,
                        cropStrategy: wizardState.config?.cropStrategy,
                        cropPadding: wizardState.config?.cropPadding,
                        layout: wizardState.config?.layout,
                        gap: wizardState.config?.gap,
                        seed: wizardState.voronoiSeed,
                    }),
                },
            );
            await throwIfNotOk(response, 'Failed to regenerate avatar.');
            const data = await response.json();
            if (data?.image) {
                wizardState.avatarUrl = data.image;
                wizardState.cells = Array.isArray(data.cells) ? data.cells : [];
                const avatarImage = popupContent.find('#bulk_combine_avatar_image');
                avatarImage
                    .off('load.bcwAvatarEditor')
                    .on('load.bcwAvatarEditor', () => {
                        BulkEditOverlay.#setupInteractiveEditor(popupContent, wizardState);
                    })
                    .attr('src', wizardState.avatarUrl);
                if (avatarImage[0]?.complete) {
                    BulkEditOverlay.#setupInteractiveEditor(popupContent, wizardState);
                }
            }
        } catch (error) {
            console.error(error);
            toastr.error(
                error?.message ?? 'Failed to regenerate avatar.',
                'Combine into Group Card',
            );
        }
    };

    /**
	 * Applies regenerated avatar preview to a character avatar file.
	 * @param {object} wizardState Wizard state.
	 * @param {string} avatar Avatar filename.
	 * @returns {Promise<void>}
	 */
    static #applyWizardRegeneratedAvatar = async (wizardState, avatar) => {
        if (!wizardState.avatarUrl || !avatar) {
            return;
        }

        const imageResponse = await fetch(wizardState.avatarUrl);
        await throwIfNotOk(imageResponse, 'Failed to read regenerated avatar.');
        const imageBlob = await imageResponse.blob();
        const formData = new FormData();
        formData.append('avatar_url', avatar);
        formData.append('avatar', imageBlob, 'avatar.png');
        const editHeaders = getRequestHeaders();
        delete editHeaders['Content-Type'];
        const response = await fetch('/api/characters/edit-avatar', {
            method: 'POST',
            headers: editHeaders,
            body: formData,
        });
        await throwIfNotOk(response, 'Failed to apply regenerated avatar.');
    };

    /**
	 * Creates or updates final group card from Stage 4.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #handleStage4Create = async (popupContent, wizardState) => {
        const dynamicLorebookSourceXml = String(
            wizardState.postProcessResult || wizardState.mergedXml || '',
        );
        const { alternate_greetings: parsedGreetings } =
			parseGreetingsFromGeneratedOutput(dynamicLorebookSourceXml);
        const description = String(
            popupContent.find('#bulk_combine_review_description').val() ?? '',
        ).trim();
        const descriptionWithoutGreetings = stripGreetingBlocks(description);
        const dynamicLorebookSourceWithoutGreetings = stripGreetingBlocks(
            dynamicLorebookSourceXml,
        );
        const firstMes = String(
            popupContent.find('#bulk_combine_review_first_mes').val() ?? '',
        );
        const alternateGreetings = [];
        const alternateGreetingInputs = popupContent.find('.alt-greeting');
        alternateGreetingInputs.each(function () {
            const val = String($(this).val() ?? '').trim();
            if (val) {
                alternateGreetings.push(val);
            }
        });
        if (alternateGreetingInputs.length === 0 && parsedGreetings.length > 0) {
            alternateGreetings.push(...parsedGreetings);
        }
        const groupName = String(
            popupContent.find('#bulk_combine_review_name').val() ??
				wizardState.config?.groupName ??
				'',
        ).trim();
        if (!groupName || !description) {
            toastr.warning(
                'Character name and description are required.',
                'Combine into Group Card',
            );
            return false;
        }
        BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);
        try {
            const fallbackTags = wizardState.config?.summaryFallbackTags ??
				power_user.summary_fallback_tags ?? ['summary'];
            let finalDescription = wizardState.config?.dynamicLorebook
                ? buildDynamicSummaryDescription(
                    dynamicLorebookSourceWithoutGreetings,
                    fallbackTags,
                )
                : descriptionWithoutGreetings;
            if (wizardState.config?.minify) {
                finalDescription = minifyXml(finalDescription, {
                    compact: !wizardState.config?.minifySingleLine,
                    singleLine: wizardState.config?.minifySingleLine,
                });
            }
            const wizardMeta =
				BulkEditOverlay.#buildGroupCardWizardMetadata(wizardState);
            const updateAvatar =
				wizardState.rerunConfig?.rerunAvatar ??
				(wizardState.serverCreated && wizardState.results?.avatar
				    ? wizardState.results.avatar
				    : null);

            if (updateAvatar) {
                const response = await sendJsonRequest(
                    '/api/characters/merge-attributes',
                    {
                        avatar: updateAvatar,
                        data: {
                            name: groupName,
                            ch_name: groupName,
                            description: finalDescription,
                            first_mes: firstMes,
                            alternate_greetings: alternateGreetings,
                            creator_notes: `Generated group card from: ${wizardMeta.sourceCharacterNames.join(', ')}\n[group_card_wizard]`,
                            extensions: {
                                [GROUP_CARD_WIZARD_METADATA_KEY]: wizardMeta,
                            },
                        },
                    },
                );
                await throwIfNotOk(response, 'Failed to update generated group card.');
                await BulkEditOverlay.#applyWizardRegeneratedAvatar(
                    wizardState,
                    updateAvatar,
                );
            } else {
                const result = await createGeneratedGroupCard(
                    groupName,
                    finalDescription,
                    BulkEditOverlay.#getWizardSourceCharacters(wizardState),
                    Boolean(
                        wizardState.config?.createLorebook ||
							wizardState.config?.dynamicLorebook,
                    ),
                    wizardState.config?.fields,
                    Boolean(wizardState.config?.dynamicLorebook),
                    dynamicLorebookSourceWithoutGreetings,
                    wizardMeta,
                    wizardState.config?.minify,
                    wizardState.config?.minifySingleLine,
                    firstMes,
                    alternateGreetings,
                );
                const { avatar, world } = result;
                wizardState.createdArtifacts = { avatar, world };
                wizardState.results = result;
                await BulkEditOverlay.#applyWizardRegeneratedAvatar(
                    wizardState,
                    avatar,
                );
            }
            await getCharacters();
            toastr.success('Group card saved.', 'Combine into Group Card');
            return true;
        } catch (error) {
            console.error(error);
            toastr.error(
                error?.message ?? 'Failed to save group card.',
                'Combine into Group Card',
            );
            return false;
        } finally {
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
        }
    };

    /**
	 * Saves Stage 2 output without post-processing.
	 * @param {JQuery<HTMLElement>} popupContent Popup content root.
	 * @param {object} wizardState Wizard state.
	 */
    static #handleStage2SaveAsIs = async (popupContent, wizardState) => {
        BulkEditOverlay.#updateWizardMergedXml(wizardState);
        if (
            wizardState.rerunConfig?.rerunAvatar ||
			(wizardState.serverCreated && wizardState.results?.avatar)
        ) {
            const wizardMeta =
				BulkEditOverlay.#buildGroupCardWizardMetadata(wizardState);
            const targetAvatar =
				wizardState.rerunConfig?.rerunAvatar ?? wizardState.results.avatar;
            const response = await sendJsonRequest(
                '/api/characters/merge-attributes',
                {
                    avatar: targetAvatar,
                    data: {
                        extensions: {
                            [GROUP_CARD_WIZARD_METADATA_KEY]: wizardMeta,
                        },
                    },
                },
            );
            await throwIfNotOk(response, 'Failed to update generated group card.');
            toastr.success('Group card already created.', 'Combine into Group Card');
            return true;
        }
        if (!wizardState.mergedXml) {
            toastr.warning(
                'At least one valid output required.',
                'Combine into Group Card',
            );
            return false;
        }
        try {
            const sourceXml = wizardState.mergedXml;
            const fallbackTags = wizardState.config?.summaryFallbackTags ??
				power_user.summary_fallback_tags ?? ['summary'];
            let description = wizardState.config?.dynamicLorebook
                ? buildDynamicSummaryDescription(sourceXml, fallbackTags)
                : sourceXml;

            if (wizardState.config?.minify) {
                description = minifyXml(description, {
                    compact: !wizardState.config?.minifySingleLine,
                    singleLine: wizardState.config?.minifySingleLine,
                });
            }

            const wizardMeta =
				BulkEditOverlay.#buildGroupCardWizardMetadata(wizardState);
            const result = await createGeneratedGroupCard(
                wizardState.config.groupName,
                description,
                BulkEditOverlay.#getWizardSourceCharacters(wizardState),
                Boolean(
                    wizardState.config.createLorebook ||
						wizardState.config?.dynamicLorebook,
                ),
                wizardState.config.fields,
                Boolean(wizardState.config?.dynamicLorebook),
                sourceXml,
                wizardMeta,
                wizardState.config?.minify,
                wizardState.config?.minifySingleLine,
            );
            wizardState.results = result;
            await getCharacters();
            toastr.success('Created group card.', 'Combine into Group Card');
            return true;
        } catch (error) {
            console.error(error);
            toastr.error(
                error?.message ?? 'Failed to create group card.',
                'Combine into Group Card',
            );
            return false;
        }
    };

    /**
	 * Resolves selected character ids or objects to unique character indexes.
	 *
	 * @param {Array<number|object>} selectedCharacters Selected character ids or objects.
	 * @returns {Array<number>} Valid selected character indexes.
	 */
    static #resolveCombineGroupCardCharacterIds = (selectedCharacters) => {
        const selectedIds = [];
        const selectedIdSet = new Set();

        for (const selected of selectedCharacters ?? []) {
            let id = -1;

            if (typeof selected === 'number') {
                id = selected;
            } else if (selected && typeof selected === 'object') {
                id = characters.indexOf(selected);

                if (id === -1 && typeof selected.avatar === 'string') {
                    id = characters.findIndex(
                        (character) => character?.avatar === selected.avatar,
                    );
                }
            }

            if (
                Number.isInteger(id) &&
				id >= 0 &&
				id < characters.length &&
				!selectedIdSet.has(id) &&
				normalizeName(getCharacterName(characters[id]))
            ) {
                selectedIds.push(id);
                selectedIdSet.add(id);
            }
        }

        return selectedIds;
    };

    /**
	 * Creates a small character row for the combine group card modal.
	 *
	 * @param {object} character Character object.
	 * @param {'add'|'remove'} action Button action.
	 * @param {() => void} onClick Click handler.
	 * @returns {JQuery<HTMLElement>} Character item.
	 */
    static #createCombineGroupCardCharacterItem = (
        character,
        action,
        onClick,
    ) => {
        const item = $('<div></div>')
            .addClass('character-item')
            .attr('data-avatar', character?.avatar ?? '');
        const avatar = $('<img alt="Avatar" />')
            .attr('src', getThumbnailUrl('avatar', character?.avatar ?? ''))
            .attr('title', character?.avatar ?? '');
        const name = $('<span></span>')
            .addClass('char-name')
            .text(getCharacterName(character));
        const button = $('<div></div>')
            .addClass(
                action === 'add' ? 'menu_button char-add' : 'menu_button char-remove',
            )
            .attr('title', action === 'add' ? 'Add' : 'Remove')
            .append(
                $('<i></i>').addClass(
                    action === 'add' ? 'fa-solid fa-plus' : 'fa-solid fa-xmark',
                ),
            )
            .on('click', onClick);

        return item.append(avatar, name, button);
    };

    /**
	 * Renders selected and available characters in the combine modal.
	 *
	 * @param {JQuery<HTMLElement>} popupContent Popup root.
	 * @param {Array<number>} selectedCharacterIds Mutable selected character indexes.
	 */
    static #renderCombineGroupCardCharacterLists = (
        popupContent,
        selectedCharacterIds,
    ) => {
        const selectedList = popupContent.find(
            '#bulk_combine_group_card_selected_list',
        );
        const availableList = popupContent.find(
            '#bulk_combine_group_card_available_list',
        );
        const searchInput = popupContent.find('#bulk_combine_group_card_search');
        const description = popupContent.find('.desc');
        const selectedIdSet = new Set(selectedCharacterIds);
        const query = String(searchInput.val() ?? '')
            .trim()
            .toLowerCase();

        description.text(
            `Generate a group card from ${selectedCharacterIds.length} selected characters.`,
        );
        selectedList.empty();
        availableList.empty();

        for (const id of selectedCharacterIds) {
            const character = characters[id];
            if (!character) {
                continue;
            }

            selectedList.append(
                BulkEditOverlay.#createCombineGroupCardCharacterItem(
                    character,
                    'remove',
                    () => {
                        if (selectedCharacterIds.length <= 2) {
                            toastr.warning(
                                'Select at least two valid characters.',
                                'Combine into Group Card',
                            );
                            return;
                        }

                        const index = selectedCharacterIds.indexOf(id);
                        if (index !== -1) {
                            selectedCharacterIds.splice(index, 1);
                        }

                        BulkEditOverlay.#renderCombineGroupCardCharacterLists(
                            popupContent,
                            selectedCharacterIds,
                        );
                    },
                ),
            );
        }

        const availableCharacters = characters
            .map((character, id) => ({ character, id }))
            .filter(({ character, id }) => {
                if (
                    selectedIdSet.has(id) ||
					!normalizeName(getCharacterName(character))
                ) {
                    return false;
                }

                return (
                    !query || normalizeName(getCharacterName(character)).includes(query)
                );
            })
            .slice(0, 50);

        for (const { character, id } of availableCharacters) {
            availableList.append(
                BulkEditOverlay.#createCombineGroupCardCharacterItem(
                    character,
                    'add',
                    () => {
                        if (!selectedCharacterIds.includes(id)) {
                            selectedCharacterIds.push(id);
                        }

                        BulkEditOverlay.#renderCombineGroupCardCharacterLists(
                            popupContent,
                            selectedCharacterIds,
                        );
                    },
                ),
            );
        }

        if (!availableCharacters.length) {
            availableList.append(
                $('<small></small>').text(
                    query ? 'No matching characters.' : 'No more characters to add.',
                ),
            );
        }
    };

    /**
	 * Handles Stage 1 generation click.
	 * @param {JQuery<HTMLElement>} popupContent Popup root.
	 * @param {object} wizardState Wizard state.
	 * @returns {Promise<void>}
	 */
    static #handleCombineWizardStage1Next = async (popupContent, wizardState) => {
        const promptInput = popupContent.find('#bulk_combine_group_card_prompt');
        const concurrencyInput = popupContent.find(
            '#bulk_combine_group_card_concurrency',
        );
        const cropStrategySelect = popupContent.find(
            '#bulk_combine_group_card_crop_strategy',
        );
        const cropPaddingInput = popupContent.find(
            '#bulk_combine_group_card_crop_padding',
        );
        const layoutSelect = popupContent.find('#bulk_combine_group_card_layout');
        const gapInput = popupContent.find('#bulk_combine_gap');
        const lorebookToggle = popupContent.find(
            '#bulk_combine_group_card_lorebook_toggle',
        );
        const dynamicLorebookToggle = popupContent.find(
            '#bulk_combine_group_card_dynamic_lorebook_toggle',
        );
        const minifyToggle = popupContent.find(
            '#bulk_combine_group_card_minify_toggle',
        );
        const minifySingleLineToggle = popupContent.find(
            '#bulk_combine_group_card_minify_single_line',
        );
        const fieldToggles = popupContent.find(
            '#bulk_combine_group_card_field_toggles input[type="checkbox"]',
        );
        const groupNameInput = popupContent.find('#bulk_combine_group_card_name');
        const prompt = String(promptInput.val() ?? '').trim();

        if (!prompt) {
            toastr.warning('Enter a prompt.', 'Combine into Group Card');
            return;
        }

        const parsedConcurrency = Number(concurrencyInput.val());
        const concurrency = Number.isFinite(parsedConcurrency)
            ? Math.max(1, Math.min(50, Math.round(parsedConcurrency)))
            : 10;
        const postProcessMode = 'replace';
        const postMergeEnabled = true;
        const postMergePrompt = String(
            power_user.group_card_post_merge_prompt ?? DEFAULT_POST_MERGE_PROMPT,
        ).trim();
        const cropStrategyValue = String(cropStrategySelect.val() ?? 'attention');
        const cropStrategy = [
            'attention',
            'entropy',
            'center',
            'top',
            'face',
        ].includes(cropStrategyValue)
            ? cropStrategyValue
            : 'attention';
        const parsedCropPadding = Number(cropPaddingInput.val());
        const cropPadding = Number.isFinite(parsedCropPadding)
            ? Math.max(0, Math.min(50, Math.round(parsedCropPadding)))
            : 15;
        const layoutValue = String(layoutSelect.val() ?? 'voronoi');
        const layout = ['voronoi', 'grid-portrait', 'grid-square'].includes(
            layoutValue,
        )
            ? layoutValue
            : 'voronoi';
        const parsedGap = Number(gapInput.val());
        const gap = Number.isFinite(parsedGap)
            ? Math.max(0, Math.min(10, Math.round(parsedGap)))
            : 2;

        if (postMergeEnabled && !postMergePrompt) {
            toastr.warning(
                'Enter a post-processing prompt or disable post-processing.',
                'Combine into Group Card',
            );
            return;
        }

        const createLorebook = Boolean(lorebookToggle.prop('checked'));
        const dynamicLorebook = Boolean(dynamicLorebookToggle.prop('checked'));
        const minify = Boolean(minifyToggle.prop('checked'));
        const minifySingleLine = Boolean(minifySingleLineToggle.prop('checked'));
        const summaryFallbackTags = String(
            popupContent.find('#bulk_combine_fallback_tags').val() ?? '',
        )
            .split(',')
            .map((tag) => tag.trim())
            .filter(Boolean);
        const normalizedSummaryFallbackTags =
			summaryFallbackTags.length > 0 ? summaryFallbackTags : ['summary'];
        await Promise.all(
            wizardState.selectedCharacterIds
                .filter((id) => characters[id]?.shallow)
                .map((id) => unshallowCharacter(String(id))),
        );
        const request = validateGroupCardRequest(
            String(groupNameInput.val() ?? ''),
            wizardState.selectedCharacterIds,
            { createLorebook: createLorebook || dynamicLorebook },
        );

        if (!request) {
            return;
        }

        const selectedOptionalFields = fieldToggles
            .toArray()
            .filter((element) => $(element).prop('checked'))
            .map((element) => String($(element).data('field') ?? ''))
            .filter((field) => OPTIONAL_CHARACTER_FIELDS.includes(field));
        const selectedFields = normalizeSelectedFields(selectedOptionalFields);

        power_user.group_card_combine_prompt = prompt;
        power_user.group_card_combine_included_fields = selectedOptionalFields;
        power_user.group_card_parallel_concurrency = concurrency;
        power_user.group_card_crop_strategy = cropStrategy;
        power_user.group_card_crop_padding = cropPadding;
        power_user.group_card_layout = layout;
        power_user.group_card_gap = gap;
        power_user.summary_fallback_tags = normalizedSummaryFallbackTags;
        saveSettingsDebounced();

        wizardState.config = {
            groupName: request.groupName,
            prompt,
            characters: request.characters,
            createLorebook,
            dynamicLorebook,
            minify,
            minifySingleLine,
            summaryFallbackTags: normalizedSummaryFallbackTags,
            fields: selectedFields,
            selectedOptionalFields,
            concurrency,
            postMergeEnabled,
            postMergePrompt,
            postProcessMode,
            cropStrategy,
            cropPadding,
            layout,
            gap,
        };
        wizardState.postProcessMode = postProcessMode;
        wizardState.characterOutputs = [];
        wizardState.results = null;
        wizardState.postProcessResult = null;
        wizardState.serverCreated = false;

        BulkEditOverlay.#wizardGoToStage(popupContent, wizardState, 2);
        popupContent
            .find('#bulk_combine_results_content')
            .html('<p>Generation running… results will appear here.</p>');
        BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, true);

        try {
            const result = await BulkEditOverlay.#runCombineWizardStage1Generation(
                popupContent,
                wizardState,
            );
            wizardState.results = result;
            BulkEditOverlay.#renderStage2Content(popupContent, wizardState);
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
            void getCharacters().catch((error) =>
                console.warn('Failed to refresh characters after generation:', error),
            );
            toastr.success('Generation complete.', 'Combine into Group Card');
        } catch (error) {
            console.error(error);
            popupContent
                .find('#bulk_combine_results_content')
                .html(
                    `<p class="error">Generation failed: ${escapeHtml(error?.message ?? 'Unknown error')}</p>`,
                );
            toastr.error(
                error?.message ?? 'Failed to combine selected characters.',
                'Combine into Group Card',
            );
        } finally {
            BulkEditOverlay.#setCombineWizardNextDisabled(popupContent, false);
        }
    };

    static #buildGroupCardWizardMetadata = (wizardState) => {
        const sourceCharacters =
			BulkEditOverlay.#getWizardSourceCharacters(wizardState);
        const existingMeta = wizardState.rerunConfig?.rerunMeta ?? null;

        return {
            version: 1,
            sourceCharacterNames: sourceCharacters
                .map((character) => getCoreCharacterField(character, 'name').trim())
                .filter(Boolean),
            sourceCharacterAvatars: sourceCharacters
                .map((character) => character.avatar)
                .filter(Boolean),
            config: {
                groupName: wizardState.config?.groupName,
                prompt: wizardState.config?.prompt,
                concurrency: wizardState.config?.concurrency,
                cropStrategy: wizardState.config?.cropStrategy,
                cropPadding: wizardState.config?.cropPadding,
                layout: wizardState.config?.layout,
                gap: wizardState.config?.gap,
                fields: wizardState.config?.fields,
                selectedOptionalFields: wizardState.config?.selectedOptionalFields,
                summaryFallbackTags: wizardState.config?.summaryFallbackTags,
                createLorebook: Boolean(wizardState.config?.createLorebook),
                dynamicLorebook: Boolean(wizardState.config?.dynamicLorebook),
                minify: Boolean(wizardState.config?.minify),
                minifySingleLine: Boolean(wizardState.config?.minifySingleLine),
                postMergeEnabled: Boolean(wizardState.config?.postMergeEnabled),
                postMergePrompt: wizardState.config?.postMergePrompt,
                postProcessMode: wizardState.config?.postProcessMode,
                avatarOffsets: wizardState.avatarOffsets ?? [],
                voronoiSeed: wizardState.voronoiSeed,
            },
            createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            runCount: Number(existingMeta?.runCount ?? 0) + 1,
        };
    };

    static updateGroupCardWizardEditButton = (characterId) => {
        const button = document.getElementById('group_card_wizard_edit_button');
        if (!button) {
            return;
        }

        const character = characters[characterId];
        const hasMetadata = isGroupCardWizardCharacter(character);
        button.style.display = hasMetadata ? '' : 'none';
        button.dataset.characterId = hasMetadata ? String(characterId) : '';
        button.onclick = hasMetadata
            ? async () => {
                await BulkEditOverlay.rerunGroupCardWizard(characterId);
            }
            : null;
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

        try {
            const response = await fetch('/api/characters/group-card-backup', {
                method: 'POST',
                headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ avatar: character.avatar }),
            });
            await throwIfNotOk(response, 'Failed to back up group card.');
        } catch (error) {
            console.warn('Group card backup failed; continuing re-run:', error);
            toastr.warning(
                'Could not back up the current card. Continuing anyway.',
                'Combine into Group Card',
            );
        }

        const sourceCharacterIds = [];
        const sourceAvatars = Array.isArray(meta.sourceCharacterAvatars)
            ? meta.sourceCharacterAvatars
            : [];
        const sourceNames = Array.isArray(meta.sourceCharacterNames)
            ? meta.sourceCharacterNames
            : [];

        for (const avatar of sourceAvatars) {
            const id = characters.findIndex(
                (candidate) => candidate?.avatar === avatar,
            );
            if (id >= 0 && !sourceCharacterIds.includes(id)) {
                sourceCharacterIds.push(id);
            }
        }

        for (const name of sourceNames) {
            const normalizedName = normalizeName(String(name ?? ''));
            const id = characters.findIndex(
                (candidate) =>
                    normalizeName(getCoreCharacterField(candidate, 'name')) ===
					normalizedName,
            );
            if (id >= 0 && !sourceCharacterIds.includes(id)) {
                sourceCharacterIds.push(id);
            }
        }

        await BulkEditOverlay.combineIntoGroupCard(sourceCharacterIds, {
            rerunAvatar: character.avatar,
            rerunMeta: meta,
            groupName: getCoreCharacterField(character, 'name'),
        });
    };

    /**
	 * Opens the combine wizard.
	 *
	 * @param {Array<number|object>} selectedCharacters Selected character ids or objects.
	 * @param {object|null} [rerunConfig] Existing wizard card re-run config.
	 * @returns {Promise<void>}
	 */
    static combineIntoGroupCard = async (
        selectedCharacters,
        rerunConfig = null,
    ) => {
        const selectedCharacterIds =
			BulkEditOverlay.#resolveCombineGroupCardCharacterIds(selectedCharacters);

        await Promise.all(
            selectedCharacterIds
                .filter((id) => characters[id]?.shallow)
                .map((id) => unshallowCharacter(String(id))),
        );
        const validCharacters = getValidSelectedCharacters(
            selectedCharacterIds,
            characters,
        );

        if (validCharacters.length < 2) {
            toastr.warning(
                'Select at least two valid characters.',
                'Combine into Group Card',
            );
            return;
        }

        const wizardHtml = BulkEditOverlay.#getCombineGroupCardWizardHtml(
            validCharacters.length,
        );
        const rerunStoredConfig = rerunConfig?.rerunMeta?.config ?? {};
        /** @type {{stage:number, config:object, selectedCharacterIds:Array<number>, results:unknown, createdArtifacts:{avatar:string, world:string}|null, characterOutputs:Array<object>, mergedXml:string, postProcessResult:unknown, postProcessMode:string, avatarOffsets:Array<object>, avatarUrl:string|null, voronoiSeed:number, rerunConfig?:object|null}} */
        const wizardState = {
            stage: 1,
            config: {
                ...rerunStoredConfig,
                groupName: rerunConfig?.groupName ?? rerunStoredConfig.groupName,
                layout: ['voronoi', 'grid-portrait', 'grid-square'].includes(
                    rerunStoredConfig.layout ?? power_user.group_card_layout,
                )
                    ? (rerunStoredConfig.layout ?? power_user.group_card_layout)
                    : 'voronoi',
                gap: Number.isFinite(
                    Number(rerunStoredConfig.gap ?? power_user.group_card_gap),
                )
                    ? Math.max(
                        0,
                        Math.min(
                            10,
                            Math.round(
                                Number(rerunStoredConfig.gap ?? power_user.group_card_gap),
                            ),
                        ),
                    )
                    : 2,
            },
            selectedCharacterIds,
            results: null,
            createdArtifacts: null,
            characterOutputs: [],
            mergedXml: '',
            postProcessResult: null,
            postProcessMode: 'replace',
            avatarOffsets: Array.isArray(rerunStoredConfig.avatarOffsets)
                ? rerunStoredConfig.avatarOffsets
                : [],
            avatarUrl: null,
            voronoiSeed: Number.isFinite(Number(rerunStoredConfig.voronoiSeed))
                ? Number(rerunStoredConfig.voronoiSeed)
                : Math.floor(Math.random() * 2147483647),
            rerunConfig,
        };

        await callGenericPopup(wizardHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: false,
            cancelButton: false,
            wide: true,
            large: true,
            allowVerticalScrolling: true,
            onOpen: (popup) => {
                const popupContent = $(popup.dlg);
                const groupNameInput = popupContent.find(
                    '#bulk_combine_group_card_name',
                );
                const promptInput = popupContent.find(
                    '#bulk_combine_group_card_prompt',
                );
                const presetSelect = popupContent.find(
                    '#bulk_combine_group_card_preset_select',
                );
                const savePresetButton = popupContent.find(
                    '#bulk_combine_group_card_preset_save',
                );
                const deletePresetButton = popupContent.find(
                    '#bulk_combine_group_card_preset_delete',
                );
                const restorePresetButton = popupContent.find(
                    '#bulk_combine_group_card_preset_restore',
                );
                const fieldToggles = popupContent.find(
                    '#bulk_combine_group_card_field_toggles input[type="checkbox"]',
                );
                const lorebookToggle = popupContent.find(
                    '#bulk_combine_group_card_lorebook_toggle',
                );
                const dynamicLorebookToggle = popupContent.find(
                    '#bulk_combine_group_card_dynamic_lorebook_toggle',
                );
                const minifyToggle = popupContent.find(
                    '#bulk_combine_group_card_minify_toggle',
                );
                const minifySingleLineToggle = popupContent.find(
                    '#bulk_combine_group_card_minify_single_line',
                );
                const minifySingleLineLabel = popupContent.find(
                    '#bulk_combine_minify_single_line_label',
                );
                const concurrencyInput = popupContent.find(
                    '#bulk_combine_group_card_concurrency',
                );
                const cropStrategySelect = popupContent.find(
                    '#bulk_combine_group_card_crop_strategy',
                );
                const cropPaddingInput = popupContent.find(
                    '#bulk_combine_group_card_crop_padding',
                );
                const cropPaddingValue = popupContent.find(
                    '#bulk_combine_group_card_crop_padding_value',
                );
                const layoutSelect = popupContent.find(
                    '#bulk_combine_group_card_layout',
                );
                const gapContainer = popupContent.find('#bulk_combine_gap_container');
                const gapInput = popupContent.find('#bulk_combine_gap');
                const gapValue = popupContent.find('#bulk_combine_gap_value');
                const characterSearchInput = popupContent.find(
                    '#bulk_combine_group_card_search',
                );
                const fallbackTagsInput = popupContent.find(
                    '#bulk_combine_fallback_tags',
                );

                groupNameInput.val(wizardState.config?.groupName ?? '');
                promptInput.val(
                    wizardState.config?.prompt ??
						power_user.group_card_combine_prompt ??
						DEFAULT_GROUP_CARD_COMBINE_PROMPT,
                );
                concurrencyInput.val(
                    Number.isFinite(
                        Number(
                            wizardState.config?.concurrency ??
								power_user.group_card_parallel_concurrency,
                        ),
                    )
                        ? String(
                            wizardState.config?.concurrency ??
									power_user.group_card_parallel_concurrency,
                        )
                        : '10',
                );
                cropStrategySelect.val(
                    ['attention', 'entropy', 'center', 'top', 'face'].includes(
                        wizardState.config?.cropStrategy ??
							power_user.group_card_crop_strategy,
                    )
                        ? (wizardState.config?.cropStrategy ??
								power_user.group_card_crop_strategy)
                        : 'attention',
                );
                const persistedCropPadding = Number(
                    wizardState.config?.cropPadding ?? power_user.group_card_crop_padding,
                );
                const cropPadding = Number.isFinite(persistedCropPadding)
                    ? Math.max(0, Math.min(50, Math.round(persistedCropPadding)))
                    : 15;
                cropPaddingInput.val(String(cropPadding));
                cropPaddingValue.text(String(cropPadding));
                const persistedLayout = [
                    'voronoi',
                    'grid-portrait',
                    'grid-square',
                ].includes(wizardState.config?.layout ?? power_user.group_card_layout)
                    ? (wizardState.config?.layout ?? power_user.group_card_layout)
                    : 'voronoi';
                const persistedGap = Number(
                    wizardState.config?.gap ?? power_user.group_card_gap,
                );
                const gap = Number.isFinite(persistedGap)
                    ? Math.max(0, Math.min(10, Math.round(persistedGap)))
                    : 2;
                layoutSelect.val(persistedLayout);
                gapInput.val(String(gap));
                gapValue.text(String(gap));
                gapContainer.toggle(persistedLayout !== 'voronoi');
                const fallbackTags = Array.isArray(
                    wizardState.config?.summaryFallbackTags,
                )
                    ? wizardState.config.summaryFallbackTags
                    : Array.isArray(power_user.summary_fallback_tags)
                        ? power_user.summary_fallback_tags
                        : ['summary'];
                fallbackTagsInput.val(fallbackTags.join(', '));
                wizardState.config.layout = persistedLayout;
                wizardState.config.gap = gap;
                wizardState.config.summaryFallbackTags = fallbackTags;
                lorebookToggle
                    .prop('checked', Boolean(wizardState.config?.createLorebook))
                    .prop('disabled', Boolean(wizardState.config?.dynamicLorebook));
                dynamicLorebookToggle
                    .prop('checked', Boolean(wizardState.config?.dynamicLorebook))
                    .prop('disabled', Boolean(wizardState.config?.createLorebook));
                minifyToggle.prop('checked', Boolean(wizardState.config?.minify));
                minifySingleLineToggle.prop(
                    'checked',
                    Boolean(wizardState.config?.minifySingleLine),
                );
                minifySingleLineLabel.toggle(Boolean(wizardState.config?.minify));
                renderGroupCardCombinePromptPresetSelect(presetSelect);

                const persistedFields = Array.isArray(
                    wizardState.config?.selectedOptionalFields,
                )
                    ? wizardState.config.selectedOptionalFields
                    : Array.isArray(wizardState.config?.fields)
                        ? wizardState.config.fields.filter((field) =>
                            OPTIONAL_CHARACTER_FIELDS.includes(field),
                        )
                        : Array.isArray(power_user.group_card_combine_included_fields)
                            ? power_user.group_card_combine_included_fields
                            : ['personality'];
                const persistedFieldSet = new Set(persistedFields);
                fieldToggles.each((_, element) => {
                    $(element).prop(
                        'checked',
                        persistedFieldSet.has(String($(element).data('field') ?? '')),
                    );
                });

                characterSearchInput.on('input', () => {
                    BulkEditOverlay.#renderCombineGroupCardCharacterLists(
                        popupContent,
                        wizardState.selectedCharacterIds,
                    );
                });
                BulkEditOverlay.#renderCombineGroupCardCharacterLists(
                    popupContent,
                    wizardState.selectedCharacterIds,
                );

                cropPaddingInput.on('input', () => {
                    cropPaddingValue.text(String(cropPaddingInput.val() ?? '15'));
                });

                layoutSelect.on('change', () => {
                    gapContainer.toggle(
                        String(layoutSelect.val() ?? 'voronoi') !== 'voronoi',
                    );
                });

                gapInput.on('input', () => {
                    gapValue.text(String(gapInput.val() ?? '2'));
                });

                fallbackTagsInput.on('change', function () {
                    const tags = String($(this).val() ?? '')
                        .split(',')
                        .map((tag) => tag.trim())
                        .filter(Boolean);
                    wizardState.config.summaryFallbackTags =
						tags.length > 0 ? tags : ['summary'];
                });

                dynamicLorebookToggle.on('change', function () {
                    if ($(this).prop('checked')) {
                        lorebookToggle.prop('checked', false).prop('disabled', true);
                    } else {
                        lorebookToggle.prop('disabled', false);
                    }
                });

                lorebookToggle.on('change', function () {
                    if ($(this).prop('checked')) {
                        dynamicLorebookToggle.prop('checked', false).prop('disabled', true);
                    } else {
                        dynamicLorebookToggle.prop('disabled', false);
                    }
                });

                minifyToggle.on('change', function () {
                    const enabled = Boolean($(this).prop('checked'));
                    minifySingleLineLabel.toggle(enabled);
                    if (!enabled) {
                        minifySingleLineToggle.prop('checked', false);
                    }
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
                    const currentPreset =
						getGroupCardCombinePromptPresets()[currentIndex];
                    const presetName = await callGenericPopup(
                        'Enter a prompt preset name:',
                        POPUP_TYPE.INPUT,
                        currentPreset?.name ?? '',
                        {
                            okButton: 'Save',
                            cancelButton: 'Cancel',
                        },
                    );

                    if (!presetName) {
                        return;
                    }

                    const savedPreset = await saveGroupCardCombinePromptPreset(
                        String(presetName),
                        String(promptInput.val() ?? ''),
                    );

                    if (!savedPreset) {
                        return;
                    }

                    const savedIndex = findGroupCardCombinePromptPresetIndex(
                        savedPreset.name,
                    );
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

                popupContent.find('#bulk_combine_wizard_back').on('click', () => {
                    if (wizardState.stage > 1) {
                        BulkEditOverlay.#wizardGoToStage(
                            popupContent,
                            wizardState,
                            wizardState.stage - 1,
                        );
                    }
                });

                popupContent
                    .find('#bulk_combine_wizard_cancel')
                    .on('click', async () => {
                        // Cancel any running server-side job
                        const activeJobId = sessionStorage.getItem(
                            GROUP_CARD_JOB_SESSION_KEY,
                        );
                        if (activeJobId) {
                            sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                            await BulkEditOverlay.#cancelGroupCardJob(String(activeJobId));
                            BulkEditOverlay.#removeGroupCardJob(String(activeJobId));
                        }

                        // Rollback created artifacts if we reached stage 4
                        if (wizardState.stage >= 4 && wizardState.createdArtifacts) {
                            const { avatar, world } = wizardState.createdArtifacts;
                            const groupName = String(
                                wizardState.config?.groupName ?? '',
                            ).trim();
                            if (world) {
                                await rollbackGeneratedLorebook(groupName);
                            }
                            if (avatar && groupName) {
                                await rollbackGeneratedCharacter(groupName, avatar);
                            }
                        }

                        popup.completeCancelled();
                    });

                popupContent
                    .find('#bulk_combine_wizard_save_as_is')
                    .on('click', async () => {
                        if (
                            await BulkEditOverlay.#handleStage2SaveAsIs(
                                popupContent,
                                wizardState,
                            )
                        ) {
                            await popup.completeAffirmative();
                        }
                    });

                popupContent.find('#bulk_combine_wizard_next').on('click', async () => {
                    switch (wizardState.stage) {
                        case 1:
                            await BulkEditOverlay.#handleCombineWizardStage1Next(
                                popupContent,
                                wizardState,
                            );
                            break;
                        case 2:
                            BulkEditOverlay.#updateWizardMergedXml(wizardState);
                            if (
                                !wizardState.characterOutputs
                                    .filter(Boolean)
                                    .some((output) => output.parseStatus === 'ok')
                            ) {
                                toastr.warning(
                                    'At least one valid output required.',
                                    'Combine into Group Card',
                                );
                                return;
                            }
                            if (
                                popupContent
                                    .find('#bulk_combine_skip_postprocess')
                                    .prop('checked')
                            ) {
                                wizardState.postProcessResult = wizardState.mergedXml;
                                wizardState.postProcessMode = 'replace';
                                BulkEditOverlay.#wizardGoToStage(popupContent, wizardState, 4);
                                BulkEditOverlay.#renderStage4Content(popupContent, wizardState);
                                break;
                            }
                            BulkEditOverlay.#wizardGoToStage(popupContent, wizardState, 3);
                            BulkEditOverlay.#renderStage3Content(popupContent, wizardState);
                            break;
                        case 3:
                            if (!wizardState.postProcessResult) {
                                toastr.warning(
                                    'Apply post-processing first.',
                                    'Combine into Group Card',
                                );
                                return;
                            }
                            BulkEditOverlay.#wizardGoToStage(popupContent, wizardState, 4);
                            BulkEditOverlay.#renderStage4Content(popupContent, wizardState);
                            break;
                        case 4:
                            if (
                                await BulkEditOverlay.#handleStage4Create(
                                    popupContent,
                                    wizardState,
                                )
                            ) {
                                await popup.completeAffirmative();
                            }
                            break;
                    }
                });

                BulkEditOverlay.#wizardGoToStage(popupContent, wizardState, 1);
                groupNameInput.trigger('focus');
            },
        });
    };

    /**
	 * Safely clones settings for server-side generation config.
	 * @param {object} value Settings object.
	 * @returns {object} Clone.
	 */
    static #cloneGroupCardJobSettings = (value) => {
        try {
            return structuredClone(value ?? {});
        } catch {
            return JSON.parse(JSON.stringify(value ?? {}));
        }
    };

    /**
	 * Builds LLM config snapshot for a server-side group card job.
	 * @returns {object} LLM config.
	 */
    static #getGroupCardJobLlmConfig = () => {
        return {
            type: main_api,
            amount_gen,
            max_context,
            openai: BulkEditOverlay.#cloneGroupCardJobSettings(oai_settings),
            textgenerationwebui: BulkEditOverlay.#cloneGroupCardJobSettings(
                textgenerationwebui_settings,
            ),
            novelai: BulkEditOverlay.#cloneGroupCardJobSettings(nai_settings),
            kobold: BulkEditOverlay.#cloneGroupCardJobSettings(kai_settings),
            horde: BulkEditOverlay.#cloneGroupCardJobSettings(horde_settings),
        };
    };

    /**
	 * Checks whether the current API can be used by the server-side group-card job runner.
	 * @returns {boolean} True when server-side jobs can call the current API directly.
	 */
    static #canUseServerGroupCardJob = () =>
        ['openai', 'textgenerationwebui'].includes(main_api);

    /**
	 * Builds a server-side group card job config.
	 * @param {string} groupName Group card name.
	 * @param {string} prompt Main prompt.
	 * @param {Array<object>} selectedCharacters Source characters.
	 * @param {boolean} createLorebook Whether to create lorebook.
	 * @param {Array<string>} fields Included fields.
	 * @param {number} concurrency Parallel concurrency.
	 * @param {boolean} postMergeEnabled Whether post-merge runs.
	 * @param {string} postMergePrompt Post-merge prompt.
	 * @param {string} cropStrategy Crop strategy.
	 * @param {number} cropPadding Crop padding.
	 * @param {string} [postProcessMode] Post-process mode.
	 * @param {boolean} [dynamicLorebook] Whether to use dynamic lorebook output.
	 * @param {boolean} [minify] Whether to minify final XML output.
	 * @param {boolean} [minifySingleLine] Whether to minify final XML to one line.
	 * @returns {object} Job config.
	 */
    static #buildGroupCardJobConfig = (
        groupName,
        prompt,
        selectedCharacters,
        createLorebook,
        fields,
        concurrency,
        postMergeEnabled,
        postMergePrompt,
        cropStrategy,
        cropPadding,
        postProcessMode = 'replace',
        dynamicLorebook = false,
        minify = false,
        minifySingleLine = false,
    ) => ({
        groupName,
        prompt,
        characters: selectedCharacters.map((character) => ({
            name: getCoreCharacterField(character, 'name'),
            description: getCoreCharacterField(character, 'description'),
            personality: getCoreCharacterField(character, 'personality'),
            scenario: getCoreCharacterField(character, 'scenario'),
            first_mes: getCoreCharacterField(character, 'first_mes'),
            mes_example: getCoreCharacterField(character, 'mes_example'),
            avatar: character?.avatar ?? '',
        })),
        fields,
        processingMode: 'parallel',
        concurrency,
        postMergeEnabled,
        postMergePrompt,
        postProcessMode: ['replace', 'prepend', 'append'].includes(postProcessMode)
            ? postProcessMode
            : 'replace',
        avatarOffsets: [],
        createLorebook,
        dynamicLorebook: Boolean(dynamicLorebook),
        minify: Boolean(minify),
        minifySingleLine: Boolean(minifySingleLine),
        cropStrategy,
        cropPadding,
        llm: BulkEditOverlay.#getGroupCardJobLlmConfig(),
    });

    /**
	 * Cancels a server-side group card job.
	 * @param {string} jobId Job ID.
	 * @returns {Promise<void>}
	 */
    static #cancelGroupCardJob = async (jobId) => {
        if (!jobId) {
            return;
        }

        await fetch(
            `/api/characters/group-card-job/${encodeURIComponent(jobId)}/cancel`,
            {
                method: 'POST',
                headers: getRequestHeaders(),
            },
        );
        sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
    };

    static #updateGroupCardJobStatus = (jobId, status) => {
        const job = groupCardJobs.get(jobId);
        if (!job) {
            return;
        }

        job.status = status;
        BulkEditOverlay.#renderGroupCardJobIndicator();
    };

    static #removeGroupCardJob = (jobId) => {
        groupCardJobs.delete(jobId);
        BulkEditOverlay.#renderGroupCardJobIndicator();
    };

    static #renderGroupCardJobIndicator = () => {
        let indicator = document.getElementById('bulk_group_card_job_indicator');
        const count = groupCardJobs.size;

        if (!indicator) {
            indicator = document.createElement('div');
            indicator.id = 'bulk_group_card_job_indicator';
            indicator.style.cssText =
				'position:fixed;bottom:1em;right:1em;z-index:9999;background:var(--SmartThemeBodyColor);border:1px solid var(--SmartThemeBorderColor);border-radius:8px;padding:0.5em 1em;cursor:pointer;display:none;align-items:center;gap:0.5em;font-size:0.85em;';
            document.body.appendChild(indicator);

            indicator.addEventListener('click', async () => {
                if (groupCardJobs.size > 0) {
                    BulkEditOverlay.#showGroupCardJobPopup();
                }
            });
        }

        indicator.style.display = 'flex';
        const icon = document.createElement('i');

        if (!count) {
            indicator.style.display = 'none';
            return;
        }

        const jobs = [...groupCardJobs.values()];
        const latest = jobs[jobs.length - 1];
        const elapsed = Math.floor((Date.now() - latest.startedAt) / 1000);
        icon.className = 'fa-solid fa-wand-magic-sparkles';
        indicator.replaceChildren(icon);

        if (count > 1) {
            const badge = document.createElement('span');
            badge.textContent = String(count);
            badge.style.cssText =
				'background:var(--SmartThemeQuoteColor);color:var(--SmartThemeBodyColor);border-radius:50%;width:1.2em;height:1.2em;display:inline-flex;align-items:center;justify-content:center;font-size:0.75em;';
            indicator.appendChild(badge);
        }

        const status = document.createElement('span');
        status.textContent = `${latest.status} (${elapsed}s)`;
        indicator.appendChild(status);
    };

    static #showGroupCardJobPopup = () => {
        const jobs = [...groupCardJobs.values()];
        if (!jobs.length) {
            return;
        }

        const content = $('<div></div>');
        content.append($('<h4></h4>').text('Background Jobs'));
        const newCardButton = $('<div></div>')
            .addClass('menu_button')
            .css({ marginBottom: '0.5em' })
            .append($('<i></i>').addClass('fa-solid fa-layer-group'))
            .append(' New Group Card');
        newCardButton.on('click', async () => {
            content.closest('.popup').remove();
            const selectedCharacters =
				bulkEditOverlayInstance?.selectedCharacters?.slice?.() ?? [];
            await BulkEditOverlay.combineIntoGroupCard(selectedCharacters);
        });
        content.append(newCardButton);
        const list = $('<div></div>').css({ marginTop: '0.5em' });

        for (const job of jobs) {
            const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
            const row = $('<div></div>')
                .addClass('flex-container alignitemscenter')
                .css({ gap: '1em', padding: '0.5em 0' });
            row.append($('<span></span>').text(job.groupName));
            row.append($('<small></small>').text(`${job.status} · ${elapsed}s`));
            const cancelButton = $('<div></div>')
                .addClass('menu_button')
                .css({ marginLeft: 'auto' })
                .append($('<i></i>').addClass('fa-solid fa-xmark'))
                .append(' Cancel');

            cancelButton.on('click', async () => {
                await BulkEditOverlay.#cancelGroupCardJob(job.jobId);
                job.loaderHandle?.hide();
                job.source?.close();
                BulkEditOverlay.#removeGroupCardJob(job.jobId);
                content.closest('.popup').remove();
            });

            row.append(cancelButton);
            list.append(row);
        }

        content.append(list);
        callGenericPopup(content, POPUP_TYPE.DISPLAY, '', {
            okButton: 'Close',
            wide: false,
        });
    };

    /**
	 * Connects to group card job SSE and resolves on completion.
	 * @param {string} jobId Job ID.
	 * @param {import('./action-loader.js').ActionLoaderHandle} loaderHandle Loader handle.
	 * @param {number} characterCount Character count.
	 * @param {(value: unknown) => void} resolve Promise resolver.
	 * @param {(reason?: unknown) => void} reject Promise rejecter.
	 * @returns {EventSource} EventSource connection.
	 */
    static #connectGroupCardJobEvents = (
        jobId,
        loaderHandle,
        characterCount,
        resolve,
        reject,
    ) => {
        const source = new EventSource(
            `/api/characters/group-card-job/${encodeURIComponent(jobId)}/events`,
        );
        let completed = false;
        let completedCount = 0;
        const parseEvent = (event) => JSON.parse(event.data || '{}');

        source.addEventListener('job_started', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'started');
            loaderHandle.setMessage(t`Server-side group card generation started…`);
        });
        source.addEventListener('character_started', (event) => {
            const data = parseEvent(event);
            const index = Number(data.index ?? 0) + 1;
            const total = Number(data.total ?? data.count ?? characterCount) || '?';
            BulkEditOverlay.#updateGroupCardJobStatus(
                jobId,
                `Processing ${index}/${total}`,
            );
            loaderHandle.setMessage(
                `Processing character ${index}/${total}: ${data.name ?? ''}…`,
            );
        });
        source.addEventListener('character_completed', (event) => {
            const data = parseEvent(event);
            const total = Number(data.total ?? data.count ?? characterCount) || '?';
            completedCount++;
            BulkEditOverlay.#updateGroupCardJobStatus(
                jobId,
                `Completed ${completedCount}/${total}`,
            );
            loaderHandle.setMessage(
                `Completed character ${completedCount}/${total}…`,
            );
        });
        source.addEventListener('character_failed', (event) => {
            const data = parseEvent(event);
            completedCount++;
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Character failed');
            loaderHandle.setMessage(
                `Character failed: ${data.name ?? 'unknown'}. Continuing…`,
            );
        });
        source.addEventListener('merge_started', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Merging');
            loaderHandle.setMessage(t`Merging transformed character definitions…`);
        });
        source.addEventListener('merge_completed', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Merged');
            loaderHandle.setMessage(t`Merged character definitions.`);
        });
        source.addEventListener('post_merge_started', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Post-merge');
            loaderHandle.setMessage(t`Running universal post-merge step…`);
        });
        source.addEventListener('post_merge_completed', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Post-merge done');
            loaderHandle.setMessage(t`Universal post-merge step completed…`);
        });
        source.addEventListener('avatar_started', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Avatar');
            loaderHandle.setMessage(t`Generating group card avatar…`);
        });
        source.addEventListener('avatar_completed', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Avatar done');
            loaderHandle.setMessage(t`Group card avatar generated…`);
        });
        source.addEventListener('card_created', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Card created');
            loaderHandle.setMessage(t`Group card created…`);
        });
        source.addEventListener('lorebook_created', () => {
            BulkEditOverlay.#updateGroupCardJobStatus(jobId, 'Lorebook linked');
            loaderHandle.setMessage(t`Lorebook linked…`);
        });
        source.addEventListener('job_completed', (event) => {
            completed = true;
            const data = parseEvent(event);
            sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
            BulkEditOverlay.#removeGroupCardJob(jobId);
            source.close();
            resolve(data);
        });
        source.addEventListener('job_failed', (event) => {
            completed = true;
            const data = parseEvent(event);
            sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
            BulkEditOverlay.#removeGroupCardJob(jobId);
            source.close();
            reject(
                new Error(data.error || 'Server-side group card generation failed.'),
            );
        });
        source.onerror = () => {
            if (!completed) {
                loaderHandle.setMessage(
                    t`Connection lost. Reconnecting to server job…`,
                );
            }
        };

        return source;
    };

    /**
	 * Runs legacy client-side generation as fallback when server jobs are unavailable.
	 * @param {string} groupName Requested group card name.
	 * @param {string} prompt Saved combine prompt.
	 * @param {Array<object>} selectedCharacters Valid selected characters.
	 * @param {boolean} [createLorebook] Whether to create and link a lorebook.
	 * @param {Array<string>} [fields] Included core fields.
	 * @param {string} [cropStrategy] Avatar crop strategy.
	 * @param {number} [cropPadding] Avatar crop padding percentage.
	 * @returns {Promise<unknown>} Generation result.
	 */
    static #runClientGroupCardCombinePipeline = async (
        groupName,
        prompt,
        selectedCharacters,
        createLorebook = true,
        fields,
        cropStrategy = 'attention',
        cropPadding = 15,
    ) => {
        const quiet_prompt = buildGroupCardCombineQuietPrompt(
            prompt,
            selectedCharacters,
            fields,
        );
        const generatedDescription = String(
            (await generateQuietPrompt({
                quietPrompt: quiet_prompt,
                quietToLoud: true,
                skipWIAN: true,
            })) ?? '',
        );
        const validatedDescription = validateGeneratedGroupCardDescription(
            generatedDescription,
            selectedCharacters.length,
        );
        const result = await createGeneratedGroupCard(
            groupName,
            validatedDescription,
            selectedCharacters,
            createLorebook,
            fields,
            false,
            validatedDescription,
            null,
            wizardState.config?.minify ?? false,
            wizardState.config?.minifySingleLine ?? false,
        );

        try {
            const avatarFilenames = selectedCharacters
                .map((character) => character.avatar)
                .filter(Boolean);
            if (avatarFilenames.length > 0) {
                const compositeResponse = await fetch(
                    '/api/characters/generate-voronoi-composite',
                    {
                        method: 'POST',
                        headers: {
                            ...getRequestHeaders(),
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            avatars: avatarFilenames,
                            cropStrategy,
                            cropPadding,
                        }),
                    },
                );

                if (compositeResponse.ok) {
                    const { image } = await compositeResponse.json();
                    if (image) {
                        const imageResponse = await fetch(image);
                        if (imageResponse.ok) {
                            const imageBlob = await imageResponse.blob();
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
    };

    /**
	 * Starts group card generation pipeline.
	 *
	 * @param {string} groupName Requested group card name.
	 * @param {string} prompt Saved combine prompt.
	 * @param {Array<object>} selectedCharacters Valid selected characters.
	 * @param {boolean} [createLorebook] Whether to create and link a lorebook.
	 * @param {Array<string>} [fields] Included core fields.
	 * @param {number} [concurrency] Parallel concurrency.
	 * @param {boolean} [postMergeEnabled] Whether to run post-merge.
	 * @param {string} [postMergePrompt] Post-merge prompt.
	 * @param {string} [cropStrategy] Avatar crop strategy.
	 * @param {number} [cropPadding] Avatar crop padding percentage.
	 * @returns {Promise<unknown>} Generation result.
	 */
    static #startGroupCardCombinePipeline = async (
        groupName,
        prompt,
        selectedCharacters,
        createLorebook = true,
        fields,
        concurrency = 10,
        postMergeEnabled = true,
        postMergePrompt = DEFAULT_POST_MERGE_PROMPT,
        cropStrategy = 'attention',
        cropPadding = 15,
    ) => {
        if (!BulkEditOverlay.#canUseServerGroupCardJob()) {
            return await BulkEditOverlay.#runClientGroupCardCombinePipeline(
                groupName,
                prompt,
                selectedCharacters,
                createLorebook,
                fields,
                cropStrategy,
                cropPadding,
            );
        }

        const config = BulkEditOverlay.#buildGroupCardJobConfig(
            groupName,
            prompt,
            selectedCharacters,
            createLorebook,
            fields,
            concurrency,
            postMergeEnabled,
            postMergePrompt,
            cropStrategy,
            cropPadding,
        );
        let jobEventSource = null;
        let jobId = '';
        let cancelRequested = false;
        const loaderHandle = loader.show({
            slug: 'combine-group-card',
            title: t`Combine into Group Card`,
            message: t`Starting server-side generation for "${groupName}"…`,
            blocking: false,
            toastMode: loader.ToastMode.STOPPABLE,
            stopTooltip: t`Cancel`,
            onStop: async () => {
                cancelRequested = true;
                jobEventSource?.close();

                if (jobId) {
                    await BulkEditOverlay.#cancelGroupCardJob(jobId);
                    BulkEditOverlay.#removeGroupCardJob(jobId);
                }

                await loaderHandle.hide();
            },
        });

        try {
            const jobResponse = await fetch('/api/characters/group-card-job', {
                method: 'POST',
                headers: {
                    ...getRequestHeaders(),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ config }),
            });

            if (jobResponse.status === 404) {
                console.warn(
                    'Server group-card job endpoint unavailable; falling back to client-driven generation.',
                );
                loaderHandle.setMessage(
                    t`Server job endpoint unavailable. Using local generation…`,
                );
                return await BulkEditOverlay.#runClientGroupCardCombinePipeline(
                    groupName,
                    prompt,
                    selectedCharacters,
                    createLorebook,
                    fields,
                    cropStrategy,
                    cropPadding,
                );
            }

            await throwIfNotOk(
                jobResponse,
                'Failed to start server-side group card generation.',
            );
            const jobData = await jobResponse.json();
            jobId = String(jobData.jobId ?? jobData.id ?? '');

            if (!jobId) {
                throw new Error('Server did not return a group card job ID.');
            }

            sessionStorage.setItem(GROUP_CARD_JOB_SESSION_KEY, jobId);
            const SSE_TIMEOUT_MS = 5 * 60 * 1000;
            const result = await Promise.race([
                new Promise((resolve, reject) => {
                    jobEventSource = BulkEditOverlay.#connectGroupCardJobEvents(
                        jobId,
                        loaderHandle,
                        selectedCharacters.length,
                        resolve,
                        reject,
                    );
                    groupCardJobs.set(jobId, {
                        jobId,
                        groupName,
                        loaderHandle,
                        source: jobEventSource,
                        startedAt: Date.now(),
                        status: 'running',
                    });
                    BulkEditOverlay.#renderGroupCardJobIndicator();
                }),
                new Promise((_, reject) =>
                    setTimeout(
                        () =>
                            reject(
                                new Error('Group card generation timed out after 5 minutes.'),
                            ),
                        SSE_TIMEOUT_MS,
                    ),
                ),
            ]);

            sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
            return result;
        } catch (error) {
            if (cancelRequested) {
                throw new Error('Group card generation cancelled.');
            }

            throw error;
        } finally {
            jobEventSource?.close();
            await loaderHandle.hide();
        }
    };

    /**
	 * Reconnects to an existing server-side group card job from session storage.
	 * @returns {Promise<void>}
	 */
    static reconnectGroupCardJob = async () => {
        const jobId = sessionStorage.getItem(GROUP_CARD_JOB_SESSION_KEY);
        if (!jobId) {
            BulkEditOverlay.#renderGroupCardJobIndicator();
            return;
        }

        try {
            const statusResponse = await fetch(
                `/api/characters/group-card-job/${encodeURIComponent(jobId)}`,
                { headers: getRequestHeaders() },
            );

            if (!statusResponse.ok) {
                sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                BulkEditOverlay.#renderGroupCardJobIndicator();
                return;
            }

            const status = await statusResponse.json();
            if (!['pending', 'running'].includes(status.status)) {
                sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
                BulkEditOverlay.#renderGroupCardJobIndicator();
                return;
            }

            let jobEventSource = null;
            const loaderHandle = loader.show({
                slug: 'combine-group-card',
                title: t`Combine into Group Card`,
                message: t`Reconnecting to server-side group card generation…`,
                toastMode: loader.ToastMode.STOPPABLE,
                stopTooltip: t`Cancel`,
                onStop: async () => {
                    jobEventSource?.close();
                    await BulkEditOverlay.#cancelGroupCardJob(jobId);
                    BulkEditOverlay.#removeGroupCardJob(jobId);
                    await loaderHandle.hide();
                },
            });

            try {
                await new Promise((resolve, reject) => {
                    jobEventSource = BulkEditOverlay.#connectGroupCardJobEvents(
                        jobId,
                        loaderHandle,
                        Number(status.progress?.characterCount ?? 0),
                        resolve,
                        reject,
                    );
                    groupCardJobs.set(jobId, {
                        jobId,
                        groupName: String(status.config?.groupName ?? 'Group card'),
                        loaderHandle,
                        source: jobEventSource,
                        startedAt: Number(status.createdAt ?? Date.now()),
                        status: String(status.progress?.step ?? status.status ?? 'running'),
                    });
                    BulkEditOverlay.#renderGroupCardJobIndicator();
                });
                await getCharacters();
                toastr.success('Group card generation completed.');
            } finally {
                jobEventSource?.close();
                await loaderHandle.hide();
            }
        } catch (error) {
            console.warn('Failed to reconnect to group card job:', error);
            sessionStorage.removeItem(GROUP_CARD_JOB_SESSION_KEY);
            BulkEditOverlay.#renderGroupCardJobIndicator();
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

eventSource.on(event_types.CHARACTER_EDITOR_OPENED, (characterId) => {
    BulkEditOverlay.updateGroupCardWizardEditButton(characterId);
});

setTimeout(() => {
    BulkEditOverlay.reconnectGroupCardJob().catch((error) =>
        console.warn('Failed to restore group card job:', error),
    );
}, 0);

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
    buildDynamicLorebookData,
    buildDynamicSummaryDescription,
    getGroupCardCombinePromptPresets,
    findGroupCardCombinePromptPresetIndex,
    saveGroupCardCombinePromptPreset,
    deleteGroupCardCombinePromptPreset,
    getGroupCardPostMergePromptPresets,
    findGroupCardPostMergePromptPresetIndex,
    saveGroupCardPostMergePromptPreset,
    deleteGroupCardPostMergePromptPreset,
    createGeneratedGroupCard,
    groupCardJobs,
};
