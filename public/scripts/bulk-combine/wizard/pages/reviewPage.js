'use strict';

/**
 * @file Review page (page 7) for the 8-page Bulk Combine guided task wizard.
 *
 * Loads the assembled review payload (`GET /tasks/:id/review` via
 * `actions.getReview()`, built on read by `artifact-assembler.js`), shows a
 * stale warning when any upstream pass drifted, and renders:
 *
 * - an editable final card (name + description, plus first message when the
 *   payload carries one). Edits persist sparsely into the free-form
 *   `task.review` record via `actions.update({ review: … })` and override
 *   the assembled defaults. Uncommitted edits live in a closure draft map
 *   (`input` updates the draft, `change` PATCHes) so state-driven
 *   re-renders never clobber an in-progress edit;
 * - an explicit Card vs Lorebook destination preview (view-only tabs — the
 *   destination itself is chosen on the Prompt & Settings page).
 *
 * Review-payload caching: the payload is derived on read and any task
 * change can affect it, so the closure cache is keyed by
 * `snapshot.task.revision`. The first render (and every revision change)
 * triggers one deduped fetch; a stale in-flight response is discarded by
 * revision check. The Refresh button forces a refetch at the current
 * revision; failures render an inline error with a Retry button.
 *
 * Rendering NEVER executes: only Refresh/Retry fetch, and only field
 * `change` events PATCH. Continue goes to the Avatar Studio (page 8).
 *
 * Plain DOM only (no jQuery) so the page runs under the Node unit-test
 * environment with light DOM fakes.
 */

/**
 * Passes whose derived staleness makes the assembled review stale.
 *
 * @type {ReadonlyArray<string>}
 */
const UPSTREAM_PASS_KEYS = Object.freeze(['transform1', 'transform2', 'summary']);

/**
 * Character limit for lorebook entry content previews.
 *
 * @type {number}
 */
const ENTRY_PREVIEW_LIMIT = 280;

const STALE_BANNER_TEXT = 'Upstream results changed since this review was assembled — outputs remain inspectable. Refresh to re-assemble from the latest results.';
const LOADING_TEXT = 'Assembling the review payload…';
const REFRESH_TITLE = 'Re-assemble the review payload from the latest task state.';
const RETRY_TITLE = 'Try loading the review payload again.';
const DESTINATION_NOTE = 'Preview only — the destination is chosen on the Prompt & Settings page.';

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
 * Assembled card description: the post-processed output when post-processing
 * is enabled and produced text, else the merged transform description.
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
 * First message from the payload, when present (not emitted by the current
 * assembler; supported defensively under either key).
 *
 * @param {object} [payload] Review payload.
 * @returns {string|undefined} First message, or undefined.
 */
function firstMesOf(payload) {
    return stringOrUndefined(payload?.firstMes) ?? stringOrUndefined(payload?.firstMessage);
}

/**
 * Sorted lorebook entries from the payload (`displayIndex`, then `uid`).
 *
 * @param {object} [payload] Review payload.
 * @returns {object[]} Entry records.
 */
function lorebookEntriesOf(payload) {
    const entries = isRecord(payload?.lorebookData?.entries) ? payload.lorebookData.entries : {};
    return Object.values(entries).sort((a, b) => {
        const aIndex = Number.isSafeInteger(a?.displayIndex) ? a.displayIndex : (Number.isSafeInteger(a?.uid) ? a.uid : 0);
        const bIndex = Number.isSafeInteger(b?.displayIndex) ? b.displayIndex : (Number.isSafeInteger(b?.uid) ? b.uid : 0);
        return aIndex - bIndex;
    });
}

/**
 * Sends a sparse optimistic PATCH through the actions facade. Never throws:
 * failures are logged and reported as `false` so callers can keep the draft.
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
        console.error('reviewPage: failed to update the task.', error);
        return Promise.resolve(false);
    }
    return Promise.resolve(result).then(
        () => true,
        (error) => {
            console.error('reviewPage: failed to update the task.', error);
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
 * Creates the Review page module for the controller's page registry.
 *
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createReviewPage() {
    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /** @type {Map<string, string>} Uncommitted field drafts (anti-clobber). */
    const drafts = new Map();
    /**
     * Revision-keyed payload cache: `{ revision, payload, error }`.
     *
     * @type {{revision: number|null, payload: object|null, error: string|null}}
     */
    let cache = { revision: null, payload: null, error: null };
    /** @type {boolean} Whether a getReview fetch is in flight (dedupe). */
    let fetchInFlight = false;
    /** @type {string|null} Active destination-preview tab (defaults to the payload's destination). */
    let activeTab = null;

    /**
     * Effective value of an editable review field: uncommitted draft, then
     * the persisted `task.review` edit, then the payload-derived default.
     *
     * @param {string} key Field key (`name` | `description` | `firstMes`).
     * @param {string|undefined} payloadDefault Payload-derived default.
     * @returns {string} Effective value.
     */
    function effectiveField(key, payloadDefault) {
        if (drafts.has(key)) {
            return drafts.get(key);
        }
        return stringOrUndefined(reviewEditsOf(latestSnapshot)[key]) ?? payloadDefault ?? '';
    }

    /**
     * Starts the deduped review-payload fetch for a revision.
     *
     * @param {number} revision Task revision to fetch at.
     * @returns {void}
     */
    function startFetch(revision) {
        fetchInFlight = true;
        let result;
        try {
            result = latestActions?.getReview?.();
        } catch (error) {
            settleFetch(null, error, revision);
            return;
        }
        if (result === undefined || result === null) {
            settleFetch(null, new Error('getReview is unavailable.'), revision);
            return;
        }
        Promise.resolve(result).then(
            (payload) => settleFetch(payload, null, revision),
            (error) => settleFetch(null, error, revision),
        );
    }

    /**
     * Settles an in-flight fetch: caches the outcome and re-renders, unless
     * the page was disposed or the task revision moved on (stale response —
     * the next render refetches at the new revision).
     *
     * @param {object|null} payload Review payload on success.
     * @param {unknown} error Failure on error.
     * @param {number} revision Revision the fetch was started for.
     * @returns {void}
     */
    function settleFetch(payload, error, revision) {
        fetchInFlight = false;
        if (!host || revision !== revisionOf(latestSnapshot)) {
            return;
        }
        cache = {
            revision,
            payload: isRecord(payload) ? payload : null,
            error: error === null || error === undefined ? null : String(error),
        };
        renderPage();
    }

    /**
     * Forces a refetch at the current revision (Refresh / Retry buttons).
     *
     * @returns {void}
     */
    function forceRefetch() {
        cache.revision = null;
        renderPage();
    }

    /**
     * Builds the stale-warning banner (`role="status"`).
     *
     * @returns {Element} Banner element.
     */
    function buildStaleBanner() {
        const banner = document.createElement('div');
        banner.className = 'bc-task-review-stale';
        banner.setAttribute('role', 'status');

        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-triangle-exclamation';
        icon.setAttribute('aria-hidden', 'true');

        const text = document.createElement('p');
        text.className = 'bc-task-review-stale-text';
        text.textContent = STALE_BANNER_TEXT;

        banner.append(icon, text);
        return banner;
    }

    /**
     * Builds one editable review field (label + input/textarea) wired to the
     * draft map: `input` updates the draft, `change` PATCHes `task.review`.
     *
     * @param {object} options Field options.
     * @param {string} options.key Field key in `task.review`.
     * @param {string} options.label Label text.
     * @param {string} options.value Effective value to display.
     * @param {boolean} [options.multiline] Render a textarea instead of an input.
     * @returns {Element} Field wrapper.
     */
    function buildEditField({ key, label, value, multiline }) {
        const wrapper = document.createElement('div');
        wrapper.className = 'bc-task-review-field';

        const labelElement = document.createElement('label');
        labelElement.className = 'bc-task-review-label';
        labelElement.setAttribute('for', `bc-task-review-${key}`);
        labelElement.textContent = label;

        const field = document.createElement(multiline ? 'textarea' : 'input');
        field.id = `bc-task-review-${key}`;
        field.className = `bc-task-review-${key}`;
        if (!multiline) {
            field.type = 'text';
        } else {
            field.setAttribute('rows', '12');
        }
        field.value = value;
        field.addEventListener('input', () => {
            drafts.set(key, String(field.value ?? ''));
        });
        field.addEventListener('change', () => {
            const committed = String(field.value ?? '');
            drafts.set(key, committed);
            void applyPatch(latestActions, { review: { [key]: committed } }).then((ok) => {
                if (ok && drafts.get(key) === committed) {
                    drafts.delete(key);
                }
            });
        });

        wrapper.append(labelElement, field);
        return wrapper;
    }

    /**
     * Builds the editable final-card section (name + description + optional
     * first message) from the cached payload.
     *
     * @param {object} payload Review payload.
     * @returns {Element} Card section.
     */
    function buildCardSection(payload) {
        const section = document.createElement('section');
        section.className = 'bc-task-review-card';
        section.setAttribute('aria-label', 'Final card');

        const title = document.createElement('h3');
        title.className = 'bc-task-review-section-title';
        title.textContent = 'Final card';
        section.append(title);

        section.append(buildEditField({ key: 'name', label: 'Name', value: effectiveField('name', defaultNameOf(payload)) }));
        section.append(buildEditField({
            key: 'description',
            label: 'Description',
            value: effectiveField('description', defaultDescriptionOf(payload)),
            multiline: true,
        }));
        const firstMes = firstMesOf(payload);
        if (firstMes !== undefined) {
            section.append(buildEditField({
                key: 'firstMes',
                label: 'First message',
                value: effectiveField('firstMes', firstMes),
                multiline: true,
            }));
        }
        return section;
    }

    /**
     * Builds one lorebook entry row (name, order, keys, content preview).
     *
     * @param {object} entry Lorebook entry record.
     * @param {number} index Fallback position.
     * @returns {Element} Entry element.
     */
    function buildLorebookEntry(entry, index) {
        const keys = Array.isArray(entry?.key) ? entry.key.map(String).filter(Boolean) : [];
        const name = String(entry?.comment ?? '').trim() || keys[0] || `Entry ${index + 1}`;
        const content = typeof entry?.content === 'string' ? entry.content : '';
        const order = Number.isSafeInteger(entry?.order) ? entry.order : '?';

        const article = document.createElement('article');
        article.className = 'bc-task-review-entry';

        const head = document.createElement('div');
        head.className = 'bc-task-review-entry-head';
        const nameElement = document.createElement('span');
        nameElement.className = 'bc-task-review-entry-name';
        nameElement.textContent = name;
        nameElement.title = name;
        const orderElement = document.createElement('span');
        orderElement.className = 'bc-task-review-entry-order';
        orderElement.textContent = `order ${order}`;
        head.append(nameElement, orderElement);

        const keysElement = document.createElement('div');
        keysElement.className = 'bc-task-review-entry-keys';
        keysElement.textContent = keys.length > 0 ? `Keys: ${keys.join(', ')}` : 'Keys: (none)';

        const preview = document.createElement('p');
        preview.className = 'bc-task-review-entry-preview';
        preview.textContent = content.length > ENTRY_PREVIEW_LIMIT
            ? `${content.slice(0, ENTRY_PREVIEW_LIMIT)}…`
            : (content || '(empty)');

        article.append(head, keysElement, preview);
        return article;
    }

    /**
     * Builds the destination-preview section: Card vs Lorebook tabs.
     *
     * @param {object} payload Review payload.
     * @returns {Element} Destination section.
     */
    function buildDestinationSection(payload) {
        const destination = payload?.destination === 'lorebook' ? 'lorebook' : 'card';
        const selected = activeTab ?? destination;

        const section = document.createElement('section');
        section.className = 'bc-task-review-destination';
        section.setAttribute('aria-label', 'Destination preview');

        const title = document.createElement('h3');
        title.className = 'bc-task-review-section-title';
        title.textContent = 'Destination preview';

        const note = document.createElement('p');
        note.className = 'bc-task-review-destination-note';
        note.textContent = DESTINATION_NOTE;

        const tabs = document.createElement('div');
        tabs.className = 'bc-task-review-tabs';
        tabs.setAttribute('role', 'tablist');
        tabs.setAttribute('aria-label', 'Destination preview');

        for (const [tabKey, tabLabel] of [['card', 'Card'], ['lorebook', 'Lorebook entries']]) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'bc-task-review-tab';
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', selected === tabKey ? 'true' : 'false');
            tab.textContent = tabLabel;
            if (destination === tabKey) {
                const badge = document.createElement('span');
                badge.className = 'bc-task-review-tab-badge';
                badge.textContent = 'destination';
                tab.append(badge);
            }
            tab.addEventListener('click', () => {
                activeTab = tabKey;
                renderPage();
            });
            tabs.append(tab);
        }

        section.append(title, note, tabs);

        if (selected === 'card') {
            const preview = document.createElement('pre');
            preview.className = 'bc-task-review-card-preview';
            preview.setAttribute('role', 'tabpanel');
            const text = effectiveField('description', defaultDescriptionOf(payload));
            preview.textContent = text || 'Nothing assembled yet — run the transform passes, then Refresh.';
            section.append(preview);
        } else {
            const lorebook = document.createElement('div');
            lorebook.className = 'bc-task-review-lorebook';
            lorebook.setAttribute('role', 'tabpanel');
            const entries = lorebookEntriesOf(payload);
            if (entries.length === 0) {
                const empty = document.createElement('p');
                empty.className = 'bc-task-review-lorebook-note';
                empty.textContent = destination === 'lorebook'
                    ? 'No lorebook entries could be assembled yet — run the transform passes, then Refresh.'
                    : 'Destination is the card description — no lorebook entries will be created.';
                lorebook.append(empty);
            } else {
                for (const [index, entry] of entries.entries()) {
                    lorebook.append(buildLorebookEntry(entry, index));
                }
            }
            section.append(lorebook);
        }

        return section;
    }

    /**
     * Builds the page body according to the cache state (loading / error /
     * payload sections).
     *
     * @returns {Element[]} Body elements.
     */
    function buildBody() {
        if (cache.error !== null) {
            const box = document.createElement('div');
            box.className = 'bc-task-review-error';
            box.setAttribute('role', 'alert');
            const text = document.createElement('p');
            text.className = 'bc-task-review-error-text';
            text.textContent = `Failed to load the review payload: ${cache.error}`;
            box.append(text, buildButton({
                className: 'bc-task-review-retry',
                label: 'Retry',
                title: RETRY_TITLE,
                onClick: forceRefetch,
            }));
            return [box];
        }
        if (cache.payload === null) {
            const loading = document.createElement('p');
            loading.className = 'bc-task-review-loading';
            loading.setAttribute('role', 'status');
            loading.textContent = LOADING_TEXT;
            return [loading];
        }
        return [buildCardSection(cache.payload), buildDestinationSection(cache.payload)];
    }

    /**
     * Rebuilds the whole page from the latest snapshot into the host,
     * starting a payload fetch when the revision has no cached outcome.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        const revision = revisionOf(latestSnapshot);
        if (cache.revision !== revision && !fetchInFlight) {
            startFetch(revision);
        }

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-review';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = 'Review';

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'The final card is assembled from the latest successful transform results (and post-processing, when enabled). Edits you make here are saved on this task and override the assembled defaults.';

        root.append(heading, guidance);
        if (upstreamStale(latestSnapshot)) {
            root.append(buildStaleBanner());
        }

        const toolbar = document.createElement('div');
        toolbar.className = 'bc-task-review-toolbar';
        toolbar.append(buildButton({
            className: 'bc-task-review-refresh',
            label: 'Refresh',
            title: REFRESH_TITLE,
            disabled: fetchInFlight && cache.payload === null && cache.error === null,
            onClick: forceRefetch,
        }));
        root.append(toolbar, ...buildBody());

        const footer = document.createElement('footer');
        footer.className = 'bc-task-review-footer';
        footer.append(buildButton({
            className: 'bc-task-continue',
            label: 'Continue to Avatar Studio',
            title: 'Go to the Avatar Studio & Create page.',
            onClick: () => {
                latestActions?.goToPage?.(8);
            },
        }));
        root.append(footer);

        host.replaceChildren(root);
        return heading;
    }

    return {
        key: 'review',
        title: 'Review',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call; the review payload is fetched
         * once per task revision and closure-cached in between.
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
         * Releases stored references and clears drafts/cache. An in-flight
         * fetch is guarded by the disposed host and cannot re-render.
         *
         * @returns {void}
         */
        dispose() {
            host = null;
            latestSnapshot = null;
            latestActions = null;
            drafts.clear();
            cache = { revision: null, payload: null, error: null };
            activeTab = null;
        },
    };
}
