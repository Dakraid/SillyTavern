'use strict';

/**
 * @file Public entry point for the durable Bulk Card Combine task wizard.
 */

import { characters, unshallowCharacter } from '../../script.js';
import {
    getCharacterName,
    getCoreCharacterPayload,
} from './helpers.js';
import { createTaskClient } from './services/TaskClient.js';
import { withResolvedWindowPersistence } from './services/resolveCompletionSettings.js';
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
 * @returns {string} Task name.
 */
function resolveTaskName(validIds) {
    const names = validIds
        .map((id) => getCharacterName(characters[id]))
        .filter(Boolean);
    return names.length > 0 ? names.join(' + ') : 'Untitled task';
}

/**
 * Creates a durable server task seeded from selected characters.
 *
 * Each character is unshallowed BEFORE its core payload is snapshotted:
 * with `performance.lazyLoadCharacters` enabled, shallow roster entries
 * carry empty description/personality/scenario/first_mes/mes_example, which
 * would otherwise produce empty durable source snapshots (and empty
 * generation prompts). `unshallowCharacter` is a no-op for non-shallow
 * characters.
 *
 * @param {number[]} selectedCharacterIds Selected character ids.
 * @returns {Promise<{task: object, client: import('./services/TaskClient.js').TaskClient}>} Created task and client.
 */
async function createTaskForSelection(selectedCharacterIds) {
    const client = withResolvedWindowPersistence(createTaskClient());
    const validIds = (selectedCharacterIds ?? []).filter((id) => characters[id]);
    for (const id of validIds) {
        await unshallowCharacter(id);
    }
    const task = await client.createTask({ name: resolveTaskName(validIds) });
    const sources = validIds.map((id) => {
        const character = characters[id];
        return {
            key: String(character.avatar ?? `character-${id}`),
            name: getCharacterName(character),
            avatar: String(character.avatar ?? ''),
            fields: getCoreCharacterPayload(character),
        };
    });
    const seeded = await client.patchTask(task.id, { sources });
    return { task: seeded, client };
}

/**
 * Create and open a durable combine task for the selected characters.
 *
 * @param {number[]} selectedCharacterIds Selected character ids.
 * @returns {Promise<void>} Resolves when the task wizard closes.
 */
export async function openCombineWizard(selectedCharacterIds) {
    const validIds = (selectedCharacterIds ?? []).filter((id) => characters[id]);
    if (validIds.length < 2) {
        globalThis.toastr?.warning?.(
            'Select at least two valid characters.',
            'Combine into Group Card',
        );
        return;
    }

    const { task, client } = await createTaskForSelection(validIds);
    await openTaskWizard(task, { client });
}
