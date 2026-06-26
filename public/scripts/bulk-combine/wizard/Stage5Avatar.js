'use strict';

/**
 * @file Stage 5 — Avatar Studio.
 *
 * Hosts the expanded composite avatar editor (see
 * {@link module:bulk-combine/components/AvatarEditor}). Two-column layout:
 * live preview on the left, controls sidebar (layout, ratio, cell gap, per-
 * cell scale/crop/offset) on the right. The final "Create Character" action
 * commits the group card via CardCreator.
 */

import {
    characters,
    getCharacters,
    getRequestHeaders,
    unshallowCharacter,
} from '../../../script.js';
import {
    getValidSelectedCharacters,
    getCoreCharacterField,
} from '../helpers.js';
import { createGeneratedGroupCard } from '../services/CardCreator.js';
import { throwIfNotOk } from '../services/JobClient.js';
import { AvatarEditor } from '../components/AvatarEditor.js';

/** @type {string|null} Cached stage 5 template HTML. */
let stage5TemplateHtml = null;

/** jQuery $.data key for the stage context on the stage panel. */
const CONTEXT_KEY = 'bcw-stage5-context';

/**
 * Fetch and cache the stage 5 template.
 *
 * @returns {Promise<string>} Stage 5 template HTML.
 */
async function loadStage5Template() {
    if (stage5TemplateHtml) {
        return stage5TemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/stage5.html');
    stage5TemplateHtml = await response.text();
    return stage5TemplateHtml;
}

/**
 * Resolve and return the wizard source characters (unshallowed).
 *
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {Promise<Array<object>>} Source character objects.
 */
async function getSourceCharacters(wizardState) {
    const ids = wizardState.state.selectedCharacterIds;
    await Promise.all(
        ids
            .filter((id) => characters[id]?.shallow)
            .map((id) => unshallowCharacter(String(id))),
    );
    return getValidSelectedCharacters(ids, characters);
}

/**
 * Build the wizard metadata object stored on the created character for
 * future re-runs.
 *
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {Array<object>} sourceCharacters Resolved source characters.
 * @returns {object} Wizard metadata.
 */
function buildWizardMetadata(wizardState, sourceCharacters) {
    const existingMeta = wizardState.state.rerunConfig?.rerunMeta ?? null;
    const config = wizardState.config;

    return {
        version: 1,
        sourceCharacterNames: sourceCharacters
            .map((c) => getCoreCharacterField(c, 'name').trim())
            .filter(Boolean),
        sourceCharacterAvatars: sourceCharacters
            .map((c) => c.avatar)
            .filter(Boolean),
        config: {
            groupName: config.groupName,
            prompt: config.prompt,
            concurrency: config.concurrency,
            cropStrategy: config.cropStrategy,
            cropPadding: config.cropPadding,
            layout: config.layout,
            gap: config.gap,
            maxCols: config.maxCols ?? 0,
            selectedOptionalFields: config.selectedOptionalFields,
            summaryFallbackTags: config.summaryFallbackTags,
            createLorebook: Boolean(config.createLorebook),
            dynamicLorebook: Boolean(config.dynamicLorebook),
            minify: Boolean(config.minify),
            minifySingleLine: Boolean(config.minifySingleLine),
            postMergeEnabled: Boolean(config.postMergeEnabled),
            postMergePrompt: config.postMergePrompt,
            postProcessMode: config.postProcessMode,
            inferredSchema: config.inferredSchema ?? null,
            avatarOffsets: wizardState.state.avatarOffsets ?? [],
            voronoiSeed: wizardState.state.voronoiSeed,
        },
        createdAt: existingMeta?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        runCount: Number(existingMeta?.runCount ?? 0) + 1,
    };
}

/**
 * Apply the composite avatar data URI to a created character.
 *
 * @param {string} dataUri Composite avatar data URI.
 * @param {string} characterAvatar Character avatar filename.
 * @returns {Promise<void>}
 */
async function applyCompositeAvatar(dataUri, characterAvatar) {
    if (!dataUri || !characterAvatar) {
        return;
    }

    const imageResponse = await fetch(dataUri);
    await throwIfNotOk(imageResponse, 'Failed to read composite avatar.');
    const imageBlob = await imageResponse.blob();

    const formData = new FormData();
    formData.append('avatar_url', characterAvatar);
    formData.append('avatar', imageBlob, 'avatar.png');

    const editHeaders = getRequestHeaders();
    delete editHeaders['Content-Type'];

    const response = await fetch('/api/characters/edit-avatar', {
        method: 'POST',
        headers: editHeaders,
        body: formData,
    });
    await throwIfNotOk(response, 'Failed to apply composite avatar.');
}

/**
 * Stage 5 controller object following the shared stage-module contract.
 */
export const Stage5Avatar = {
    /**
     * Load the Stage 5 template, create the AvatarEditor, and render it.
     * Does not trigger initial generation — {@link Stage5Avatar.onEnter}
     * handles that.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the panel is rendered.
     */
    async render(popupContent, wizardState) {
        const $content = $(popupContent);
        const $stage = $content.find('#bcw_stage_5');

        const html = await loadStage5Template();
        $stage.html(html);

        // Destroy previous editor if re-rendering (back-navigation).
        const prevCtx = $stage.data(CONTEXT_KEY);
        prevCtx?.editor?.destroy();

        const editor = new AvatarEditor($stage, wizardState);
        await editor.render();

        $stage.data(CONTEXT_KEY, { editor, generationStarted: false });
    },

    /**
     * Trigger initial avatar generation when the stage is entered for the
     * first time. Skipped when an avatar URL already exists (back navigation)
     * or when generation has already been started.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when generation is underway or skipped.
     */
    async onEnter(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_5');
        const ctx = $stage.data(CONTEXT_KEY);
        if (!ctx || ctx.generationStarted) {
            return;
        }

        ctx.generationStarted = true;

        // Skip generation if avatar already exists (back-navigation restore).
        if (wizardState.state.avatarUrl) {
            return;
        }

        await ctx.editor.regenerate();
    },

    /**
     * Read all avatar settings from the editor and return a config patch.
     * Also syncs offsets and avatarUrl to the wizard state.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {{layout: string, gap: number, maxCols: number, aspectRatio: string, customRatio: string|null, cropStrategy: string, cropPadding: number, avatarOffsets: Array<object>, avatarUrl: string|null}} Config patch.
     */
    collectConfig(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_5');
        const ctx = $stage.data(CONTEXT_KEY);
        if (!ctx?.editor) {
            return {
                layout: wizardState.config.layout ?? 'voronoi',
                gap: wizardState.config.gap ?? 2,
                maxCols: wizardState.config.maxCols ?? 0,
                aspectRatio: wizardState.config.aspectRatio ?? '9:16',
                customRatio: null,
                cropStrategy: wizardState.config.cropStrategy ?? 'attention',
                cropPadding: wizardState.config.cropPadding ?? 15,
                avatarOffsets: wizardState.state.avatarOffsets ?? [],
                avatarUrl: wizardState.state.avatarUrl,
            };
        }

        const patch = ctx.editor.collectConfig();

        // Sync to wizard state.
        wizardState.update({
            layout: patch.layout,
            gap: patch.gap,
            maxCols: patch.maxCols,
            aspectRatio: patch.aspectRatio,
            cropStrategy: patch.cropStrategy,
            cropPadding: patch.cropPadding,
        });
        wizardState.updateField('avatarOffsets', patch.avatarOffsets);
        wizardState.updateField('avatarUrl', patch.avatarUrl);

        return patch;
    },

    /**
     * Require that an avatar has been generated (avatarUrl set).
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {boolean} `true` when valid.
     */
    validate(popupContent, wizardState) {
        if (!wizardState.state.avatarUrl) {
            globalThis.toastr?.warning?.(
                'Please generate an avatar before creating the character.',
                'Combine into Group Card',
            );
            return false;
        }
        return true;
    },

    /**
     * Create the final group character card from all collected wizard data,
     * apply the composite avatar, and refresh the character list.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<boolean>} `true` on success, `false` on failure.
     */
    async createCharacter(popupContent, wizardState) {
        const config = wizardState.config;
        const state = wizardState.state;

        try {
            const sourceCharacters = await getSourceCharacters(wizardState);

            const groupName = String(state.finalName ?? '').trim();
            const description = String(state.finalDescription ?? '').trim();

            if (!groupName || !description) {
                globalThis.toastr?.warning?.(
                    'Character name and description are required.',
                    'Combine into Group Card',
                );
                return false;
            }

            const firstMes = String(state.finalFirstMes ?? '');
            const alternateGreetings = Array.isArray(state.finalAlternateGreetings)
                ? state.finalAlternateGreetings
                : [];

            const dynamicLorebookSourceXml = String(
                state.postProcessResult || state.mergedXml || '',
            );

            const wizardMeta = buildWizardMetadata(wizardState, sourceCharacters);

            const result = await createGeneratedGroupCard(
                groupName,
                description,
                sourceCharacters,
                Boolean(config.createLorebook || config.dynamicLorebook),
                config.selectedOptionalFields,
                Boolean(config.dynamicLorebook),
                dynamicLorebookSourceXml,
                wizardMeta,
                Boolean(config.minify),
                Boolean(config.minifySingleLine),
                firstMes,
                alternateGreetings,
                config.inferredSchema ?? null,
            );

            // Apply the composite avatar to the newly created character.
            if (state.avatarUrl && result.avatar) {
                await applyCompositeAvatar(state.avatarUrl, result.avatar);
            }

            wizardState.updateField('createdArtifacts', {
                avatar: result.avatar,
                world: result.world,
            });

            await getCharacters();

            globalThis.toastr?.success?.(
                'Group card created.',
                'Combine into Group Card',
            );
            return true;
        } catch (error) {
            console.error(error);
            globalThis.toastr?.error?.(
                error?.message ?? 'Failed to create group card.',
                'Combine into Group Card',
            );
            return false;
        }
    },

    /**
     * Clean up the avatar editor when leaving Stage 5.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @returns {void}
     */
    onExit(popupContent) {
        const $stage = $(popupContent).find('#bcw_stage_5');
        const ctx = $stage.data(CONTEXT_KEY);
        ctx?.editor?.destroy();
    },
};
