'use strict';

/**
 * @file Public entry point for the durable Bulk Card Combine task wizard.
 */

import { characters } from '../../script.js';
import {
    getCharacterName,
    getCoreCharacterPayload,
} from './helpers.js';
import { createTaskClient } from './services/TaskClient.js';
import { openTaskWizard } from './wizard/TaskWizardController.js';

// Re-export helpers --------------------------------------------------

export {
    CORE_CHARACTER_FIELDS,
    ALWAYS_INCLUDED_CHARACTER_FIELDS,
    OPTIONAL_CHARACTER_FIELDS,
    GROUP_CARD_WIZARD_METADATA_KEY,
    getGroupCardWizardMetadata,
    normalizeSelectedFields,
    normalizeName,
    getCharacterName,
    getValidSelectedCharacters,
    getCoreCharacterField,
    getCoreCharacterPayload,
    buildCoreCharacterPromptBlock,
    buildGroupCardCombineQuietPrompt,
    formatLorebookSummaryField,
    buildLorebookEntryContent,
    buildLorebookEntry,
    buildLorebookData,
    extractAllTopLevelXmlBlocks,
    extractCharacterNameFromBlock,
    extractGeneratedCharacterBlocks,
    buildDynamicLorebookData,
    buildDynamicSummaryDescription,
    validateGroupCardRequest,
} from './helpers.js';

// Re-export services -------------------------------------------------

export { sendJsonRequest, throwIfNotOk } from './services/JobClient.js';

export {
    createGeneratedGroupCard,
    rollbackGeneratedLorebook,
    rollbackGeneratedCharacter,
    readCreatedCharacterAvatar,
} from './services/CardCreator.js';

export { TaskWizardController } from './wizard/TaskWizardController.js';
export { TaskWizardState, computePageStates, TASK_WIZARD_PAGES } from './wizard/TaskWizardState.js';

/**
 * Initialize bulk-combine wiring.
 *
 * @returns {void}
 */
export function initBulkCombine() {}

/**
 * Builds a display name for a new durable task.
 *
 * @param {number[]} validIds Valid selected character ids.
 * @param {object} [rerunConfig] Optional re-run configuration.
 * @returns {string} Task name.
 */
function resolveTaskName(validIds, rerunConfig) {
    if (rerunConfig?.groupName != null) {
        return String(rerunConfig.groupName);
    }
    const names = validIds
        .map((id) => getCharacterName(characters[id]))
        .filter(Boolean);
    return names.length > 0 ? names.join(' + ') : 'Untitled task';
}

/**
 * Maps legacy re-run config onto durable task settings and prompts.
 *
 * @param {object} [rerunConfig] Optional re-run configuration.
 * @returns {{settings: object, prompts: object}} Settings/prompts patch fragments.
 */
function seedTaskConfigFromRerun(rerunConfig) {
    const config = rerunConfig?.rerunMeta?.config ?? rerunConfig?.config ?? {};
    const settings = {};
    const prompts = {};

    if (typeof config.prompt === 'string' && config.prompt.trim()) {
        prompts.main = { text: config.prompt };
    }
    if (config.createLorebook || config.dynamicLorebook) {
        settings.destination = 'lorebook';
    }
    if (config.postMergeEnabled) {
        settings.postProcessingEnabled = true;
        if (typeof config.postMergePrompt === 'string' && config.postMergePrompt.trim()) {
            prompts.post = { text: config.postMergePrompt };
        }
    }
    if (config.minify) {
        settings.xmlEnabled = true;
        settings.xmlMinify = true;
    }
    return { settings, prompts };
}

/**
 * Creates a durable server task seeded from selected characters.
 *
 * @param {number[]} selectedCharacterIds Selected character ids.
 * @param {object} [rerunConfig] Optional re-run configuration.
 * @returns {Promise<{task: object, client: import('./services/TaskClient.js').TaskClient}>} Created task and client.
 */
async function createTaskForSelection(selectedCharacterIds, rerunConfig) {
    const client = createTaskClient();
    const validIds = (selectedCharacterIds ?? []).filter((id) => characters[id]);
    const task = await client.createTask({ name: resolveTaskName(validIds, rerunConfig) });
    const sources = validIds.map((id) => {
        const character = characters[id];
        return {
            key: String(character.avatar ?? `character-${id}`),
            name: getCharacterName(character),
            avatar: String(character.avatar ?? ''),
            fields: getCoreCharacterPayload(character),
        };
    });
    const { settings, prompts } = seedTaskConfigFromRerun(rerunConfig);
    const seeded = await client.patchTask(task.id, { sources, settings, prompts });
    return { task: seeded, client };
}

/**
 * Create and open a durable combine task for the selected characters.
 *
 * @param {number[]} selectedCharacterIds Selected character ids.
 * @param {object} [rerunConfig] Optional legacy configuration to seed.
 * @returns {Promise<void>} Resolves when the task wizard closes.
 */
export async function openCombineWizard(selectedCharacterIds, rerunConfig) {
    const validIds = (selectedCharacterIds ?? []).filter((id) => characters[id]);
    if (validIds.length < 2) {
        globalThis.toastr?.warning?.(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );
        return;
    }

    const { task, client } = await createTaskForSelection(validIds, rerunConfig);
    await openTaskWizard(task, { client });
}
