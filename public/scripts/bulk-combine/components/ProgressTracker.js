'use strict';

/**
 * @file Generation progress tracker (Stage 2).
 *
 * Integrated (non-overlay) progress display bound to a `.bcw-progress`
 * container (see `templates/stage2.html`). Shows an animated progress bar
 * with `role="progressbar"`, a completed-characters count, an ETA estimate, a
 * cancel button, and a collapsible token-preview log. Driven by SSE job
 * events (server-side generation) or client-side generation callbacks.
 *
 * The tracker operates purely on existing template DOM — it does not create
 * its own markup. All target selectors (`.bcw-progress-fill`,
 * `.bcw-progress-count`, etc.) are defined in `styles.css`.
 */

/**
 * Maximum number of lines retained in the token-preview log.
 *
 * @type {number}
 */
const MAX_TOKEN_LINES = 20;

/**
 * Generation progress tracker bound to a `.bcw-progress` container.
 */
export class ProgressTracker {
    /**
     * Create a tracker bound to the given container element.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} container Host `.bcw-progress` element.
     */
    constructor(container) {
        /** @type {JQuery<HTMLElement>} */
        this._$container = $(container);
        /** @type {number} */
        this._total = 0;
        /** @type {number} */
        this._current = 0;
        /** @type {number} */
        this._startTime = 0;
        /** @type {(() => void)|null} */
        this._cancelCallback = null;
        this._bindCancel();
    }

    /**
     * Wire the cancel button click handler once.
     *
     * @returns {void}
     */
    _bindCancel() {
        this._$container
            .find('#bcw_progress_cancel')
            .off('click.bcwProgressCancel')
            .on('click.bcwProgressCancel', () => {
                this._cancelCallback?.();
            });
    }

    /**
     * Show the tracker and reset to a starting state.
     *
     * @param {object} [options] Display options.
     * @param {boolean} [options.indeterminate] Whether the total is unknown.
     * @param {number} [options.total] Total number of characters.
     * @returns {void}
     */
    show(options = {}) {
        this._total = Number(options.total) || 0;
        this._current = 0;
        this._startTime = Date.now();
        this._$container.prop('hidden', false);
        this.setIndeterminate(Boolean(options.indeterminate));
        this._setFill(0);
        this._renderCount();
        this._renderEta(null);

        // Reset the token-preview log.
        this._$container
            .find('.bcw-progress-tokens')
            .empty()
            .prop('hidden', true);
    }

    /**
     * Update progress values, switching from indeterminate to determinate
     * automatically on the first call with a finite total.
     *
     * @param {number} current Completed count.
     * @param {number} total Total count.
     * @param {number} [eta] Estimated seconds remaining (computed when omitted).
     * @returns {void}
     */
    updateProgress(current, total, eta) {
        this._total = Number(total) || this._total;
        this._current = Math.max(0, Number(current) || 0);

        if (this._$container.find('.bcw-progress-fill').hasClass('indeterminate')) {
            this.setIndeterminate(false);
        }

        const ratio = this._total > 0 ? this._current / this._total : 0;
        this._setFill(ratio);
        this._renderCount();
        this._renderEta(eta ?? this._computeEta());
    }

    /**
     * Switch the bar between determinate and indeterminate animation states.
     *
     * @param {boolean} enabled `true` for indeterminate (unknown total).
     * @returns {void}
     */
    setIndeterminate(enabled) {
        this._$container
            .find('.bcw-progress-fill')
            .toggleClass('indeterminate', Boolean(enabled))
            .css('width', '');

        const $bar = this._$container.find('.bcw-progress-bar');
        $bar.attr('aria-valuemin', '0');
        $bar.attr('aria-valuemax', String(this._total || 0));
        $bar.attr('aria-valuenow', enabled ? '0' : String(this._current));
    }

    /**
     * Update the status text line (e.g. "Generating XML…").
     *
     * @param {string} text Status text.
     * @returns {void}
     */
    setStatus(text) {
        this._$container.find('.bcw-progress-status').text(String(text ?? ''));
    }

    /**
     * Append a line to the token-preview log, keeping only the most recent
     * {@link MAX_TOKEN_LINES} lines. The log is revealed on the first append.
     *
     * @param {string} text Token text to display.
     * @returns {void}
     */
    addTokenPreview(text) {
        const $tokens = this._$container.find('.bcw-progress-tokens');
        const line = String(text ?? '');
        if ($tokens.length === 0) {
            return;
        }

        $tokens.prop('hidden', false);

        const existing = $tokens.text();
        const lines = existing ? existing.split('\n') : [];
        lines.push(line);
        $tokens.text(lines.slice(-MAX_TOKEN_LINES).join('\n'));

        // Auto-scroll to the newest line.
        const el = $tokens[0];
        if (el) {
            el.scrollTop = el.scrollHeight;
        }
    }

    /**
     * Hide the tracker.
     *
     * @returns {void}
     */
    hide() {
        this._$container.prop('hidden', true);
    }

    /**
     * Register a cancel-button callback.
     *
     * @param {() => void} callback Invoked when the user clicks cancel.
     * @returns {void}
     */
    onCancel(callback) {
        this._cancelCallback = typeof callback === 'function' ? callback : null;
    }

    /**
     * Set the progress-fill width from a 0–1 ratio and sync ARIA values.
     *
     * @param {number} ratio Fill ratio (clamped to 0–1).
     * @returns {void}
     */
    _setFill(ratio) {
        const pct = Math.max(0, Math.min(1, ratio)) * 100;
        this._$container.find('.bcw-progress-fill').css('width', `${pct}%`);

        const $bar = this._$container.find('.bcw-progress-bar');
        $bar.attr('aria-valuenow', String(this._current));
        $bar.attr('aria-valuemax', String(this._total));
    }

    /**
     * Render the "current/total" count text.
     *
     * @returns {void}
     */
    _renderCount() {
        this._$container
            .find('.bcw-progress-count')
            .text(`${this._current}/${this._total}`);
    }

    /**
     * Render the ETA text.
     *
     * @param {number|null} eta Estimated seconds remaining, or null for "--".
     * @returns {void}
     */
    _renderEta(eta) {
        const $eta = this._$container.find('.bcw-progress-eta');
        if (eta == null || !Number.isFinite(eta) || eta < 0) {
            $eta.text('ETA: --');
        } else {
            $eta.text(`ETA: ${Math.round(eta)}s`);
        }
    }

    /**
     * Estimate remaining seconds from elapsed time and completion rate.
     *
     * @returns {number|null} Estimated seconds, or null when unknown.
     */
    _computeEta() {
        if (this._current <= 0 || this._total <= 0) {
            return null;
        }
        const elapsedSec = (Date.now() - this._startTime) / 1000;
        if (elapsedSec <= 0) {
            return null;
        }
        const rate = this._current / elapsedSec;
        if (rate <= 0) {
            return null;
        }
        return (this._total - this._current) / rate;
    }
}
