'use strict';

/**
 * @file Pure helper functions for the Bulk Card Combine wizard.
 *
 * Everything in this module is side-effect free: no DOM access, no jQuery,
 * no network calls. These functions operate on plain character objects,
 * field lists, and XML strings. They are safe to unit-test in isolation
 * and shared across wizard stages and services.
 */

import { substituteParams, characters } from '../../script.js';
import { escapeHtml } from '../utils.js';
import {
    newWorldInfoEntryTemplate,
    world_names,
} from '../world-info.js';
import {
    extractTopLevelXmlBlocks,
    extractXmlBlocksByTag,
    extractOpenTagAttributes,
    extractCommentFromCharacterBlock,
    extractKeysFromCharacterBlock,
    stripSummaryFromCharacterBlock,
    buildSummaryCharacterBlock,
} from '../group-card-xml-parser.js';

/**
 * Core character fields always present in a combine payload.
 *
 * @type {string[]}
 */
export const CORE_CHARACTER_FIELDS = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
];

/**
 * Character fields that are always included regardless of user selection.
 *
 * @type {string[]}
 */
export const ALWAYS_INCLUDED_CHARACTER_FIELDS = ['name', 'description'];

/**
 * Optional character fields the user may toggle in Advanced Options.
 *
 * @type {string[]}
 */
export const OPTIONAL_CHARACTER_FIELDS = [
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
];

/**
 * Key under which wizard metadata is stored in `data.extensions`.
 *
 * @type {string}
 */
export const GROUP_CARD_WIZARD_METADATA_KEY = 'group_card_wizard';

const CHARACTER_OPEN_TAG = '<character>';
const CHARACTER_CLOSE_TAG = '</character>';

/**
 * Maps a raw server job object into the lightweight job-state shape used by
 * the bulk overlay indicator.
 *
 * @param {object} job Raw server job.
 * @returns {{jobId: string, groupName: string, loaderHandle: null, source: null, startedAt: number, status: string}} Job state.
 */
export function toGroupCardJobState(job) {
    return {
        jobId: job.id,
        groupName: job.config?.groupName ?? '',
        loaderHandle: null,
        source: null,
        startedAt: job.createdAt,
        status: job.status,
    };
}

/**
 * Read wizard metadata from a character's extensions, if present.
 *
 * @param {object} character Character entity.
 * @returns {object|null} Stored wizard metadata, or null.
 */
export function getGroupCardWizardMetadata(character) {
    return character?.data?.extensions?.[GROUP_CARD_WIZARD_METADATA_KEY] ?? null;
}

/**
 * Check whether a character was created by the group card wizard.
 *
 * @param {object} character Character entity.
 * @returns {boolean} True when wizard metadata exists.
 */
export function isGroupCardWizardCharacter(character) {
    return Boolean(getGroupCardWizardMetadata(character));
}

/**
 * Normalizes selected optional fields into ordered core fields.
 *
 * @param {Array<string>} [selected] Selected optional fields.
 * @returns {Array<string>} Ordered included core fields.
 */
export function normalizeSelectedFields(selected) {
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
export function normalizeName(name) {
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
export function getCharacterName(character) {
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
export function getValidSelectedCharacters(selectedCharacters, characterList) {
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
export function getCoreCharacterField(character, field) {
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
export function getCoreCharacterPayload(character) {
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
export function buildCoreCharacterPromptBlock(character, fields) {
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
export function buildGroupCardCombineQuietPrompt(prompt, selectedCharacters, fields) {
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
export function formatLorebookSummaryField(label, value) {
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
export function buildLorebookEntryContent(character, fields) {
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
 * @param {Array<object>|null} [allCharacters] All source characters.
 * @returns {object} World info entry data.
 */
export function buildLorebookEntry(character, index, fields, allCharacters = null) {
    const name = getCoreCharacterField(character, 'name').trim();
    const avatar = String(character?.avatar ?? '').replace(/\.[^/.]+$/, '');
    const hasNameCollision =
		Array.isArray(allCharacters) &&
		allCharacters.some(
		    (other, otherIndex) =>
		        otherIndex !== index &&
				getCoreCharacterField(other, 'name').trim() === name,
		);
    const displayName = hasNameCollision && avatar ? `${name} (${avatar})` : name;
    const fieldLabels = normalizeSelectedFields(fields)
        .filter((field) => field !== 'name')
        .map(
            (field) =>
                field.charAt(0).toUpperCase() + field.slice(1).replace(/_/g, ' '),
        );
    const uid = Number.isInteger(index) && index >= 0 ? index : 0;

    return {
        uid,
        ...structuredClone(newWorldInfoEntryTemplate),
        key:
			hasNameCollision && avatar
			    ? [displayName, name, name.toLowerCase()]
			    : [displayName, name.toLowerCase()],
        keysecondary: [],
        comment:
			fieldLabels.length > 0
			    ? `${displayName} — ${fieldLabels.join(', ')}`
			    : displayName,
        content: buildLorebookEntryContent(character, fields),
        addMemo: true,
        order: 100 - uid,
        aiFunctionName: displayName
            .toLowerCase()
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+/, ''),
        aiDescription: `Content for ${displayName}`,
    };
}

/**
 * Builds lorebook data containing one entry per selected character.
 *
 * @param {Array<object>} selectedCharacters Valid selected characters.
 * @param {Array<string>} [fields] Included core fields.
 * @returns {{ entries: object }} World info data.
 */
export function buildLorebookData(selectedCharacters, fields) {
    const entries = Object.fromEntries(
        (selectedCharacters ?? []).map((character, index) => {
            const entry = buildLorebookEntry(
                character,
                index,
                fields,
                selectedCharacters,
            );
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
export function extractAllTopLevelXmlBlocks(xmlString) {
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
 * Extracts a character name from an XML block using the inferred schema.
 *
 * @param {{tag: string, content: string, raw: string, openTag: string}} block XML block.
 * @param {object} schema Inferred XML schema.
 * @returns {string} Extracted character name.
 */
export function extractCharacterNameFromBlock(block, schema) {
    if (!schema || !block) {
        return '';
    }

    const nameSchema =
		schema.combinedChildTag && block.tag === schema.combinedChildTag
		    ? {
		        nameSource: schema.combinedNameSource,
		        nameAttribute: schema.combinedNameAttribute,
		        nameChildTag: schema.combinedNameChildTag,
		    }
		    : schema;

    if (nameSchema.nameSource === 'attribute' && nameSchema.nameAttribute) {
        const attrs = extractOpenTagAttributes(block.openTag);
        return String(attrs[nameSchema.nameAttribute] ?? '').trim();
    }

    if (nameSchema.nameSource === 'child' && nameSchema.nameChildTag) {
        const nameBlocks = extractXmlBlocksByTag(
            block.content,
            nameSchema.nameChildTag,
        );
        return String(nameBlocks[0]?.content ?? '').trim();
    }

    const attrs = extractOpenTagAttributes(block.openTag);
    if (attrs.name) {
        return attrs.name.trim();
    }
    const nameBlocks = extractXmlBlocksByTag(block.content, 'name');
    return String(nameBlocks[0]?.content ?? '').trim();
}

/**
 * Extracts generated character XML blocks using inferred schema wrappers when present.
 *
 * @param {string} generatedXml Generated XML text.
 * @param {object|null} [schema] Inferred XML schema.
 * @returns {Array<{tag: string, content: string, raw: string, openTag: string}>} Character blocks.
 */
export function extractGeneratedCharacterBlocks(generatedXml, schema = null) {
    const text = String(generatedXml ?? '');

    if (schema?.combinedTag && schema?.combinedChildTag) {
        const combinedBlocks = extractXmlBlocksByTag(text, schema.combinedTag);
        const childBlocks = combinedBlocks.flatMap((block) =>
            extractXmlBlocksByTag(block.content, schema.combinedChildTag),
        );
        if (childBlocks.length > 0) {
            return childBlocks;
        }
    }

    if (schema?.outerTag) {
        const schemaBlocks = extractXmlBlocksByTag(text, schema.outerTag);
        if (schemaBlocks.length > 0) {
            return schemaBlocks;
        }
    }

    return extractTopLevelXmlBlocks(text);
}

/**
 * Dynamic lorebook: builds lorebook entries from generated XML blocks.
 * Each character's full XML (minus summary) becomes a lorebook entry.
 *
 * @param {string} generatedXml Generated XML text.
 * @param {Array<object>|null} [sourceCharacters] Source character objects.
 * @param {object|null} [schema] Inferred XML schema.
 * @returns {{ entries: object }} World info data.
 */
export function buildDynamicLorebookData(
    generatedXml,
    sourceCharacters = null,
    schema = null,
) {
    const characterBlocks = schema
        ? extractGeneratedCharacterBlocks(generatedXml, schema)
        : extractAllTopLevelXmlBlocks(String(generatedXml ?? '')).filter(
            (block) => block.tag === 'character',
        );
    const entries = Object.fromEntries(
        characterBlocks.map((block, index) => {
            const uid = Number.isInteger(index) && index >= 0 ? index : 0;
            const characterName = schema
                ? extractCharacterNameFromBlock(block, schema)
                : String(
                    extractXmlBlocksByTag(block.content, 'name')[0]?.content ?? '',
                ).trim();
            const sourceChar = Array.isArray(sourceCharacters)
                ? sourceCharacters[index]
                : null;
            const sourceAvatar = sourceChar
                ? String(sourceChar.avatar ?? '').replace(/\.[^/.]+$/, '')
                : '';
            const hasNameCollision = characterBlocks.some((_, otherIndex) => {
                if (otherIndex === index) {
                    return false;
                }
                const otherName = schema
                    ? extractCharacterNameFromBlock(characterBlocks[otherIndex], schema)
                    : String(
                        extractXmlBlocksByTag(
                            characterBlocks[otherIndex].content,
                            'name',
                        )[0]?.content ?? '',
                    ).trim();
                return otherName === characterName;
            });
            const displayName =
				hasNameCollision && sourceAvatar
				    ? `${characterName} (${sourceAvatar})`
				    : characterName;
            const extractedComment = extractCommentFromCharacterBlock(block);
            const extractedKeys = extractKeysFromCharacterBlock(block);
            const hasExtractedComment = extractedComment.length > 0;
            const hasExtractedKeys = extractedKeys.length > 0;
            const entry = {
                uid,
                ...structuredClone(newWorldInfoEntryTemplate),
                key: hasExtractedKeys
                    ? extractedKeys
                    : (hasNameCollision && sourceAvatar
                        ? [displayName, characterName, characterName.toLowerCase()]
                        : [displayName, characterName.toLowerCase()]),
                keysecondary: [],
                comment: hasExtractedComment ? extractedComment : `${displayName} — Dynamic Entry`,
                content: stripSummaryFromCharacterBlock(block.raw),
                addMemo: true,
                order: 100 - uid,
                aiFunctionName: displayName
                    .toLowerCase()
                    .replace(/[^a-z0-9_]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_+/, ''),
                aiDescription: `Content for ${displayName}`,
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
 * @param {Array<string>} [fallbackTags] Tags to keep when building summary blocks.
 * @returns {string} Main card description XML.
 */
export function buildDynamicSummaryDescription(
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
export function validateGroupCardRequest(
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
