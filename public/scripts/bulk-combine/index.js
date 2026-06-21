'use strict';

/**
 * @file Public entry point for the Bulk Card Combine wizard.
 *
 * Exposes the functions that BulkEditOverlay.js, bulk-edit.js, and the
 * character context menu call to open or re-run the combine wizard. This
 * module owns event wiring and delegates all orchestration to
 * {@link module:bulk-combine/wizard/WizardController} and state to
 * {@link module:bulk-combine/wizard/WizardState}.
 *
 * The legacy wizard implementation (`BulkEditOverlay.combineIntoGroupCard`)
 * is bridged via {@link setOpenWizardHandler} so that
 * {@link openCombineWizard} can delegate without a circular import. When
 * no handler is registered, the functions fall back to
 * {@link WizardController} directly.
 */

import { WizardController } from './wizard/WizardController.js';

// Imports for local use (re-exports below remain for backward compatibility).

import {
    characters,
    generateQuietPrompt,
    unshallowCharacter,
    getCharacters,
} from '../../script.js';
import {
    validateGeneratedGroupCardDescription,
    parseGreetingsFromGeneratedOutput,
    stripGreetingBlocks,
    minifyXml,
} from '../group-card-xml-parser.js';
import {
    GROUP_CARD_WIZARD_METADATA_KEY,
    getGroupCardWizardMetadata,
    isGroupCardWizardCharacter,
    getCoreCharacterField,
    buildGroupCardCombineQuietPrompt,
    buildLorebookData,
    buildDynamicLorebookData,
    buildDynamicSummaryDescription,
} from './helpers.js';
import {
    sendJsonRequest,
    throwIfNotOk,
} from './services/JobClient.js';

// Re-export helpers --------------------------------------------------

export {
    CORE_CHARACTER_FIELDS,
    ALWAYS_INCLUDED_CHARACTER_FIELDS,
    OPTIONAL_CHARACTER_FIELDS,
    GROUP_CARD_WIZARD_METADATA_KEY,
    toGroupCardJobState,
    getGroupCardWizardMetadata,
    isGroupCardWizardCharacter,
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

export {
    GROUP_CARD_JOB_SESSION_KEY,
    sendJsonRequest,
    throwIfNotOk,
    cloneGroupCardJobSettings,
    getGroupCardJobLlmConfig,
    canUseServerGroupCardJob,
    buildGroupCardJobConfig,
    createJob,
    subscribeToJob,
    cancelJob,
    getJob,
} from './services/JobClient.js';

export {
    runClientGeneration,
    generateVoronoiCompositeAvatar,
    uploadCompositeAvatar,
} from './services/ClientGen.js';

export {
    createGeneratedGroupCard,
    rollbackGeneratedLorebook,
    rollbackGeneratedCharacter,
    readCreatedCharacterAvatar,
} from './services/CardCreator.js';

export {
    getGroupCardCombinePromptPresets,
    findGroupCardCombinePromptPresetIndex,
    saveGroupCardCombinePromptPreset,
    deleteGroupCardCombinePromptPreset,
    renderGroupCardCombinePromptPresetSelect,
    getGroupCardPostMergePromptPresets,
    findGroupCardPostMergePromptPresetIndex,
    saveGroupCardPostMergePromptPreset,
    deleteGroupCardPostMergePromptPreset,
    renderGroupCardPostMergePromptPresetSelect,
} from './services/PresetManager.js';

// Re-export the wizard controller for console/manual testing access.
export { WizardController };

// --------------------------------------------------------------------

/**
 * @type {((selectedCharacterIds: number[], rerunConfig?: object) => Promise<void>)|null}
 */
let _openWizardHandler = null;

/**
 * Register the active wizard opener (typically
 * `BulkEditOverlay.combineIntoGroupCard`). Called once during module
 * initialisation to bridge the legacy wizard implementation without a
 * circular import.
 *
 * @param {(selectedCharacterIds: number[], rerunConfig?: object) => Promise<void>} fn Wizard opener.
 * @returns {void}
 */
export function setOpenWizardHandler(fn) {
    _openWizardHandler = fn;
}

/**
 * @type {((characterId: number) => Promise<void>)|null}
 */
let _regenWizardHandler = null;

/**
 * Register the active re-run wizard opener. When set, {@link runRegenWizardForCard}
 * delegates to this handler instead of running the native implementation.
 *
 * @param {(characterId: number) => Promise<void>} fn Re-run opener.
 * @returns {void}
 */
export function setRegenWizardHandler(fn) {
    _regenWizardHandler = fn;
}

/**
 * Initialize bulk-combine wiring. Called once during bulk-edit startup.
 * Binds context-menu handlers, toolbar button handlers, and restores any
 * in-progress wizard state.
 *
 * @returns {void}
 */
export function initBulkCombine() {
    // Event wiring for toolbar/context-menu buttons will be added as the
    // wizard stage modules are implemented. For now the handlers live in
    // BulkEditOverlay's CharacterContextMenu.
}

/**
 * Resolve source character IDs from stored wizard metadata by matching
 * avatars against the loaded character list.
 *
 * @param {object} meta Wizard metadata.
 * @param {Array<object>} characterList Loaded character list.
 * @returns {number[]} Source character IDs in stored avatar order, with
 *     duplicates removed.
 */
function resolveSourceCharacterIds(meta, characterList) {
    const sourceAvatars = Array.isArray(meta?.sourceCharacterAvatars)
        ? meta.sourceCharacterAvatars
        : [];
    const ids = [];

    for (const avatar of sourceAvatars) {
        const id = characterList.findIndex(
            (candidate) => candidate?.avatar === avatar,
        );
        if (id >= 0 && !ids.includes(id)) {
            ids.push(id);
        }
    }

    return ids;
}

/**
 * Open the combine wizard for the given characters.
 *
 * Delegates to the registered wizard opener (set by BulkEditOverlay during
 * init) or to {@link WizardController.open} when no handler is registered.
 *
 * @param {number[]} selectedCharacterIds Character IDs selected in the bulk
 *     overlay. Must contain at least two entries.
 * @param {object} [rerunConfig] Optional re-run configuration for cards that
 *     already carry `extensions.group_card_wizard` metadata.
 * @returns {Promise<void>} Resolves when the wizard popup closes.
 */
export async function openCombineWizard(selectedCharacterIds, rerunConfig) {
    if (_openWizardHandler) {
        return _openWizardHandler(selectedCharacterIds, rerunConfig);
    }

    return WizardController.open(selectedCharacterIds, rerunConfig);
}

/**
 * Re-run the wizard for an existing group character. Extracts stored wizard
 * metadata, resolves the original source characters, backs up the current
 * card, and opens {@link WizardController} at stage 1 with the prior config
 * pre-filled.
 *
 * When a {@link setRegenWizardHandler|registered handler} exists it takes
 * precedence (legacy delegation path).
 *
 * @param {number} characterId Character ID of the group card to re-run.
 * @returns {Promise<void>} Resolves when the wizard popup closes.
 */
export async function runRegenWizardForCard(characterId) {
    if (_regenWizardHandler) {
        return _regenWizardHandler(characterId);
    }

    const character = characters[characterId];

    if (!isGroupCardWizardCharacter(character)) {
        globalThis.toastr?.error(
            'This character was not created by the Group Card Wizard.',
            'Combine into Group Card',
        );
        return;
    }

    const meta = getGroupCardWizardMetadata(character);

    // Best-effort backup of the existing card before re-running.
    try {
        const backupResponse = await sendJsonRequest(
            '/api/characters/group-card-backup',
            { avatar: character.avatar },
        );
        await throwIfNotOk(backupResponse, 'Failed to back up group card.');
    } catch (error) {
        console.warn('Group card backup failed; continuing re-run:', error);
        globalThis.toastr?.warning(
            'Could not back up the current card. Continuing anyway.',
            'Combine into Group Card',
        );
    }

    const sourceCharacterIds = resolveSourceCharacterIds(meta, characters);

    // Warn about any source characters that could not be resolved.
    const sourceAvatars = Array.isArray(meta.sourceCharacterAvatars)
        ? meta.sourceCharacterAvatars
        : [];

    if (sourceAvatars.length > sourceCharacterIds.length) {
        const foundAvatars = new Set(
            sourceCharacterIds.map((id) => characters[id]?.avatar),
        );
        const missingCount = sourceAvatars.filter(
            (avatar) => !foundAvatars.has(avatar),
        ).length;

        if (missingCount > 0) {
            globalThis.toastr?.warning(
                `${missingCount} source character(s) could not be found and will be skipped.`,
                'Combine into Group Card',
            );
        }
    }

    await WizardController.open(sourceCharacterIds, {
        rerunAvatar: character.avatar,
        rerunMeta: meta,
        groupName: getCoreCharacterField(character, 'name'),
    });
}

/**
 * Quick-regenerate a group card using stored wizard metadata without
 * presenting the full wizard UI. Performs client-side generation via
 * `generateQuietPrompt`, applies optional post-merge and XML minification,
 * updates the card and its lorebook, then refreshes the character list.
 *
 * @param {number} characterId Character ID of the group card to regenerate.
 * @returns {Promise<void>} Resolves when regeneration completes.
 */
export async function quickRegenGroupCard(characterId) {
    const character = characters[characterId];
    const meta = getGroupCardWizardMetadata(character);

    if (!character || !meta) {
        globalThis.toastr?.error(
            'This character was not created by the Group Card Wizard.',
        );
        return;
    }

    const storedConfig = meta.config ?? {};
    const sourceCharacterIds = resolveSourceCharacterIds(meta, characters);

    if (sourceCharacterIds.length < 2) {
        globalThis.toastr?.warning(
            'Not enough source characters found for regeneration. ' +
                'Try the full wizard to reconfigure.',
            'Quick Regen',
        );
        return;
    }

    await Promise.all(
        sourceCharacterIds
            .filter((id) => characters[id]?.shallow)
            .map((id) => unshallowCharacter(String(id))),
    );

    const sourceCharacters = sourceCharacterIds
        .map((id) => characters[id])
        .filter(Boolean);
    const groupName = getCoreCharacterField(character, 'name');
    const prompt = String(storedConfig.prompt ?? '').trim();

    if (!prompt) {
        globalThis.toastr?.warning(
            'No prompt found in stored config. Use the full wizard.',
            'Quick Regen',
        );
        return;
    }

    globalThis.toastr?.info('Regenerating group card…', 'Quick Regen');

    try {
        const fields = storedConfig.fields;
        const quietPrompt = buildGroupCardCombineQuietPrompt(
            prompt,
            sourceCharacters,
            fields,
        );
        const generatedDescription = String(
            (await generateQuietPrompt({
                quietPrompt,
                quietToLoud: true,
                skipWIAN: true,
            })) ?? '',
        );
        const validatedDescription = validateGeneratedGroupCardDescription(
            generatedDescription,
            sourceCharacters.length,
        );

        let finalDescription = validatedDescription;

        if (storedConfig.postMergeEnabled && storedConfig.postMergePrompt) {
            const mergePrompt =
                `${String(storedConfig.postMergePrompt).trim()}\n\nInput:\n${validatedDescription}`;
            finalDescription = String(
                (await generateQuietPrompt({
                    quietPrompt: mergePrompt,
                    quietToLoud: true,
                    skipWIAN: true,
                })) ?? validatedDescription,
            );
        }

        const { first_mes, alternate_greetings } =
            parseGreetingsFromGeneratedOutput(finalDescription);
        const descriptionClean = stripGreetingBlocks(finalDescription);

        const dynamicLorebook = Boolean(storedConfig.dynamicLorebook);
        const createLorebook = Boolean(
            storedConfig.createLorebook || dynamicLorebook,
        );
        const fallbackTags = Array.isArray(storedConfig.summaryFallbackTags)
            ? storedConfig.summaryFallbackTags
            : ['summary'];

        let cardDescription = dynamicLorebook
            ? buildDynamicSummaryDescription(
                stripGreetingBlocks(
                    dynamicLorebook ? validatedDescription : descriptionClean,
                ),
                fallbackTags,
            )
            : descriptionClean;

        const minify = Boolean(storedConfig.minify);
        const minifySingleLine = Boolean(storedConfig.minifySingleLine);

        if (minify) {
            cardDescription = minifyXml(cardDescription, {
                compact: !minifySingleLine,
                singleLine: minifySingleLine,
            });
        }

        const updatedMeta = {
            ...meta,
            config: {
                ...storedConfig,
                inferredSchema: storedConfig.inferredSchema ?? null,
            },
            updatedAt: new Date().toISOString(),
            runCount: Number(meta.runCount ?? 0) + 1,
        };

        const response = await sendJsonRequest(
            '/api/characters/merge-attributes',
            {
                avatar: character.avatar,
                data: {
                    name: groupName,
                    ch_name: groupName,
                    description: cardDescription,
                    first_mes: first_mes || '',
                    alternate_greetings: alternate_greetings ?? [],
                    creator_notes: `Generated group card from: ${meta.sourceCharacterNames?.join(', ') ?? 'unknown'}\n[group_card_wizard]`,
                    extensions: {
                        [GROUP_CARD_WIZARD_METADATA_KEY]: updatedMeta,
                    },
                },
            },
        );
        await throwIfNotOk(response, 'Failed to update group card.');

        if (createLorebook) {
            const lorebookSourceXml = dynamicLorebook
                ? stripGreetingBlocks(validatedDescription)
                : descriptionClean;
            const schema = storedConfig.inferredSchema ?? null;
            const lorebookData = dynamicLorebook
                ? buildDynamicLorebookData(
                    lorebookSourceXml,
                    sourceCharacters,
                    schema,
                )
                : buildLorebookData(sourceCharacters, fields);

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

            const worldResponse = await sendJsonRequest(
                '/api/worldinfo/edit',
                {
                    name: groupName,
                    data: lorebookData,
                },
            );
            await throwIfNotOk(worldResponse, 'Failed to update lorebook.');
        }

        await getCharacters();
        globalThis.toastr?.success('Group card regenerated.', 'Quick Regen');
    } catch (error) {
        console.error('Quick regen failed:', error);
        globalThis.toastr?.error(
            error?.message ?? 'Quick regeneration failed.',
            'Quick Regen',
        );
    }
}
