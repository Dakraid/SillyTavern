'use strict';

/**
 * @file Final group-card creation and rollback.
 *
 * Orchestrates the artifact-creation calls once the wizard completes:
 * lorebook (`/api/worldinfo/edit`), character creation
 * (`/api/characters/create`), attribute merge (`/api/characters/merge-
 * attributes`), and avatar composite. Provides rollback helpers to undo
 * partial creation on failure or cancellation.
 */

import { characters } from '../../../script.js';
import { world_names } from '../../world-info.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../popup.js';
import { minifyXml } from '../../group-card-xml-parser.js';
import {
    GROUP_CARD_WIZARD_METADATA_KEY,
    buildDynamicLorebookData,
    buildLorebookData,
    getCharacterName,
    getCoreCharacterField,
    normalizeName,
    validateGroupCardRequest,
} from '../helpers.js';
import { sendJsonRequest, throwIfNotOk } from './JobClient.js';

/**
 * Attempts to delete a partially created lorebook.
 *
 * @param {string} groupName Lorebook name.
 * @returns {Promise<string>} Rollback status message.
 */
export async function rollbackGeneratedLorebook(groupName) {
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
export async function rollbackGeneratedCharacter(groupName, avatar) {
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
export async function readCreatedCharacterAvatar(response, groupName) {
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
 * @param {object|null} [schema] Inferred XML schema.
 * @returns {Promise<{ avatar: string, world: string }>} Created avatar and linked world name.
 */
export async function createGeneratedGroupCard(
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
    schema = null,
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
            ? buildDynamicLorebookData(
                dynamicLorebookSourceXml,
                request.characters,
                schema,
            )
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
