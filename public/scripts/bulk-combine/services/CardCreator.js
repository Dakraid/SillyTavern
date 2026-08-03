'use strict';

/**
 * @file Final group-card creation and rollback.
 *
 * Orchestrates the artifact-creation calls once the wizard completes:
 * lorebook (`/api/worldinfo/edit`), character creation
 * (`/api/characters/create`), attribute merge (`/api/characters/merge-
 * attributes`), and avatar composite. Provides rollback helpers to undo
 * partial creation on failure or cancellation.
 *
 * Two entry points share the same creation/collision/rollback pipeline:
 *
 * - {@link createGeneratedGroupCard} — the legacy 13-parameter signature
 *   used by the legacy wizard stages; behavior is pinned by contract tests.
 * - {@link createGroupCardFromTask} — thin task-friendly wrapper for the
 *   8-page guided task workflow (Step 11g): takes the durable task + the
 *   assembled review payload + an optional composed avatar data URL.
 */

import { characters, getRequestHeaders } from '../../../script.js';
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
 * Whether a value is a plain record (non-array object).
 *
 * @param {unknown} value Value to test.
 * @returns {boolean} True for plain records.
 */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
 * Resolves name collisions for a validated request: asks the user whether
 * to overwrite the existing character/lorebook or rename automatically
 * (appending the first free `" (n)"` suffix). Mutates
 * `request.collisionResolution` and, on rename, `request.groupName`.
 *
 * @param {object} request Validated group-card request.
 * @param {object} [options] Options.
 * @param {boolean} [options.createLorebook] Whether a lorebook will be created.
 * @returns {Promise<void>}
 */
async function resolveNameCollisions(request, { createLorebook = true } = {}) {
    if (!request.collisions?.character && !request.collisions?.lorebook) {
        return;
    }

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
        return;
    }

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

/**
 * Creates the lorebook record for a validated request.
 *
 * @param {object} request Validated group-card request (post-collision).
 * @param {object} lorebookData Lorebook data (`{ entries }`).
 * @returns {Promise<void>}
 */
async function createLorebookRecord(request, lorebookData) {
    const worldResponse = await sendJsonRequest('/api/worldinfo/edit', {
        name: request.groupName,
        data: lorebookData,
    });
    await throwIfNotOk(
        worldResponse,
        `Failed to create lorebook "${request.groupName}".`,
    );
}

/**
 * Builds the character creation payload for a group card.
 *
 * @param {object} options Options.
 * @param {string} options.groupName Group card name (post-collision).
 * @param {string} options.description Character description.
 * @param {string} options.sourceNames Joined source character names.
 * @param {boolean} options.createLorebook Whether a lorebook is created.
 * @param {string} [options.firstMes] First message.
 * @param {Array<string>} [options.alternateGreetings] Alternate greetings.
 * @param {object|null} [options.wizardMeta] Group card wizard metadata.
 * @returns {object} Character creation payload.
 */
function buildGroupCardCharacterData({ groupName, description, sourceNames, createLorebook, firstMes = '', alternateGreetings = [], wizardMeta = null }) {
    return {
        name: groupName,
        ch_name: groupName,
        description,
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
}

/**
 * Creates (or overwrites) the group character record, rolling back a
 * freshly created lorebook when the character step fails.
 *
 * @param {object} request Validated group-card request (post-collision).
 * @param {object} characterData Character creation payload.
 * @param {object} [options] Options.
 * @param {boolean} [options.createLorebook] Whether a lorebook was created.
 * @returns {Promise<string>} Created (or existing) character avatar filename.
 */
async function createOrUpdateGroupCharacter(request, characterData, { createLorebook = true } = {}) {
    const overwritingCharacter =
        request.collisionResolution === 'overwrite' &&
        request.collisions?.character;
    const overwritingLorebook =
        createLorebook &&
        request.collisionResolution === 'overwrite' &&
        request.collisions?.lorebook;

    if (overwritingCharacter) {
        const existingCharacter = (characters ?? []).find(
            (character) =>
                normalizeName(getCharacterName(character)) ===
                normalizeName(request.groupName),
        );
        const avatar = String(existingCharacter?.avatar ?? '');

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

        return avatar;
    }

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
        return await readCreatedCharacterAvatar(
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

/**
 * Links the created lorebook to the character as its primary world, rolling
 * back the created artifacts when the link fails.
 *
 * @param {object} request Validated group-card request (post-collision).
 * @param {string} avatar Character avatar filename.
 * @param {object} [options] Options.
 * @param {boolean} [options.createLorebook] Whether a lorebook was created.
 * @returns {Promise<void>}
 */
async function linkLorebookToGroupCharacter(request, avatar, { createLorebook = true } = {}) {
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
        const overwritingCharacter =
            request.collisionResolution === 'overwrite' &&
            request.collisions?.character;
        const overwritingLorebook =
            createLorebook &&
            request.collisionResolution === 'overwrite' &&
            request.collisions?.lorebook;
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
}

/**
 * Applies a composite avatar data URL to a created character.
 *
 * @param {string} dataUrl Composite avatar data URL.
 * @param {string} characterAvatar Character avatar filename.
 * @returns {Promise<void>}
 */
async function applyCompositeAvatarToCharacter(dataUrl, characterAvatar) {
    const imageResponse = await fetch(dataUrl);
    await throwIfNotOk(imageResponse, 'Failed to read composite avatar.');
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    formData.append('avatar_url', characterAvatar);
    formData.append('avatar', imageBlob, 'avatar.png');

    const editHeaders = { ...getRequestHeaders() };
    delete editHeaders['Content-Type'];

    const response = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: editHeaders,
        body: formData,
    });
    await throwIfNotOk(response, 'Failed to apply composite avatar.');
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

    await resolveNameCollisions(request, { createLorebook });

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

        await createLorebookRecord(request, lorebookData);
    }

    const characterData = buildGroupCardCharacterData({
        groupName: request.groupName,
        description: generatedDescription,
        sourceNames,
        createLorebook,
        firstMes,
        alternateGreetings,
        wizardMeta,
    });

    const avatar = await createOrUpdateGroupCharacter(request, characterData, { createLorebook });

    if (!createLorebook) {
        return { avatar, world: '' };
    }

    await linkLorebookToGroupCharacter(request, avatar, { createLorebook });

    return { avatar, world: request.groupName };
}

/**
 * Default card name derived from the review payload's card blocks.
 *
 * @param {object} payload Review payload.
 * @returns {string} Joined block names (empty when none).
 */
function defaultTaskGroupName(payload) {
    const blocks = Array.isArray(payload?.cardBlocks) ? payload.cardBlocks : [];
    return blocks.map((block) => String(block?.name ?? '').trim()).filter(Boolean).join(' + ');
}

/**
 * Default card description derived from the review payload: the
 * post-processed output when post-processing is enabled and produced text,
 * else the merged transform description.
 *
 * @param {object} payload Review payload.
 * @returns {string} Description default.
 */
function defaultTaskDescription(payload) {
    const post = isRecord(payload?.post) ? payload.post : {};
    if (post.enabled === true && typeof post.output === 'string' && post.output.trim()) {
        return post.output;
    }
    return typeof payload?.mergedDescription === 'string' ? payload.mergedDescription : '';
}

/**
 * Creates the final group card for a guided combine task.
 *
 * Task-friendly wrapper over the shared creation pipeline: the durable
 * task's `review` edits win over the assembled review-payload defaults, the
 * source characters are rebuilt from the task's immutable source snapshots
 * (`source.fields` core payloads), and the lorebook — when
 * `settings.destination === 'lorebook'` — uses the assembled/reviewed
 * `lorebookData` exactly as previewed on the Review page (never rebuilt
 * from source core fields). No legacy wizard metadata is written.
 *
 * Applying the composite avatar is best-effort: a failure is reported via
 * `avatarError` in the result instead of failing the already-created card.
 *
 * @param {object} task Durable task snapshot (`{ sources, settings, review }`).
 * @param {object} reviewPayload Assembled review payload (`getReview()`).
 * @param {string|null} [avatarDataUrl] Composite avatar data URL (skipped when falsy).
 * @returns {Promise<{characterName: string, characterAvatar: string, lorebookName: string, avatarError: string}>} Created refs (`lorebookName`/`avatarError` empty when not applicable).
 * @throws {Error} When the request is invalid or a creation step fails.
 */
export async function createGroupCardFromTask(task, reviewPayload, avatarDataUrl = null) {
    const settings = isRecord(task?.settings) ? task.settings : {};
    const review = isRecord(task?.review) ? task.review : {};
    const payload = isRecord(reviewPayload) ? reviewPayload : {};
    const sources = Array.isArray(task?.sources) ? task.sources : [];

    const groupName = (typeof review.name === 'string' && review.name.trim())
        ? review.name.trim()
        : defaultTaskGroupName(payload);
    const description = typeof review.description === 'string'
        ? review.description
        : defaultTaskDescription(payload);
    const firstMes = typeof review.firstMes === 'string'
        ? review.firstMes
        : (typeof payload.firstMes === 'string' ? payload.firstMes : '');
    const createLorebook = settings.destination === 'lorebook';
    const lorebookData = isRecord(review.lorebookData) && isRecord(review.lorebookData.entries)
        ? review.lorebookData
        : (isRecord(payload.lorebookData) && isRecord(payload.lorebookData.entries)
            ? payload.lorebookData
            : { entries: {} });

    // Source characters from the immutable task snapshots (core payloads
    // captured on the Cards page), so creation does not depend on the live
    // roster.
    const selectedChars = sources.map((source) => ({
        name: String(source?.name ?? ''),
        ...(isRecord(source?.fields) ? source.fields : {}),
        avatar: String(source?.avatar ?? ''),
    }));

    const request = validateGroupCardRequest(groupName, selectedChars, {
        createLorebook,
    });

    if (!request) {
        throw new Error('Group card request is no longer valid.');
    }

    await resolveNameCollisions(request, { createLorebook });

    if (createLorebook) {
        await createLorebookRecord(request, lorebookData);
    }

    const sourceNames = request.characters
        .map((character) => getCoreCharacterField(character, 'name').trim())
        .join(', ');

    const characterData = buildGroupCardCharacterData({
        groupName: request.groupName,
        description,
        sourceNames,
        createLorebook,
        firstMes,
        alternateGreetings: [],
        wizardMeta: null,
    });

    const avatar = await createOrUpdateGroupCharacter(request, characterData, { createLorebook });

    if (createLorebook) {
        await linkLorebookToGroupCharacter(request, avatar, { createLorebook });
    }

    let avatarError = '';
    if (avatarDataUrl && avatar) {
        try {
            await applyCompositeAvatarToCharacter(String(avatarDataUrl), avatar);
        } catch (error) {
            console.error('createGroupCardFromTask: failed to apply the composite avatar.', error);
            avatarError = `The card was created, but applying the composed avatar failed: ${error?.message ?? error}`;
        }
    }

    return {
        characterName: request.groupName,
        characterAvatar: avatar,
        lorebookName: createLorebook ? request.groupName : '',
        avatarError,
    };
}
