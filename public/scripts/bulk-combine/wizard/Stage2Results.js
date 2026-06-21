'use strict';

/**
 * @file Stage 2 — Generation Results.
 *
 * Implements the shared stage-module contract. Loads the results template,
 * creates a progress tracker and per-character result cards, and triggers
 * generation when the stage is entered (server-side SSE job for supported
 * APIs, client-side `generateQuietPrompt` fallback otherwise). Result cards
 * support inline XML editing, Auto-fix, and per-character Regenerate.
 *
 * "Save As Is" and the skip-post-processing checkbox are handled by the
 * WizardController footer wiring; this module provides validate/collectConfig
 * so the controller can transition correctly.
 */

import { characters, unshallowCharacter } from '../../../script.js';
import { extractTopLevelXmlBlocks } from '../../group-card-xml-parser.js';
import {
    normalizeSelectedFields,
    getValidSelectedCharacters,
    getCoreCharacterField,
    extractGeneratedCharacterBlocks,
    extractCharacterNameFromBlock,
} from '../helpers.js';
import {
    canUseServerGroupCardJob,
    buildGroupCardJobConfig,
    createJob,
    subscribeToJob,
    cancelJob,
    GROUP_CARD_JOB_SESSION_KEY,
} from '../services/JobClient.js';
import { runClientGeneration } from '../services/ClientGen.js';
import { ProgressTracker } from '../components/ProgressTracker.js';
import {
    RESULT_STATUS,
    createResultCard,
    updateResultCardStatus,
    getResultCardXml,
    setResultCardXml,
} from '../components/ResultCard.js';

/** @type {string|null} Cached stage 2 template HTML. */
let stage2TemplateHtml = null;

/** sessionStorage key for $.data context on the stage panel. */
const CONTEXT_KEY = 'bcw-stage2-context';

/**
 * Fetch and cache the stage 2 template.
 *
 * @returns {Promise<string>} Stage 2 template HTML.
 */
async function loadStage2Template() {
    if (stage2TemplateHtml) {
        return stage2TemplateHtml;
    }
    const response = await fetch('scripts/bulk-combine/templates/stage2.html');
    stage2TemplateHtml = await response.text();
    return stage2TemplateHtml;
}

/**
 * Normalise a raw character-output record into a canonical shape, deriving
 * `parseStatus` from the XML content.
 *
 * @param {object} output Raw output.
 * @returns {object} Normalised output.
 */
function normalizeOutput(output) {
    const xmlOutput = String(output?.xmlOutput ?? output?.output ?? '').trim();
    const blocks = extractTopLevelXmlBlocks(xmlOutput);
    return {
        characterIndex: Number(output?.characterIndex ?? output?.index ?? 0),
        characterName: String(
            output?.characterName ?? output?.name ?? 'Character',
        ),
        characterAvatar: String(
            output?.characterAvatar ?? output?.avatar ?? '',
        ),
        xmlOutput,
        parseStatus: blocks.length > 0 ? 'ok' : 'error',
        error: output?.error ? String(output.error) : '',
    };
}

/**
 * Toggle the wizard footer Next button disabled state.
 *
 * @param {JQuery<HTMLElement>} $content Popup content root.
 * @param {boolean} disabled Whether to disable.
 * @returns {void}
 */
function setNextDisabled($content, disabled) {
    $content
        .find('#bcw_btn_next')
        .toggleClass('disabled', disabled)
        .css('pointer-events', disabled ? 'none' : '')
        .attr('aria-disabled', disabled ? 'true' : 'false');
}

/**
 * Persist the working outputs into the wizard state.
 *
 * @param {object} ctx Stage context.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {void}
 */
function storeOutputs(ctx, wizardState) {
    const outputs = ctx.outputs
        .filter(Boolean)
        .sort((a, b) => (a.characterIndex ?? 0) - (b.characterIndex ?? 0));
    wizardState.updateField('characterOutputs', outputs);
    const mergedXml = outputs
        .filter((o) => o.parseStatus === 'ok')
        .map((o) => o.xmlOutput)
        .join('\n\n');
    wizardState.updateField('mergedXml', mergedXml);
}

/**
 * Sync a single card edit into the working outputs.
 *
 * @param {object} ctx Stage context.
 * @param {number} index Card index.
 * @param {string} xml XML text.
 * @returns {void}
 */
function handleEditXml(ctx, index, xml) {
    const existing = ctx.outputs[index] ?? {};
    ctx.outputs[index] = normalizeOutput({ ...existing, xmlOutput: xml });
}

/**
 * Sync a card after its internal Auto-fix ran.
 *
 * @param {object} ctx Stage context.
 * @param {number} index Card index.
 * @returns {void}
 */
function handleAutoFix(ctx, index) {
    const $card = ctx.cards[index];
    if (!$card) {
        return;
    }
    const existing = ctx.outputs[index] ?? {};
    ctx.outputs[index] = normalizeOutput({
        ...existing,
        xmlOutput: getResultCardXml($card),
    });
}

/**
 * Regenerate a single character's output using client-side generation.
 *
 * @param {object} ctx Stage context.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {number} index Card index.
 * @returns {Promise<void>}
 */
async function regenerateCharacter(ctx, wizardState, index) {
    const character = ctx.sourceCharacters[index];
    if (!character) {
        return;
    }

    const $card = ctx.cards[index];
    const name = getCoreCharacterField(character, 'name');
    const fields = normalizeSelectedFields(
        wizardState.config.selectedOptionalFields,
    );

    if ($card) {
        updateResultCardStatus($card, RESULT_STATUS.GENERATING, null);
    }
    ctx.progressTracker?.show({ indeterminate: true, total: 1 });
    ctx.progressTracker?.setStatus(`Regenerating: ${name}…`);
    setNextDisabled(ctx.$content, true);

    try {
        const generatedXml = await runClientGeneration(
            [character],
            wizardState.config.prompt,
            fields,
        );
        const schema = wizardState.config.inferredSchema;
        const blocks = extractGeneratedCharacterBlocks(generatedXml, schema);
        const block = blocks[0];
        const xml = block?.raw ?? generatedXml;
        const extractedName = block
            ? extractCharacterNameFromBlock(block, schema)
            : '';

        const output = normalizeOutput({
            characterIndex: index,
            characterName:
                extractedName || name || `Character ${index + 1}`,
            xmlOutput: xml,
        });

        ctx.outputs[index] = output;
        if ($card) {
            setResultCardXml($card, output.xmlOutput);
            updateResultCardStatus(
                $card,
                RESULT_STATUS.COMPLETE,
                output.parseStatus,
            );
        }
        storeOutputs(ctx, wizardState);
        globalThis.toastr?.success?.(
            'Regenerated character output.',
            'Combine into Group Card',
        );
    } catch (error) {
        ctx.outputs[index] = normalizeOutput({
            characterIndex: index,
            characterName: name,
            xmlOutput: $card ? getResultCardXml($card) : '',
            parseStatus: 'error',
            error: String(error?.message ?? 'Regeneration failed.'),
        });
        if ($card) {
            updateResultCardStatus($card, RESULT_STATUS.FAILED, 'error');
        }
        globalThis.toastr?.error?.(
            error?.message ?? 'Regeneration failed.',
            'Combine into Group Card',
        );
    } finally {
        ctx.progressTracker?.hide();
        setNextDisabled(ctx.$content, false);
    }
}

/**
 * Handle combined-output fallback and finalise after a job completes.
 *
 * @param {object} ctx Stage context.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @param {object} data Job-completed event data.
 * @param {number} total Total character count.
 * @returns {void}
 */
function handleJobComplete(ctx, wizardState, data, total) {
    // Some server modes emit a combined output instead of per-character events.
    const hasOutputs = ctx.outputs.filter(Boolean).length > 0;
    if (!hasOutputs) {
        const schema = wizardState.config.inferredSchema;
        const combinedSource = String(
            data?.combinedOutput ?? data?.description ?? '',
        ).trim();
        if (combinedSource) {
            const blocks = extractGeneratedCharacterBlocks(combinedSource, schema);
            blocks.forEach((block, index) => {
                if (index >= ctx.cards.length) {
                    return;
                }
                const extractedName = extractCharacterNameFromBlock(
                    block,
                    schema,
                );
                const output = normalizeOutput({
                    characterIndex: index,
                    characterName:
                        extractedName ||
                        getCoreCharacterField(
                            ctx.sourceCharacters[index] ?? {},
                            'name',
                        ) ||
                        `Character ${index + 1}`,
                    xmlOutput: block.raw,
                });
                ctx.outputs[index] = output;
                setResultCardXml(ctx.cards[index], output.xmlOutput);
                updateResultCardStatus(
                    ctx.cards[index],
                    RESULT_STATUS.COMPLETE,
                    output.parseStatus,
                );
            });
        }
    }

    ctx.progressTracker.updateProgress(
        ctx.outputs.filter(Boolean).length,
        total,
    );
    ctx.progressTracker.setStatus('Generation complete.');
    storeOutputs(ctx, wizardState);
    ctx.progressTracker.hide();
    setNextDisabled(ctx.$content, false);
}

/**
 * Run client-side generation for all characters (single LLM call) and split
 * the result into per-character blocks.
 *
 * @param {object} ctx Stage context.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {Promise<void>}
 */
async function runClientFallback(ctx, wizardState) {
    const config = wizardState.config;
    const fields = normalizeSelectedFields(config.selectedOptionalFields);
    const total = ctx.sourceCharacters.length;

    ctx.progressTracker.show({ indeterminate: true, total });
    ctx.progressTracker.setStatus('Generating XML from selected characters…');
    setNextDisabled(ctx.$content, true);
    ctx.cards.forEach(($card) =>
        updateResultCardStatus($card, RESULT_STATUS.GENERATING, null),
    );

    ctx.progressTracker.onCancel(() => {
        ctx.cancelled = true;
        ctx.progressTracker.setStatus('Generation cancelled.');
        ctx.progressTracker.hide();
        setNextDisabled(ctx.$content, false);
        ctx.cards.forEach(($card) =>
            updateResultCardStatus($card, RESULT_STATUS.PENDING, null),
        );
    });

    try {
        const generatedXml = await runClientGeneration(
            ctx.sourceCharacters,
            config.prompt,
            fields,
        );

        if (ctx.cancelled) {
            return;
        }

        ctx.progressTracker.setStatus('Parsing generated XML…');
        ctx.progressTracker.addTokenPreview(generatedXml.slice(-500));

        const schema = config.inferredSchema;
        const blocks = extractGeneratedCharacterBlocks(generatedXml, schema);

        blocks.forEach((block, index) => {
            if (index >= ctx.cards.length) {
                return;
            }
            const extractedName = extractCharacterNameFromBlock(block, schema);
            const output = normalizeOutput({
                characterIndex: index,
                characterName:
                    extractedName ||
                    getCoreCharacterField(
                        ctx.sourceCharacters[index] ?? {},
                        'name',
                    ) ||
                    `Character ${index + 1}`,
                xmlOutput: block.raw,
            });
            ctx.outputs[index] = output;
            setResultCardXml(ctx.cards[index], output.xmlOutput);
            updateResultCardStatus(
                ctx.cards[index],
                RESULT_STATUS.COMPLETE,
                output.parseStatus,
            );
        });

        // Mark cards without a corresponding block as failed.
        for (let i = blocks.length; i < ctx.cards.length; i++) {
            ctx.outputs[i] = normalizeOutput({
                characterIndex: i,
                characterName:
                    getCoreCharacterField(
                        ctx.sourceCharacters[i] ?? {},
                        'name',
                    ) || `Character ${i + 1}`,
                xmlOutput: '',
                parseStatus: 'error',
                error: 'No XML output generated.',
            });
            updateResultCardStatus(ctx.cards[i], RESULT_STATUS.FAILED, 'error');
        }

        ctx.progressTracker.updateProgress(blocks.length, total);
        ctx.progressTracker.setStatus(
            `Generation complete: ${blocks.length}/${total} parsed.`,
        );
        storeOutputs(ctx, wizardState);
        ctx.progressTracker.hide();
        setNextDisabled(ctx.$content, false);
    } catch (error) {
        if (ctx.cancelled) {
            return;
        }
        ctx.progressTracker.setStatus(
            `Generation failed: ${error?.message ?? 'Unknown error.'}`,
        );
        ctx.cards.forEach(($card) =>
            updateResultCardStatus($card, RESULT_STATUS.FAILED, 'error'),
        );
        globalThis.toastr?.error?.(
            error?.message ?? 'Generation failed.',
            'Combine into Group Card',
        );
        setNextDisabled(ctx.$content, false);
    }
}

/**
 * Run server-side generation via the group-card-job SSE pipeline.
 *
 * @param {object} ctx Stage context.
 * @param {import('./WizardState.js').WizardState} wizardState Wizard state.
 * @returns {Promise<void>}
 */
async function runServerJob(ctx, wizardState) {
    const config = wizardState.config;
    const fields = normalizeSelectedFields(config.selectedOptionalFields);
    const total = ctx.sourceCharacters.length;

    ctx.progressTracker.show({ indeterminate: true, total });
    ctx.progressTracker.setStatus('Starting server-side generation…');
    setNextDisabled(ctx.$content, true);

    const jobConfig = buildGroupCardJobConfig(
        config.groupName,
        config.prompt,
        ctx.sourceCharacters,
        Boolean(config.createLorebook || config.dynamicLorebook),
        fields,
        config.concurrency,
        false,
        config.postMergePrompt ?? '',
        config.cropStrategy,
        config.cropPadding,
        config.postProcessMode,
        config.dynamicLorebook,
        config.minify,
        config.minifySingleLine,
        config.maxCols,
    );

    ctx.progressTracker.onCancel(async () => {
        ctx.cancelled = true;
        ctx.eventSource?.close();
        if (ctx.jobId) {
            try {
                await cancelJob(ctx.jobId);
            } catch {
                // Cancellation failure is non-fatal.
            }
        }
        ctx.progressTracker.setStatus('Generation cancelled.');
        ctx.progressTracker.hide();
        setNextDisabled(ctx.$content, false);
    });

    try {
        const { jobId } = await createJob(jobConfig);
        if (!jobId) {
            await runClientFallback(ctx, wizardState);
            return;
        }
        if (ctx.cancelled) {
            try {
                await cancelJob(jobId);
            } catch {
                // Cancellation failure is non-fatal.
            }
            return;
        }

        ctx.jobId = jobId;
        sessionStorage.setItem(GROUP_CARD_JOB_SESSION_KEY, jobId);

        ctx.progressTracker.setIndeterminate(false);
        ctx.progressTracker.updateProgress(0, total);

        ctx.eventSource = subscribeToJob(jobId, {
            onCharacterStarted: (data) => {
                const index = Number(data?.index ?? 0);
                if (ctx.cards[index]) {
                    updateResultCardStatus(
                        ctx.cards[index],
                        RESULT_STATUS.GENERATING,
                        null,
                    );
                }
                ctx.progressTracker.setStatus(
                    `Generating ${index + 1}/${total}: ${data?.name ?? ''}…`,
                );
            },
            onCharacterCompleted: (data) => {
                const index = Number(
                    data?.index ?? ctx.outputs.filter(Boolean).length,
                );
                if (index >= ctx.cards.length) {
                    return;
                }
                const output = normalizeOutput({
                    characterIndex: index,
                    characterName: String(
                        data?.name ??
                            getCoreCharacterField(
                                ctx.sourceCharacters[index] ?? {},
                                'name',
                            ) ??
                            `Character ${index + 1}`,
                    ),
                    xmlOutput: String(data?.output ?? ''),
                });
                ctx.outputs[index] = output;
                setResultCardXml(ctx.cards[index], output.xmlOutput);
                updateResultCardStatus(
                    ctx.cards[index],
                    RESULT_STATUS.COMPLETE,
                    output.parseStatus,
                );
                const completed = ctx.outputs
                    .filter(Boolean)
                    .filter((o) => o.parseStatus === 'ok').length;
                ctx.progressTracker.updateProgress(completed, total);
                if (data?.output) {
                    ctx.progressTracker.addTokenPreview(
                        String(data.output).slice(-200),
                    );
                }
            },
            onCharacterFailed: (data) => {
                const index = Number(
                    data?.index ?? ctx.outputs.filter(Boolean).length,
                );
                if (index >= ctx.cards.length) {
                    return;
                }
                ctx.outputs[index] = normalizeOutput({
                    characterIndex: index,
                    characterName: String(
                        data?.name ??
                            getCoreCharacterField(
                                ctx.sourceCharacters[index] ?? {},
                                'name',
                            ) ??
                            `Character ${index + 1}`,
                    ),
                    xmlOutput: '',
                    parseStatus: 'error',
                    error: String(data?.error ?? 'Generation failed.'),
                });
                updateResultCardStatus(
                    ctx.cards[index],
                    RESULT_STATUS.FAILED,
                    'error',
                );
                ctx.progressTracker.setStatus(
                    `Character ${index + 1} failed: ${data?.error ?? 'Generation failed.'}`,
                );
            },
            onPostMergeStarted: () => {
                ctx.progressTracker.setStatus(
                    'Post-processing generated characters…',
                );
            },
            onComplete: (data) => {
                handleJobComplete(ctx, wizardState, data, total);
            },
            onFailed: (data) => {
                ctx.progressTracker.setStatus(
                    `Generation failed: ${data?.error ?? 'Unknown error.'}`,
                );
                globalThis.toastr?.error?.(
                    data?.error ?? 'Generation failed.',
                    'Combine into Group Card',
                );
                setNextDisabled(ctx.$content, false);
            },
            onError: () => {
                if (
                    ctx.eventSource?.readyState === EventSource.CLOSED
                ) {
                    return;
                }
                ctx.progressTracker.setStatus(
                    'Connection lost. Reconnecting…',
                );
            },
        });
    } catch (error) {
        if (ctx.cancelled) {
            return;
        }
        ctx.progressTracker.setStatus(
            'Server unavailable. Generating locally…',
        );
        await runClientFallback(ctx, wizardState);
    }
}

/**
 * Stage 2 controller object following the shared stage-module contract.
 */
export const Stage2Results = {
    /**
     * Populate the Stage 2 panel DOM: load the template, create the progress
     * tracker, create result cards, and populate from existing outputs when
     * re-entering. Does not start generation.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when the panel is rendered.
     */
    async render(popupContent, wizardState) {
        const $content = $(popupContent);
        const $stage = $content.find('#bcw_stage_2');
        const html = await loadStage2Template();
        $stage.html(html);

        // Ensure source characters are fully loaded.
        const ids = wizardState.state.selectedCharacterIds;
        await Promise.all(
            ids
                .filter((id) => characters[id]?.shallow)
                .map((id) => unshallowCharacter(String(id))),
        );

        const sourceCharacters = getValidSelectedCharacters(ids, characters);

        // Build the generation context.
        /** @type {object} */
        const ctx = {
            $content,
            $stage,
            sourceCharacters,
            cards: [],
            outputs: [],
            progressTracker: null,
            eventSource: null,
            jobId: '',
            generationStarted: false,
            cancelled: false,
        };

        // Create result cards (one per source character).
        const $grid = $stage.find('#bcw_result_grid');
        sourceCharacters.forEach((character, index) => {
            const characterId = ids[index] ?? index;
            const $card = createResultCard(characterId, {
                onEditXml: (_id, xml) => handleEditXml(ctx, index, xml),
                onAutoFix: () => handleAutoFix(ctx, index),
                onRegenerate: () =>
                    regenerateCharacter(ctx, wizardState, index),
            });
            ctx.cards.push($card);
            ctx.outputs.push(
                normalizeOutput({
                    characterIndex: index,
                    characterName:
                        getCoreCharacterField(character, 'name') ||
                        `Character ${index + 1}`,
                    xmlOutput: '',
                }),
            );
            $grid.append($card);
        });

        // Wire the progress tracker.
        ctx.progressTracker = new ProgressTracker(
            $stage.find('#bcw_progress'),
        );

        // Populate from existing outputs when re-entering (back navigation /
        // restore).
        const existing = wizardState.state.characterOutputs;
        if (Array.isArray(existing) && existing.length > 0) {
            existing.forEach((output, index) => {
                if (index >= ctx.cards.length) {
                    return;
                }
                const normalized = normalizeOutput(output);
                ctx.outputs[index] = normalized;
                setResultCardXml(ctx.cards[index], normalized.xmlOutput);
                if (normalized.parseStatus === 'ok') {
                    updateResultCardStatus(
                        ctx.cards[index],
                        RESULT_STATUS.COMPLETE,
                        'ok',
                    );
                } else if (normalized.error) {
                    updateResultCardStatus(
                        ctx.cards[index],
                        RESULT_STATUS.FAILED,
                        'error',
                    );
                }
            });
        }

        $stage.data(CONTEXT_KEY, ctx);
    },

    /**
     * Start generation when the stage becomes active. Skipped when outputs
     * already exist (back-navigation / restore) or when generation has already
     * been started.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {Promise<void>} Resolves when generation is underway.
     */
    async onEnter(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_2');
        const ctx = $stage.data(CONTEXT_KEY);
        if (!ctx || ctx.generationStarted) {
            return;
        }

        // Skip when outputs already exist (re-entry after back navigation).
        const existing = wizardState.state.characterOutputs;
        if (Array.isArray(existing) && existing.length > 0) {
            return;
        }

        ctx.generationStarted = true;

        if (canUseServerGroupCardJob()) {
            await runServerJob(ctx, wizardState);
        } else {
            await runClientFallback(ctx, wizardState);
        }
    },

    /**
     * Read the edited XML from all cards, recompute parse status, and store
     * `characterOutputs` + `mergedXml` into the wizard state.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {void}
     */
    collectConfig(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_2');
        const ctx = $stage.data(CONTEXT_KEY);
        if (!ctx) {
            return;
        }

        ctx.cards.forEach(($card, index) => {
            const existing = ctx.outputs[index] ?? {};
            ctx.outputs[index] = normalizeOutput({
                ...existing,
                xmlOutput: getResultCardXml($card),
            });
        });

        const skipPostProcess = Boolean(
            $stage.find('#bcw_skip_postprocess').prop('checked'),
        );
        storeOutputs(ctx, wizardState);
        if (skipPostProcess) {
            wizardState.updateField('postProcessResult', null);
        }
    },

    /**
     * Require at least one result card with valid (parseable) XML.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @param {import('./WizardState.js').WizardState} wizardState Current wizard state.
     * @returns {boolean} `true` when valid.
     */
    validate(popupContent, wizardState) {
        const $stage = $(popupContent).find('#bcw_stage_2');
        const ctx = $stage.data(CONTEXT_KEY);
        if (!ctx) {
            return false;
        }

        const hasValid = ctx.cards.some(($card) => {
            const xml = getResultCardXml($card);
            return extractTopLevelXmlBlocks(xml).length > 0;
        });

        if (!hasValid) {
            globalThis.toastr?.warning?.(
                'At least one valid XML output is required.',
                'Combine into Group Card',
            );
            return false;
        }
        return true;
    },

    /**
     * Hook executed when leaving Stage 2. Closes any active SSE connection.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} popupContent Popup content element.
     * @returns {void}
     */
    onExit(popupContent) {
        const ctx = $(popupContent)
            .find('#bcw_stage_2')
            .data(CONTEXT_KEY);
        if (ctx?.eventSource) {
            ctx.eventSource.close();
            ctx.eventSource = null;
        }
    },
};
