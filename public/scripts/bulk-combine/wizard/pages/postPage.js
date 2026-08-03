'use strict';

/**
 * @file Post Processing page (page 6) for the 8-page Bulk Combine guided task wizard.
 *
 * Renders the post-processing workspace: a status banner (from
 * `task.post.status` plus upstream derived staleness), the post prompt
 * textarea with an LLM prompt-assist row, the replace/prepend/append mode
 * select, a before/after panel (`task.post.input` captured by the server at
 * run time vs `task.post.output`), and the Run / Skip / Continue toolbar.
 *
 * Page-module contract: `render(container, snapshot, actions) → Element`
 * (the page heading, used as the focus target). The page rebuilds via
 * `container.replaceChildren` on every render; listeners live only on the
 * replaced children. Uncommitted textarea/input edits are held in a closure
 * draft map: `input` events update the draft, `change` events send a sparse
 * PATCH, and re-renders always prefer the draft over the server value so an
 * in-progress edit is never clobbered by a state-driven re-render.
 *
 * Rendering NEVER executes: only the explicit Run / Skip / Suggest buttons
 * fire `actions.runPostProcess` / `actions.update` / `actions.runPromptAssist`.
 * Run is fire-and-forget (202): the page shows an optimistic "running"
 * indicator (closure marker) until a snapshot arrives whose `task.post`
 * record differs from the one at click time.
 *
 * Plain DOM only (no jQuery) so the page runs under the Node unit-test
 * environment with light DOM fakes.
 */

/**
 * Passes whose derived staleness makes a settled post output stale.
 *
 * @type {ReadonlyArray<string>}
 */
const UPSTREAM_PASS_KEYS = Object.freeze(['transform1', 'transform2', 'summary']);

/**
 * Empty prompt-assistant record (matches `newAssistantProposal` in
 * `src/util/bulk-combine/task-state.js`); Dismiss PATCHes exactly this.
 *
 * @type {Readonly<object>}
 */
const EMPTY_ASSISTANT = Object.freeze({ request: '', proposal: '', diff: '', applied: false, error: '' });

/**
 * Post-processing combine modes with their one-line explanations.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const POST_MODES = Object.freeze([
    ['replace', 'Replace — the final description becomes exactly what the post-process returns.'],
    ['prepend', 'Prepend — the post-process result is inserted before the assembled description.'],
    ['append', 'Append — the post-process result is added after the assembled description.'],
]);

const RUN_TITLE = 'Run post-processing now. Fire-and-forget: progress arrives over the task event stream.';
const RUN_NO_TEXT_TITLE = 'Enter a post-processing prompt first.';
const RUN_RUNNING_TITLE = 'Post-processing is already running.';
const SKIP_TITLE = 'Record post-processing as skipped and keep the assembled text unchanged.';
const UNSKIP_TITLE = 'Return post-processing to pending.';
const CONTINUE_LOCKED_TITLE = 'Run post-processing to completion or Skip it first.';
const STALE_NOTE = 'Upstream results changed since this run — the output below may no longer match the latest transforms.';

/**
 * Reads the post record from a snapshot, tolerating partial shapes.
 *
 * @param {object} [snapshot] State snapshot (`{ task }`).
 * @returns {object} Post record (possibly empty).
 */
function postOf(snapshot) {
    const post = snapshot?.task?.post;
    return post !== null && typeof post === 'object' ? post : {};
}

/**
 * Normalizes the post status for display. Unknown/absent values become
 * 'pending'; 'running' is honored defensively even though the current
 * server only checkpoints settled statuses.
 *
 * @param {object} post Post record.
 * @returns {string} Status key.
 */
function postStatusOf(post) {
    const status = typeof post?.status === 'string' ? post.status : 'pending';
    return ['pending', 'running', 'succeeded', 'failed', 'skipped'].includes(status) ? status : 'pending';
}

/**
 * Fingerprint of the post record used to detect that a fire-and-forget run
 * settled (a later snapshot carries a different record).
 *
 * @param {object} post Post record.
 * @returns {string} Stable signature.
 */
function postSignature(post) {
    return JSON.stringify({
        status: typeof post?.status === 'string' ? post.status : null,
        input: typeof post?.input === 'string' ? post.input : '',
        output: typeof post?.output === 'string' ? post.output : '',
        error: typeof post?.error === 'string' ? post.error : null,
    });
}

/**
 * Whether any upstream pass feeding the post input is stale.
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {boolean} True when transform1/transform2/summary is stale.
 */
function upstreamStale(snapshot) {
    const stale = snapshot?.derivedStaleness ?? snapshot?.task?.derivedStaleness ?? {};
    return UPSTREAM_PASS_KEYS.some((key) => stale?.[key]?.stale === true);
}

/**
 * Reads the post prompt record from a snapshot.
 *
 * @param {object} [snapshot] State snapshot.
 * @returns {{text: string, assistant: object}} Prompt record.
 */
function promptOf(snapshot) {
    const prompt = snapshot?.task?.prompts?.post;
    const assistant = prompt?.assistant !== null && typeof prompt?.assistant === 'object' ? prompt.assistant : {};
    return {
        text: typeof prompt?.text === 'string' ? prompt.text : '',
        assistant: {
            request: typeof assistant.request === 'string' ? assistant.request : '',
            proposal: typeof assistant.proposal === 'string' ? assistant.proposal : '',
            diff: typeof assistant.diff === 'string' ? assistant.diff : '',
            applied: assistant.applied === true,
            error: typeof assistant.error === 'string' ? assistant.error : '',
        },
    };
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
        console.error('postPage: failed to update the task.', error);
        return Promise.resolve(false);
    }
    return Promise.resolve(result).then(
        () => true,
        (error) => {
            console.error('postPage: failed to update the task.', error);
            return false;
        },
    );
}

/**
 * Builds a text button with a tooltip and accessible name.
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
 * Creates the Post Processing page module for the controller's registry.
 *
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createPostPage() {
    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /** @type {Map<string, string>} Uncommitted field drafts (anti-clobber). */
    const drafts = new Map();
    /**
     * Optimistic run marker: set when Run is clicked, cleared once a
     * snapshot arrives whose post record differs from the click-time one.
     *
     * @type {{signature: string}|null}
     */
    let pendingRun = null;

    /**
     * Effective prompt text: the uncommitted draft wins over the server.
     *
     * @returns {string} Prompt text to display/validate.
     */
    function effectivePromptText() {
        return drafts.has('text') ? drafts.get('text') : promptOf(latestSnapshot).text;
    }

    /**
     * Whether post-processing is currently running (optimistic marker or a
     * defensive server-side 'running' status).
     *
     * @returns {boolean} True while running.
     */
    function isRunning() {
        return pendingRun !== null || postStatusOf(postOf(latestSnapshot)) === 'running';
    }

    /**
     * Fires the fire-and-forget post-process run and re-renders so the
     * running indicator appears immediately.
     *
     * @returns {void}
     */
    function fireRun() {
        pendingRun = { signature: postSignature(postOf(latestSnapshot)) };
        const marker = pendingRun;
        let result;
        try {
            result = latestActions?.runPostProcess?.();
        } catch (error) {
            console.error('postPage: failed to start post-processing.', error);
            pendingRun = null;
            renderPage();
            return;
        }
        Promise.resolve(result).catch((error) => {
            console.error('postPage: post-processing request failed.', error);
            if (pendingRun === marker) {
                pendingRun = null;
                renderPage();
            }
        });
        renderPage();
    }

    /**
     * Run handler: commits an uncommitted prompt draft first so the server
     * runs against the text the user actually sees, then fires the run.
     *
     * @returns {void}
     */
    function handleRun() {
        if (isRunning() || !effectivePromptText().trim()) {
            return;
        }
        const draft = drafts.get('text');
        if (draft !== undefined && draft !== promptOf(latestSnapshot).text) {
            void applyPatch(latestActions, { prompts: { post: { text: draft } } }).then((ok) => {
                if (!ok) {
                    return;
                }
                drafts.delete('text');
                fireRun();
            });
            return;
        }
        fireRun();
    }

    /**
     * Builds the status banner (`role="status"`, `data-status` for CSS).
     *
     * @param {boolean} postEnabled Whether post-processing is enabled.
     * @param {string} status Normalized post status.
     * @param {object} post Post record.
     * @returns {Element} Banner element.
     */
    function buildBanner(postEnabled, status, post) {
        const effective = !postEnabled ? 'disabled' : (isRunning() ? 'running' : status);
        const texts = {
            pending: 'Post-processing has not run yet. Review the prompt and mode, then Run — or Skip to continue without it.',
            running: 'Post-processing is running… the result appears below when it settles.',
            succeeded: 'Post-processing succeeded — the output below feeds the final card on the Review page.',
            failed: `Post-processing failed: ${String(post?.error ?? '') || 'unknown error'}. Adjust the prompt and Run again, or Skip.`,
            skipped: 'Post-processing was skipped — the assembled transform results feed the final card unchanged.',
            disabled: 'Post-processing is disabled for this task. Enable it on the Prompt & Settings page, or continue to Review.',
        };
        const icons = {
            pending: 'fa-circle-info',
            running: 'fa-spinner fa-spin',
            succeeded: 'fa-circle-check',
            failed: 'fa-triangle-exclamation',
            skipped: 'fa-forward',
            disabled: 'fa-ban',
        };

        const banner = document.createElement('div');
        banner.className = 'bc-task-post-banner';
        banner.setAttribute('data-status', effective);
        banner.setAttribute('role', 'status');

        const icon = document.createElement('i');
        icon.className = `fa-solid ${icons[effective]}`;
        icon.setAttribute('aria-hidden', 'true');

        const body = document.createElement('div');
        body.className = 'bc-task-post-banner-body';

        const line = document.createElement('p');
        line.className = 'bc-task-post-banner-text';
        line.textContent = texts[effective];
        body.append(line);

        if (postEnabled && status === 'succeeded' && upstreamStale(latestSnapshot)) {
            const stale = document.createElement('p');
            stale.className = 'bc-task-post-stale';
            stale.textContent = STALE_NOTE;
            body.append(stale);
        }

        banner.append(icon, body);
        return banner;
    }

    /**
     * Builds the prompt-assist row: request input, Suggest button, and the
     * proposal / error / waiting states from `prompts.post.assistant`.
     *
     * @returns {Element} Assist section.
     */
    function buildAssistSection() {
        const { assistant } = promptOf(latestSnapshot);

        const section = document.createElement('div');
        section.className = 'bc-task-assist';

        const row = document.createElement('div');
        row.className = 'bc-task-assist-row';

        const request = document.createElement('input');
        request.type = 'text';
        request.className = 'bc-task-assist-request';
        request.placeholder = 'Ask the LLM to revise the prompt…';
        request.setAttribute('aria-label', 'Prompt assist request');
        request.value = drafts.has('assistRequest') ? drafts.get('assistRequest') : assistant.request;
        request.addEventListener('input', () => {
            drafts.set('assistRequest', String(request.value ?? ''));
        });
        request.addEventListener('change', () => {
            // The request is only persisted by the assist route itself (Suggest);
            // the draft survives re-renders until then.
            drafts.set('assistRequest', String(request.value ?? ''));
        });

        const suggest = buildButton({
            className: 'bc-task-assist-suggest',
            label: 'Suggest',
            title: 'Ask the LLM to propose a revised post-processing prompt.',
            disabled: !String(request.value ?? '').trim(),
            onClick: () => {
                const text = (drafts.has('assistRequest') ? drafts.get('assistRequest') : String(request.value ?? '')).trim();
                if (!text) {
                    return;
                }
                drafts.delete('assistRequest');
                let result;
                try {
                    result = latestActions?.runPromptAssist?.('post', { request: text });
                } catch (error) {
                    console.error('postPage: failed to request a prompt proposal.', error);
                    return;
                }
                Promise.resolve(result).catch((error) => {
                    console.error('postPage: failed to request a prompt proposal.', error);
                });
            },
        });
        // Keep Suggest's disabled state in sync while typing.
        request.addEventListener('input', () => {
            suggest.disabled = !String(request.value ?? '').trim();
        });

        row.append(request, suggest);
        section.append(row);

        if (assistant.error) {
            const error = document.createElement('p');
            error.className = 'bc-task-assist-error';
            error.setAttribute('role', 'alert');
            error.textContent = `Prompt assist failed: ${assistant.error}`;
            section.append(error);
        } else if (assistant.proposal) {
            const proposal = document.createElement('div');
            proposal.className = 'bc-task-assist-proposal';

            const text = document.createElement('pre');
            text.className = 'bc-task-assist-proposal-text';
            text.textContent = assistant.proposal;

            const actions = document.createElement('div');
            actions.className = 'bc-task-assist-actions';
            if (assistant.applied) {
                const applied = document.createElement('span');
                applied.className = 'bc-task-assist-applied';
                applied.textContent = 'Proposal applied.';
                actions.append(applied);
            } else {
                actions.append(buildButton({
                    className: 'bc-task-assist-apply',
                    label: 'Apply',
                    title: 'Replace the prompt with the proposal. Marks dependent results stale.',
                    onClick: () => {
                        const current = promptOf(latestSnapshot).assistant;
                        drafts.delete('text');
                        void applyPatch(latestActions, {
                            prompts: { post: { text: current.proposal, assistant: { ...current, applied: true } } },
                        });
                    },
                }));
            }
            actions.append(buildButton({
                className: 'bc-task-assist-dismiss',
                label: 'Dismiss',
                title: 'Discard the proposal and keep the current prompt.',
                onClick: () => {
                    void applyPatch(latestActions, { prompts: { post: { assistant: { ...EMPTY_ASSISTANT } } } });
                },
            }));

            proposal.append(text, actions);
            section.append(proposal);
        } else if (assistant.request) {
            const waiting = document.createElement('p');
            waiting.className = 'bc-task-assist-status';
            waiting.setAttribute('role', 'status');
            waiting.textContent = 'Waiting for a proposal…';
            section.append(waiting);
        }

        return section;
    }

    /**
     * Builds the prompt workspace: textarea, mode select, and assist row.
     *
     * @returns {Element} Workspace section.
     */
    function buildWorkspace() {
        const settings = latestSnapshot?.task?.settings ?? {};
        const mode = typeof settings.postProcessingMode === 'string' ? settings.postProcessingMode : 'replace';

        const section = document.createElement('section');
        section.className = 'bc-task-post-workspace';
        section.setAttribute('aria-label', 'Post-processing prompt');

        const title = document.createElement('h3');
        title.className = 'bc-task-post-section-title';
        title.textContent = 'Post-processing prompt';

        const note = document.createElement('p');
        note.className = 'bc-task-post-note';
        note.textContent = 'The prompt runs once over the whole assembled description. Choose how the result combines with the assembled text.';

        const promptLabel = document.createElement('label');
        promptLabel.className = 'bc-task-post-label';
        promptLabel.setAttribute('for', 'bc-task-post-prompt');
        promptLabel.textContent = 'Prompt';

        const textarea = document.createElement('textarea');
        textarea.id = 'bc-task-post-prompt';
        textarea.className = 'bc-task-post-prompt';
        textarea.setAttribute('rows', '6');
        textarea.value = effectivePromptText();
        textarea.addEventListener('input', () => {
            drafts.set('text', String(textarea.value ?? ''));
        });
        textarea.addEventListener('change', () => {
            const value = String(textarea.value ?? '');
            drafts.set('text', value);
            void applyPatch(latestActions, { prompts: { post: { text: value } } }).then((ok) => {
                if (ok && drafts.get('text') === value) {
                    drafts.delete('text');
                }
            });
        });

        const modeRow = document.createElement('div');
        modeRow.className = 'bc-task-post-mode-row';
        const modeLabel = document.createElement('label');
        modeLabel.className = 'bc-task-post-label';
        modeLabel.setAttribute('for', 'bc-task-post-mode');
        modeLabel.textContent = 'Combine mode';
        const select = document.createElement('select');
        select.id = 'bc-task-post-mode';
        select.className = 'bc-task-post-mode';
        for (const [value, explanation] of POST_MODES) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = value.charAt(0).toUpperCase() + value.slice(1);
            option.title = explanation;
            select.append(option);
        }
        select.value = POST_MODES.some(([value]) => value === mode) ? mode : 'replace';
        modeRow.append(modeLabel, select);

        const modeNote = document.createElement('p');
        modeNote.className = 'bc-task-post-mode-note';
        modeNote.textContent = POST_MODES.find(([value]) => value === select.value)?.[1] ?? POST_MODES[0][1];

        select.addEventListener('change', () => {
            const value = String(select.value ?? 'replace');
            modeNote.textContent = POST_MODES.find(([modeValue]) => modeValue === value)?.[1] ?? '';
            void applyPatch(latestActions, { settings: { postProcessingMode: value } });
        });

        section.append(title, note, promptLabel, textarea, modeRow, modeNote, buildAssistSection());
        return section;
    }

    /**
     * Builds one before/after pane (monospace, scrollable).
     *
     * @param {string} caption Pane caption.
     * @param {string} content Pane text.
     * @returns {Element} Figure element.
     */
    function buildPane(caption, content) {
        const figure = document.createElement('figure');
        figure.className = 'bc-task-post-pane-block';
        const figcaption = document.createElement('figcaption');
        figcaption.className = 'bc-task-post-pane-title';
        figcaption.textContent = caption;
        const pre = document.createElement('pre');
        pre.className = 'bc-task-post-pane';
        pre.textContent = content;
        figure.append(figcaption, pre);
        return figure;
    }

    /**
     * Builds the before/after panel: the server-captured pre-post input vs
     * the post-processed output, or a running indicator while running.
     *
     * @param {object} post Post record.
     * @param {string} status Normalized post status.
     * @returns {Element|null} Panel section, or null when there is nothing to show.
     */
    function buildBeforeAfter(post, status) {
        const running = isRunning();
        const input = typeof post?.input === 'string' ? post.input : '';
        const output = typeof post?.output === 'string' ? post.output : '';
        if (!running && !input && !output) {
            return null;
        }

        const section = document.createElement('section');
        section.className = 'bc-task-post-beforeafter';
        section.setAttribute('aria-label', 'Before and after');

        const title = document.createElement('h3');
        title.className = 'bc-task-post-section-title';
        title.textContent = 'Before / after';
        section.append(title);

        if (running) {
            const indicator = document.createElement('p');
            indicator.className = 'bc-task-post-running';
            indicator.setAttribute('role', 'status');
            indicator.textContent = 'Post-processing is running…';
            section.append(indicator);
            return section;
        }

        const panes = document.createElement('div');
        panes.className = 'bc-task-post-panes';
        panes.append(
            buildPane('Before — assembled transform results', input || '(empty)'),
            buildPane('After — post-processed result', output || (status === 'failed' ? '(post-processing failed)' : '(empty)')),
        );
        section.append(panes);
        return section;
    }

    /**
     * Builds the toolbar: Run, Skip/Unskip, and Continue to Review.
     *
     * @param {boolean} postEnabled Whether post-processing is enabled.
     * @param {string} status Normalized post status.
     * @returns {Element} Footer element.
     */
    function buildFooter(postEnabled, status) {
        const running = isRunning();
        const hasText = Boolean(effectivePromptText().trim());

        const footer = document.createElement('footer');
        footer.className = 'bc-task-post-footer';

        if (postEnabled) {
            footer.append(buildButton({
                className: 'bc-task-post-run',
                label: 'Run',
                title: running ? RUN_RUNNING_TITLE : (hasText ? RUN_TITLE : RUN_NO_TEXT_TITLE),
                disabled: running || !hasText,
                onClick: handleRun,
            }));

            const skipped = status === 'skipped';
            footer.append(buildButton({
                className: 'bc-task-post-skip',
                label: skipped ? 'Unskip' : 'Skip',
                title: skipped ? UNSKIP_TITLE : SKIP_TITLE,
                disabled: running,
                onClick: () => {
                    void applyPatch(latestActions, { post: { status: skipped ? 'pending' : 'skipped' } });
                },
            }));
        }

        // A disabled post page is a deliberate skip: Continue stays open.
        const canContinue = !postEnabled || (!running && (status === 'succeeded' || status === 'skipped'));
        footer.append(buildButton({
            className: 'bc-task-continue',
            label: 'Continue to Review',
            title: canContinue ? 'Go to the Review page.' : CONTINUE_LOCKED_TITLE,
            disabled: !canContinue,
            onClick: () => {
                if (canContinue) {
                    latestActions?.goToPage?.(7);
                }
            },
        }));

        return footer;
    }

    /**
     * Rebuilds the whole page from the latest snapshot into the host.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        const post = postOf(latestSnapshot);
        if (pendingRun && postSignature(post) !== pendingRun.signature) {
            pendingRun = null;
        }
        const postEnabled = latestSnapshot?.task?.settings?.postProcessingEnabled === true;
        const status = postStatusOf(post);

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-post';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = 'Post Processing';

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'Post-processing runs one extra LLM pass over the assembled card description. Run it, or explicitly Skip to keep the assembled text unchanged.';

        root.append(heading, guidance, buildBanner(postEnabled, status, post));
        if (postEnabled) {
            root.append(buildWorkspace());
            const beforeAfter = buildBeforeAfter(post, status);
            if (beforeAfter) {
                root.append(beforeAfter);
            }
        }
        root.append(buildFooter(postEnabled, status));

        host.replaceChildren(root);
        return heading;
    }

    return {
        key: 'post',
        title: 'Post Processing',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call; uncommitted drafts win over the
         * server values so re-renders never clobber an in-progress edit.
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
         * Releases stored references and clears drafts. No listeners were
         * added to external targets, so there is nothing else to detach.
         *
         * @returns {void}
         */
        dispose() {
            host = null;
            latestSnapshot = null;
            latestActions = null;
            drafts.clear();
            pendingRun = null;
        },
    };
}
