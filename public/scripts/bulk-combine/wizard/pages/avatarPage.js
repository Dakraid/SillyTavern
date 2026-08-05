'use strict';

/**
 * @file Avatar Studio & Create page (page 8) for the 8-page Bulk Combine
 * guided task wizard — the terminal page.
 *
 * Hosts the native {@link createAvatarCompositor} (client-side square
 * composite of the task's source avatars), summarizes the final card the
 * Create action will produce (name, destination, description / first
 * message — `task.review` edits win over the assembled review-payload
 * defaults, mirroring the Review page), and runs the Create action:
 * `createGroupCardFromTask(task, payload, composedAvatarDataUrl)` followed
 * by recording the created refs in `task.artifacts`.
 *
 * Persistence:
 * - Compositor offsets persist sparsely into `task.avatar.offsets` via
 *   `actions.update({ avatar: { offsets } })`, committed only when the
 *   compositor reports a FINALIZED gesture (drag end, wheel, key press) so
 *   a drag does not storm the server.
 * - The tiling layout persists into `task.avatar.layout` (`{ method, gap,
 *   aspect }`) via `actions.update({ avatar: { layout } })`, committed on
 *   control `change` events only; the same record is passed to the
 *   compositor's `setLayout` (no rebuild, no image reload).
 * - Created refs persist into `task.artifacts`
 *   (`{ characterName, characterAvatar, lorebookName, createdAt }`); the
 *   created state is rendered from the snapshot, so re-opening the wizard
 *   shows the already-created panel.
 *
 * The review payload is cached per `task.revision` (same contract as the
 * Review page). Rendering NEVER executes server-side generation: only the
 * Create button creates artifacts, and only Retry/Refresh re-fetches.
 *
 * Plain DOM only (no jQuery) so the page runs under the Node unit-test
 * environment with light DOM fakes; the compositor and CardCreator are
 * module seams that tests mock.
 */

import { getCharacters } from '../../../../script.js';
import { createAvatarCompositor } from '../../components/AvatarCompositor.js';
import {
    COMPOSITOR_DEFAULT_GAP,
    COMPOSITOR_PORTRAIT_ASPECTS,
    normalizeCompositorLayout,
} from '../../components/AvatarCompositorMath.js';
import { createGroupCardFromTask } from '../../services/CardCreator.js';

/**
 * Passes whose derived staleness makes the assembled review stale.
 *
 * @type {ReadonlyArray<string>}
 */
const UPSTREAM_PASS_KEYS = Object.freeze(['transform1', 'transform2', 'summary']);

const STALE_BANNER_TEXT = 'Upstream results changed since this review was assembled. Creating uses the assembled data shown here — go back to Review and Refresh to re-assemble from the latest results.';
const LOADING_TEXT = 'Assembling the review payload…';
const RETRY_TITLE = 'Try loading the review payload again.';
const WAITING_FOR_IMAGES_TEXT = 'Waiting for avatar images to load…';
const COMPOSITOR_UNAVAILABLE_TEXT = 'The avatar compositor could not start in this environment. You can still create the card — it will keep a default avatar.';

/**
 * Tiling methods offered by the layout controls (`[value, label]`).
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const LAYOUT_METHODS = Object.freeze([
    ['square', 'Square grid'],
    ['portrait', 'Portrait grid'],
    ['best-fit', 'Best fit'],
]);

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
 * Returns the string itself, or undefined for non-strings.
 *
 * @param {unknown} value Value to test.
 * @returns {string|undefined} String or undefined.
 */
function stringOrUndefined(value) {
    return typeof value === 'string' ? value : undefined;
}

/**
 * Reads the task revision (cache key for the review payload).
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {number} Revision (0 when absent).
 */
function revisionOf(snapshot) {
    const revision = snapshot?.task?.revision;
    return Number.isSafeInteger(revision) && revision > 0 ? revision : 0;
}

/**
 * Reads the persisted user edits (`task.review`, a free-form record).
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {object} Review edits record.
 */
function reviewEditsOf(snapshot) {
    return isRecord(snapshot?.task?.review) ? snapshot.task.review : {};
}

/**
 * Reads the task sources list defensively.
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {object[]} Source records.
 */
function sourcesOf(snapshot) {
    return Array.isArray(snapshot?.task?.sources) ? snapshot.task.sources : [];
}

/**
 * Whether any upstream pass feeding the assembly is stale.
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {boolean} True when transform1/transform2/summary is stale.
 */
function upstreamStale(snapshot) {
    const stale = snapshot?.derivedStaleness ?? snapshot?.task?.derivedStaleness ?? {};
    return UPSTREAM_PASS_KEYS.some((key) => stale?.[key]?.stale === true);
}

/**
 * Default card name derived from the assembled card blocks.
 *
 * @param {object} [payload] Review payload.
 * @returns {string} Joined block names (empty when none).
 */
function defaultNameOf(payload) {
    const blocks = Array.isArray(payload?.cardBlocks) ? payload.cardBlocks : [];
    return blocks.map((block) => String(block?.name ?? '').trim()).filter(Boolean).join(' + ');
}

/**
 * Assembled card description default: the post-processed output when
 * post-processing is enabled and produced text, else the merged transform
 * description.
 *
 * @param {object} [payload] Review payload.
 * @returns {string} Description default.
 */
function defaultDescriptionOf(payload) {
    const post = isRecord(payload?.post) ? payload.post : {};
    if (post.enabled === true && typeof post.output === 'string' && post.output.trim()) {
        return post.output;
    }
    return typeof payload?.mergedDescription === 'string' ? payload.mergedDescription : '';
}

/**
 * Reads the created-artifact refs recorded on the task, when present.
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {object|null} `task.artifacts` record, or null when nothing was created yet.
 */
function createdArtifactsOf(snapshot) {
    const artifacts = isRecord(snapshot?.task?.artifacts) ? snapshot.task.artifacts : null;
    if (!artifacts) {
        return null;
    }
    const hasRefs = [artifacts.characterName, artifacts.characterAvatar, artifacts.createdAt]
        .some((value) => (typeof value === 'string' ? value.trim() : Boolean(value)));
    return hasRefs ? artifacts : null;
}

/**
 * Sends a sparse optimistic PATCH through the actions facade. Never throws:
 * failures are logged and reported as `false`.
 *
 * @param {object} actions Actions facade.
 * @param {object} patch Sparse task patch.
 * @returns {Promise<boolean>} True when the patch was accepted.
 */
function applyPatch(actions, patch) {
    let result;
    try {
        result = actions?.update?.(patch);
    } catch (error) {
        console.error('avatarPage: failed to update the task.', error);
        return Promise.resolve(false);
    }
    return Promise.resolve(result).then(
        () => true,
        (error) => {
            console.error('avatarPage: failed to update the task.', error);
            return false;
        },
    );
}

/**
 * Builds a text button with a tooltip.
 *
 * @param {object} options Button options.
 * @param {string} options.className CSS class.
 * @param {string} options.label Visible label.
 * @param {string} [options.title] Tooltip / disabled explanation.
 * @param {boolean} [options.disabled] Whether the button is disabled.
 * @param {() => void} options.onClick Click handler.
 * @returns {Element} Button element.
 */
function buildButton({ className, label, title, disabled, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (title) {
        button.title = title;
    }
    button.disabled = disabled === true;
    button.addEventListener('click', () => onClick());
    return button;
}

/**
 * Builds a labelled summary row (term + value).
 *
 * @param {string} label Row label.
 * @param {string} value Row value.
 * @param {string} [valueClass] Extra class for the value element.
 * @returns {Element} Row element.
 */
function buildSummaryRow(label, value, valueClass = '') {
    const row = document.createElement('div');
    row.className = 'bc-task-avatar-summary-row';

    const term = document.createElement('span');
    term.className = 'bc-task-avatar-summary-label';
    term.textContent = label;

    const content = document.createElement('span');
    content.className = `bc-task-avatar-summary-value${valueClass ? ` ${valueClass}` : ''}`;
    content.textContent = value;
    content.title = value;

    row.append(term, content);
    return row;
}

/**
 * Creates the Avatar Studio & Create page module for the controller's
 * page registry.
 *
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createAvatarPage() {
    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /**
     * Revision-keyed payload cache: `{ revision, payload, error }`.
     *
     * @type {{revision: number|null, payload: object|null, error: string|null}}
     */
    let cache = { revision: null, payload: null, error: null };
    /**
     * Active fetch token. A fetch for revision N is superseded by any fetch
     * started for a newer revision — superseded responses are discarded, so
     * the latest revision ALWAYS gets its payload (no stuck "Assembling…").
     *
     * @type {{revision: number}|null}
     */
    let activeFetch = null;
    /** @type {object|null} Live compositor instance (persistent across re-renders). */
    let compositor = null;
    /** @type {Element|null} Persistent compositor host node (re-appended on every render). */
    let compositorHost = null;
    /** @type {string|null} Source identity key the compositor was built for. */
    let compositorSourcesKey = null;
    /**
     * Last layout committed from the tiling controls. Wins over the
     * snapshot until the persisted `task.avatar.layout` round-trips, so a
     * re-render cannot snap the controls back to a stale value.
     *
     * @type {{method: string, aspect: string, gap: number}|null}
     */
    let layoutDraft = null;
    /**
     * Create action state: `idle` | `creating` | `created` | `error`.
     *
     * @type {{status: string, error: string|null, result: object|null}}
     */
    let createState = { status: 'idle', error: null, result: null };

    /**
     * Effective card name: persisted `task.review` edit, then the
     * payload-derived default.
     *
     * @param {object|null} payload Review payload.
     * @returns {string} Effective name.
     */
    function effectiveName(payload) {
        const edited = stringOrUndefined(reviewEditsOf(latestSnapshot).name);
        return (edited !== undefined && edited.trim()) ? edited.trim() : defaultNameOf(payload);
    }

    /**
     * Effective card description: persisted `task.review` edit, then the
     * payload-derived default.
     *
     * @param {object|null} payload Review payload.
     * @returns {string} Effective description.
     */
    function effectiveDescription(payload) {
        return stringOrUndefined(reviewEditsOf(latestSnapshot).description) ?? defaultDescriptionOf(payload);
    }

    /**
     * Effective first message, when any.
     *
     * @param {object|null} payload Review payload.
     * @returns {string} Effective first message (possibly empty).
     */
    function effectiveFirstMes(payload) {
        return stringOrUndefined(reviewEditsOf(latestSnapshot).firstMes)
            ?? stringOrUndefined(payload?.firstMes)
            ?? stringOrUndefined(payload?.firstMessage)
            ?? '';
    }

    /**
     * Effective lorebook data: persisted `task.review` edit, then the
     * payload's assembled data.
     *
     * @param {object|null} payload Review payload.
     * @returns {object} Lorebook data (`{ entries }`).
     */
    function effectiveLorebookData(payload) {
        const edited = reviewEditsOf(latestSnapshot).lorebookData;
        if (isRecord(edited) && isRecord(edited.entries)) {
            return edited;
        }
        return isRecord(payload?.lorebookData) && isRecord(payload.lorebookData.entries)
            ? payload.lorebookData
            : { entries: {} };
    }

    /**
     * Starts the review-payload fetch for a revision. Fetches for the SAME
     * revision are deduplicated by the caller; a fetch for a NEWER revision
     * always starts and supersedes any older in-flight one.
     *
     * @param {number} revision Task revision to fetch at.
     * @returns {void}
     */
    function startFetch(revision) {
        const token = { revision };
        activeFetch = token;
        let result;
        try {
            result = latestActions?.getReview?.();
        } catch (error) {
            settleFetch(token, null, error);
            return;
        }
        if (result === undefined || result === null) {
            settleFetch(token, null, new Error('getReview is unavailable.'));
            return;
        }
        Promise.resolve(result).then(
            (payload) => settleFetch(token, payload, null),
            (error) => settleFetch(token, null, error),
        );
    }

    /**
     * Settles an in-flight fetch: caches the outcome and re-renders, unless
     * the fetch was superseded by a newer one, the page was disposed, or
     * the task revision moved on.
     *
     * @param {{revision: number}} token Fetch token from {@link startFetch}.
     * @param {object|null} payload Review payload on success.
     * @param {unknown} error Failure on error.
     * @returns {void}
     */
    function settleFetch(token, payload, error) {
        if (activeFetch !== token) {
            return;
        }
        activeFetch = null;
        if (!host || token.revision !== revisionOf(latestSnapshot)) {
            return;
        }
        cache = {
            revision: token.revision,
            payload: isRecord(payload) ? payload : null,
            error: error === null || error === undefined ? null : String(error),
        };
        renderPage();
    }

    /**
     * Forces a refetch at the current revision (Retry button).
     *
     * @returns {void}
     */
    function forceRefetch() {
        cache.revision = null;
        renderPage();
    }

    /**
     * Effective tiling layout: the just-committed draft, then the persisted
     * `task.avatar.layout`, then the defaults (`square`, aspect `3:4`, the
     * compositor's default gap). The draft clears once the persisted record
     * catches up.
     *
     * @returns {{method: string, aspect: string, gap: number}} Effective layout (concrete gap).
     */
    function effectiveLayout() {
        const persisted = normalizeCompositorLayout(isRecord(latestSnapshot?.task?.avatar?.layout)
            ? latestSnapshot.task.avatar.layout
            : undefined);
        const persistedLayout = { method: persisted.method, aspect: persisted.aspect, gap: persisted.gap ?? COMPOSITOR_DEFAULT_GAP };
        if (layoutDraft
            && layoutDraft.method === persistedLayout.method
            && layoutDraft.aspect === persistedLayout.aspect
            && layoutDraft.gap === persistedLayout.gap) {
            layoutDraft = null;
        }
        return layoutDraft ?? persistedLayout;
    }

    /**
     * Commits a tiling layout from the controls: remembers it locally,
     * applies it to the live compositor WITHOUT a rebuild (cells recompute,
     * images stay loaded), and persists it sparsely.
     *
     * @param {{method: string, aspect: string, gap: number}} layout Layout record.
     * @returns {void}
     */
    function commitLayout(layout) {
        layoutDraft = layout;
        compositor?.setLayout?.(layout);
        void applyPatch(latestActions, { avatar: { layout } });
    }

    /**
     * Builds the tiling controls row above the compositor host: tiling
     * method select, portrait cell-aspect select (portrait only), and the
     * cell-gap number input. Commits on `change` events only.
     *
     * @returns {Element} Controls row.
     */
    function buildLayoutControls() {
        const current = effectiveLayout();

        const row = document.createElement('div');
        row.className = 'bc-task-avatar-layout-controls';

        const methodField = document.createElement('div');
        methodField.className = 'bc-task-avatar-layout-field';
        const methodLabel = document.createElement('label');
        methodLabel.className = 'bc-task-avatar-layout-label';
        methodLabel.setAttribute('for', 'bc-task-avatar-layout-method');
        methodLabel.textContent = 'Tiling';
        const methodSelect = document.createElement('select');
        methodSelect.id = 'bc-task-avatar-layout-method';
        methodSelect.className = 'bc-task-avatar-layout-select';
        for (const [value, label] of LAYOUT_METHODS) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = label;
            methodSelect.append(option);
        }
        methodSelect.value = LAYOUT_METHODS.some(([value]) => value === current.method) ? current.method : 'square';
        methodField.append(methodLabel, methodSelect);

        const aspectField = document.createElement('div');
        aspectField.className = 'bc-task-avatar-layout-field';
        const aspectLabel = document.createElement('label');
        aspectLabel.className = 'bc-task-avatar-layout-label';
        aspectLabel.setAttribute('for', 'bc-task-avatar-layout-aspect');
        aspectLabel.textContent = 'Cell aspect';
        const aspectSelect = document.createElement('select');
        aspectSelect.id = 'bc-task-avatar-layout-aspect';
        aspectSelect.className = 'bc-task-avatar-layout-select';
        for (const aspect of Object.keys(COMPOSITOR_PORTRAIT_ASPECTS)) {
            const option = document.createElement('option');
            option.value = aspect;
            option.textContent = aspect;
            aspectSelect.append(option);
        }
        aspectSelect.value = typeof COMPOSITOR_PORTRAIT_ASPECTS[current.aspect] === 'number' ? current.aspect : '3:4';
        aspectField.append(aspectLabel, aspectSelect);
        aspectField.hidden = methodSelect.value !== 'portrait';

        const gapField = document.createElement('div');
        gapField.className = 'bc-task-avatar-layout-field';
        const gapLabel = document.createElement('label');
        gapLabel.className = 'bc-task-avatar-layout-label';
        gapLabel.setAttribute('for', 'bc-task-avatar-layout-gap');
        gapLabel.textContent = 'Gap (px)';
        const gapInput = document.createElement('input');
        gapInput.id = 'bc-task-avatar-layout-gap';
        gapInput.className = 'bc-task-avatar-layout-gap-input';
        gapInput.type = 'number';
        gapInput.setAttribute('min', '0');
        gapInput.setAttribute('step', '1');
        gapInput.value = String(current.gap);
        gapField.append(gapLabel, gapInput);

        /**
         * Reads the controls into a normalized layout record (concrete,
         * clamped gap ≥ 0) and commits it.
         *
         * @returns {void}
         */
        function commitFromControls() {
            const normalized = normalizeCompositorLayout({ method: methodSelect.value, aspect: aspectSelect.value });
            const raw = Number(gapInput.value);
            const gap = Number.isFinite(raw) && raw >= 0 ? raw : 0;
            gapInput.value = String(gap);
            commitLayout({ method: normalized.method, aspect: normalized.aspect, gap });
        }

        methodSelect.addEventListener('change', () => {
            aspectField.hidden = methodSelect.value !== 'portrait';
            commitFromControls();
        });
        aspectSelect.addEventListener('change', commitFromControls);
        gapInput.addEventListener('change', commitFromControls);

        row.append(methodField, aspectField, gapField);
        return row;
    }

    /**
     * Ensures the compositor exists for the current source set. The
     * compositor (canvas + loaded images) persists across re-renders: its
     * host node is re-appended to each new page root. A changed source set
     * rebuilds it from the persisted `task.avatar.offsets`.
     *
     * @returns {Element} The compositor host node (or an error note).
     */
    function ensureCompositor() {
        const sources = sourcesOf(latestSnapshot);
        const sourcesKey = sources.map((source) => `${String(source?.key ?? '')}|${String(source?.avatar ?? '')}`).join(';;');

        if (compositor && compositorHost && compositorSourcesKey === sourcesKey) {
            return compositorHost;
        }

        compositor?.dispose?.();
        compositor = null;
        compositorHost = null;
        compositorSourcesKey = sourcesKey;

        const mount = document.createElement('div');
        mount.className = 'bc-task-avatar-compositor-host';

        const avatarState = isRecord(latestSnapshot?.task?.avatar) ? latestSnapshot.task.avatar : {};
        try {
            compositor = createAvatarCompositor({
                container: mount,
                sources: sources.map((source) => ({
                    key: String(source?.key ?? ''),
                    name: String(source?.name ?? ''),
                    avatar: String(source?.avatar ?? ''),
                })),
                initialOffsets: Array.isArray(avatarState.offsets) ? avatarState.offsets : [],
                layout: effectiveLayout(),
                onChange: (offsets, finalized) => {
                    if (finalized === true) {
                        void applyPatch(latestActions, { avatar: { offsets } });
                    }
                },
                // Images settle asynchronously — re-render so the Create
                // button ungates the moment every image loaded (or failed).
                onSettle: () => {
                    if (host) {
                        renderPage();
                    }
                },
            });
            compositorHost = mount;
        } catch (error) {
            console.error('avatarPage: failed to start the avatar compositor.', error);
            compositor = null;
            compositorHost = null;

            const note = document.createElement('p');
            note.className = 'bc-task-avatar-compositor-error';
            note.setAttribute('role', 'status');
            note.textContent = COMPOSITOR_UNAVAILABLE_TEXT;
            mount.append(note);
            return mount;
        }

        return compositorHost;
    }

    /**
     * Whether the compositor is up but its source images are still loading.
     * Create stays gated until every image settled so a fast click cannot
     * produce a default/partial composite.
     *
     * @returns {boolean} True while waiting for images.
     */
    function waitingForImages() {
        if (!compositor || typeof compositor.isReady !== 'function') {
            return false;
        }
        return compositor.isReady() !== true;
    }

    /**
     * Runs the Create action: composes the avatar, creates the card via the
     * CardCreator task wrapper, and records `task.artifacts` (plus the
     * completed lifecycle status). Never throws; failures land in the
     * inline error state.
     *
     * Duplicate-create resilience: before creating, the server task is
     * re-fetched and its `artifacts` re-checked — if an earlier create's
     * artifacts PATCH was lost (popup closed, conflict, network), a reopen
     * still sees the recorded artifacts and refuses a second create.
     *
     * @returns {Promise<void>}
     */
    async function handleCreate() {
        const payload = cache.payload;
        if (!payload || createState.status !== 'idle' && createState.status !== 'error') {
            return;
        }
        if (createdArtifactsOf(latestSnapshot)) {
            return;
        }
        const name = effectiveName(payload);
        const description = effectiveDescription(payload);
        if (!name.trim() || !description.trim()) {
            return;
        }
        if (waitingForImages()) {
            return;
        }

        createState = { status: 'creating', error: null, result: null };
        renderPage();

        // Re-check the server: an earlier create may have recorded artifacts
        // that the local snapshot has not seen (lost PATCH + reopen).
        try {
            const fresh = await latestActions?.refresh?.();
            if (fresh && createdArtifactsOf({ task: fresh })) {
                createState = { status: 'idle', error: null, result: null };
                if (host) {
                    renderPage();
                }
                return;
            }
        } catch (refreshError) {
            // Best-effort guard: proceed with the local snapshot when the
            // re-fetch itself failed.
            console.warn('avatarPage: pre-create artifacts re-check failed.', refreshError);
        }

        let dataUrl = null;
        try {
            dataUrl = compositor?.getComposedImageDataURL?.() ?? null;
        } catch (error) {
            console.warn('avatarPage: composed avatar unavailable; creating without it.', error);
            dataUrl = null;
        }

        try {
            const result = await createGroupCardFromTask(latestSnapshot?.task ?? {}, payload, dataUrl);
            createState = { status: 'created', error: null, result: isRecord(result) ? result : null };
            // Record the artifacts AND the completed lifecycle in one patch;
            // retry once so a transient failure cannot leave a created card
            // unrecorded (which would silently allow a second create).
            const completionPatch = {
                artifacts: {
                    characterName: String(result?.characterName ?? ''),
                    characterAvatar: String(result?.characterAvatar ?? ''),
                    lorebookName: String(result?.lorebookName ?? ''),
                    createdAt: new Date().toISOString(),
                },
                status: 'completed',
            };
            const recorded = await applyPatch(latestActions, completionPatch);
            if (!recorded) {
                const retried = await applyPatch(latestActions, completionPatch);
                if (!retried) {
                    console.error('avatarPage: the card was created but recording task.artifacts failed twice.');
                }
            }
            try {
                await getCharacters?.();
            } catch (refreshError) {
                console.warn('avatarPage: character list refresh failed.', refreshError);
            }
        } catch (error) {
            console.error('avatarPage: failed to create the group card.', error);
            createState = { status: 'error', error: String(error?.message ?? error), result: null };
        }

        if (host) {
            renderPage();
        }
    }

    /**
     * Builds the stale-warning banner (`role="status"`).
     *
     * @returns {Element} Banner element.
     */
    function buildStaleBanner() {
        const banner = document.createElement('div');
        banner.className = 'bc-task-avatar-stale';
        banner.setAttribute('role', 'status');

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-triangle-exclamation';
        icon.setAttribute('aria-hidden', 'true');

        const text = document.createElement('p');
        text.className = 'bc-task-avatar-stale-text';
        text.textContent = STALE_BANNER_TEXT;

        banner.append(icon, text);
        return banner;
    }

    /**
     * Builds the read-only final-card summary (name, destination,
     * description / first message preview).
     *
     * @param {object} payload Review payload.
     * @returns {Element} Summary section.
     */
    function buildSummarySection(payload) {
        const settings = isRecord(latestSnapshot?.task?.settings) ? latestSnapshot.task.settings : {};
        const lorebookDestination = settings.destination === 'lorebook';
        const destinationLabel = lorebookDestination
            ? `Lorebook (${Object.keys(effectiveLorebookData(payload).entries).length} entries, linked to the card)`
            : 'Card description';

        const section = document.createElement('section');
        section.className = 'bc-task-avatar-summary';
        section.setAttribute('aria-label', 'Final card summary');

        const title = document.createElement('h3');
        title.className = 'bc-task-avatar-section-title';
        title.textContent = 'Final card';
        section.append(title);

        section.append(buildSummaryRow('Name', effectiveName(payload) || '(unnamed)'));
        section.append(buildSummaryRow('Destination', destinationLabel));

        const firstMes = effectiveFirstMes(payload);
        if (firstMes) {
            section.append(buildSummaryRow('First message', firstMes, 'bc-task-avatar-summary-preview'));
        }

        const description = effectiveDescription(payload);
        const preview = document.createElement('pre');
        preview.className = 'bc-task-avatar-description-preview';
        preview.textContent = description || 'Nothing assembled yet — run the transform passes, then go back to Review.';
        section.append(preview);

        return section;
    }

    /**
     * Builds the already-created panel from the durable `task.artifacts`
     * (survives wizard re-opens), plus the in-session avatar-apply warning
     * when the composite avatar could not be uploaded.
     *
     * @param {object} artifacts `task.artifacts` record.
     * @returns {Element} Created panel.
     */
    function buildCreatedPanel(artifacts) {
        const panel = document.createElement('section');
        panel.className = 'bc-task-avatar-created';
        panel.setAttribute('aria-label', 'Created group card');

        const title = document.createElement('h3');
        title.className = 'bc-task-avatar-section-title';

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-circle-check';
        icon.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.textContent = ' Group card created';
        title.append(icon, label);
        panel.append(title);

        const characterName = String(artifacts.characterName ?? '').trim();
        panel.append(buildSummaryRow('Character', characterName || '(unknown)'));
        const lorebookName = String(artifacts.lorebookName ?? '').trim();
        if (lorebookName) {
            panel.append(buildSummaryRow('Lorebook', lorebookName));
        }
        const createdAt = String(artifacts.createdAt ?? '').trim();
        if (createdAt) {
            panel.append(buildSummaryRow('Created at', createdAt));
        }

        const avatarError = String(createState.result?.avatarError ?? '').trim();
        if (avatarError) {
            const warning = document.createElement('p');
            warning.className = 'bc-task-avatar-created-warning';
            warning.setAttribute('role', 'alert');
            warning.textContent = avatarError;
            panel.append(warning);
        }

        return panel;
    }

    /**
     * Builds the Create section: the Create button (or creating status) and
     * the inline error state with a retry path.
     *
     * @param {object} payload Review payload.
     * @returns {Element} Create section.
     */
    function buildCreateSection(payload) {
        const section = document.createElement('section');
        section.className = 'bc-task-avatar-create';
        section.setAttribute('aria-label', 'Create the group card');

        const name = effectiveName(payload);
        const description = effectiveDescription(payload);
        const sources = sourcesOf(latestSnapshot);
        const creating = createState.status === 'creating';
        const imagesPending = waitingForImages();

        let disabledReason = '';
        if (!name.trim() || !description.trim()) {
            disabledReason = 'The card needs a name and a description — complete the transform passes and the Review page first.';
        } else if (sources.length < 2) {
            disabledReason = 'At least two source cards are required to combine.';
        } else if (imagesPending) {
            disabledReason = WAITING_FOR_IMAGES_TEXT;
        }

        section.append(buildButton({
            className: 'bc-task-avatar-create-button',
            label: creating ? 'Creating…' : 'Create Group Card',
            title: disabledReason || 'Create the group card (and lorebook, when the destination is a lorebook) with the composed avatar.',
            disabled: creating || disabledReason !== '',
            onClick: () => {
                void handleCreate();
            },
        }));

        if (imagesPending && !creating) {
            const waiting = document.createElement('p');
            waiting.className = 'bc-task-avatar-waiting';
            waiting.setAttribute('role', 'status');
            waiting.textContent = WAITING_FOR_IMAGES_TEXT;
            section.append(waiting);
        }

        if (creating) {
            const status = document.createElement('p');
            status.className = 'bc-task-avatar-create-status';
            status.setAttribute('role', 'status');
            status.textContent = 'Creating the group card…';
            section.append(status);
        }

        if (createState.status === 'error' && createState.error) {
            const box = document.createElement('div');
            box.className = 'bc-task-avatar-create-error';
            box.setAttribute('role', 'alert');
            const text = document.createElement('p');
            text.className = 'bc-task-avatar-create-error-text';
            text.textContent = `Failed to create the group card: ${createState.error}`;
            box.append(text);
            section.append(box);
        }

        return section;
    }

    /**
     * The created view: the durable `task.artifacts` once recorded, else the
     * in-session create result (so the Create section never reappears — and
     * cannot double-create — while the artifacts PATCH round-trips).
     *
     * @returns {object|null} Artifacts-like record, or null.
     */
    function createdViewOf() {
        const durable = createdArtifactsOf(latestSnapshot);
        if (durable) {
            return durable;
        }
        if (createState.status === 'created' && isRecord(createState.result)) {
            return {
                characterName: createState.result.characterName,
                characterAvatar: createState.result.characterAvatar,
                lorebookName: createState.result.lorebookName,
                createdAt: '',
            };
        }
        return null;
    }

    /**
     * Builds the page body according to the cache/creation state.
     *
     * @returns {Element[]} Body elements.
     */
    function buildBody() {
        const created = createdViewOf();

        if (cache.error !== null && cache.payload === null) {
            const box = document.createElement('div');
            box.className = 'bc-task-avatar-error';
            box.setAttribute('role', 'alert');
            const text = document.createElement('p');
            text.className = 'bc-task-avatar-error-text';
            text.textContent = `Failed to load the review payload: ${cache.error}`;
            box.append(text, buildButton({
                className: 'bc-task-avatar-retry',
                label: 'Retry',
                title: RETRY_TITLE,
                onClick: forceRefetch,
            }));
            return created ? [buildCreatedPanel(created), box] : [box];
        }
        if (cache.payload === null) {
            const loading = document.createElement('p');
            loading.className = 'bc-task-avatar-loading';
            loading.setAttribute('role', 'status');
            loading.textContent = LOADING_TEXT;
            return created ? [buildCreatedPanel(created), loading] : [loading];
        }

        const body = [];
        if (created) {
            body.push(buildCreatedPanel(created));
        }
        body.push(buildSummarySection(cache.payload));

        const compositorSection = document.createElement('section');
        compositorSection.className = 'bc-task-avatar-studio';
        compositorSection.setAttribute('aria-label', 'Group avatar');
        const studioTitle = document.createElement('h3');
        studioTitle.className = 'bc-task-avatar-section-title';
        studioTitle.textContent = 'Group avatar';
        compositorSection.append(studioTitle, buildLayoutControls(), ensureCompositor());
        body.push(compositorSection);

        if (!created) {
            body.push(buildCreateSection(cache.payload));
        }
        return body;
    }

    /**
     * Rebuilds the whole page from the latest snapshot into the host,
     * starting a payload fetch when the revision has no cached outcome.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        const revision = revisionOf(latestSnapshot);
        // Fetch when this revision has no cached outcome. Dedupe per
        // revision — a render for a NEWER revision always starts a fresh
        // fetch even while an older one is in flight (the older response is
        // discarded by its token), so a mid-flight revision bump can never
        // leave the page stuck on "Assembling…".
        if (cache.revision !== revision && activeFetch?.revision !== revision) {
            startFetch(revision);
        }

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-avatar';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = 'Avatar Studio & Create';

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'Compose the group avatar from the source cards, check the final card, then create it. Edits to name and text happen on the Review page.';

        root.append(heading, guidance);
        if (upstreamStale(latestSnapshot)) {
            root.append(buildStaleBanner());
        }

        root.append(...buildBody());

        const footer = document.createElement('footer');
        footer.className = 'bc-task-avatar-footer';
        footer.append(buildButton({
            className: 'bc-task-continue',
            label: 'Back to Review',
            title: 'Go back to the Review page.',
            onClick: () => {
                latestActions?.goToPage?.(7);
            },
        }));
        root.append(footer);

        host.replaceChildren(root);
        return heading;
    }

    return {
        key: 'avatar',
        title: 'Avatar Studio & Create',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call; the compositor instance and the
         * revision-keyed payload cache persist across renders.
         *
         * @param {Element} container Canvas container.
         * @param {object} snapshot `TaskWizardState#getSnapshot()` payload.
         * @param {object} actions Controller actions facade.
         * @returns {Element|null} The page heading (focus target).
         */
        render(container, snapshot, actions) {
            if (container) {
                host = container;
            }
            latestSnapshot = snapshot ?? latestSnapshot;
            latestActions = actions ?? latestActions;
            if (!host) {
                return null;
            }
            return renderPage();
        },
        /**
         * Releases stored references and disposes the compositor. An
         * in-flight fetch or create is guarded by the disposed host and
         * cannot re-render.
         *
         * @returns {void}
         */
        dispose() {
            compositor?.dispose?.();
            compositor = null;
            compositorHost = null;
            compositorSourcesKey = null;
            layoutDraft = null;
            host = null;
            latestSnapshot = null;
            latestActions = null;
            cache = { revision: null, payload: null, error: null };
            activeFetch = null;
            createState = { status: 'idle', error: null, result: null };
        },
    };
}
