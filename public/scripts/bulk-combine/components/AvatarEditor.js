'use strict';

/**
 * @file Expanded composite avatar editor (Stage 5).
 *
 * Full studio panel: live preview canvas, layout picker (Voronoi / Grid),
 * aspect-ratio selector (presets + custom text), cell-gap / max-cols sliders
 * (grid mode), and per-cell controls (scale slider, crop-focus dropdown, drag
 * offset). Cell selection via click; cell order synced with Stage 1 card
 * order. Regenerate posts to `/api/characters/generate-voronoi-composite`.
 */

import {
    characters,
    getRequestHeaders,
    getThumbnailUrl,
    unshallowCharacter,
} from '../../../script.js';
import { getValidSelectedCharacters, getCoreCharacterField } from '../helpers.js';
import { throwIfNotOk } from '../services/JobClient.js';

const VALID_LAYOUTS = ['voronoi', 'grid-portrait', 'grid-square'];
const VALID_CROP_FOCUS = ['attention', 'entropy', 'center', 'top', 'face'];
const OFFSET_MIN = -100;
const OFFSET_MAX = 100;
const SCALE_MIN = 50;
const SCALE_MAX = 200;
const SCALE_STEP = 5;

/**
 * Clamp a numeric value to a range with a fallback.
 *
 * @param {unknown} value Input value.
 * @param {number} min Minimum.
 * @param {number} max Maximum.
 * @param {number} fallback Fallback when non-finite.
 * @returns {number} Clamped integer.
 */
function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Normalise a raw offset into {x, y, scale, cropFocus}.
 *
 * @param {unknown} offset Raw offset.
 * @returns {{x: number, y: number, scale: number, cropFocus: string}} Normalised offset.
 */
function normalizeOffset(offset) {
    return {
        x: clampNumber(offset?.x, OFFSET_MIN, OFFSET_MAX, 0),
        y: clampNumber(offset?.y, OFFSET_MIN, OFFSET_MAX, 0),
        scale: clampNumber(offset?.scale, SCALE_MIN, SCALE_MAX, 100),
        cropFocus: VALID_CROP_FOCUS.includes(offset?.cropFocus)
            ? offset.cropFocus
            : 'attention',
    };
}

/**
 * Compute the bounding box of a cell (rect or polygon).
 *
 * @param {object} cell Cell data from the API response.
 * @returns {{x: number, y: number, w: number, h: number}|null} Bounding box in composite coordinates.
 */
function getCellBounds(cell) {
    if (cell?.type === 'rect') {
        const x = Number(cell.x);
        const y = Number(cell.y);
        const w = Number(cell.w);
        const h = Number(cell.h);
        if ([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0) {
            return { x, y, w, h };
        }
        return null;
    }

    if (!Array.isArray(cell?.points) || cell.points.length < 3) {
        return null;
    }

    const xs = cell.points.map((p) => Number(p?.[0])).filter(Number.isFinite);
    const ys = cell.points.map((p) => Number(p?.[1])).filter(Number.isFinite);
    if (!xs.length || !ys.length) {
        return null;
    }

    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const w = Math.max(...xs) - x;
    const h = Math.max(...ys) - y;
    return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/**
 * Parse a "W:H" aspect-ratio string.
 *
 * @param {string} str Input string.
 * @returns {string|null} Normalised "W:H" string, or null if invalid.
 */
function parseAspectRatio(str) {
    const match = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(String(str).trim());
    if (!match) {
        return null;
    }
    const w = Number(match[1]);
    const h = Number(match[2]);
    if (w <= 0 || h <= 0) {
        return null;
    }
    return `${w}:${h}`;
}

/**
 * Composite avatar editor component for Stage 5.
 */
export class AvatarEditor {
    /**
     * Create an editor mounted inside the given stage panel.
     *
     * @param {JQuery<HTMLElement>|HTMLElement} stage Stage 5 panel element.
     * @param {import('../wizard/WizardState.js').WizardState} wizardState Current wizard state.
     */
    constructor(stage, wizardState) {
        this.$stage = $(stage);
        this.wizardState = wizardState;
        this.sourceCharacters = [];
        this.offsets = [];
        this.cells = [];
        this.selectedCellIndex = -1;
        this.regenerating = false;
        this.abortController = null;
        this.dragState = null;
        this.pinchState = null;
        this.imageNaturalWidth = 0;
        this.imageNaturalHeight = 0;
    }

    /**
     * Resolve source characters, initialise offsets, populate UI from config,
     * and wire all sidebar controls. Does not trigger avatar generation.
     *
     * @returns {Promise<void>} Resolves when the editor is ready.
     */
    async render() {
        await this.#resolveCharacters();
        this.#initOffsets();
        this.#populateControls();
        this.#wireControls();
        this.#renderCellControlsHint();
    }

    /**
     * Resolve (unshallow) and store the source characters.
     *
     * @returns {Promise<void>}
     */
    async #resolveCharacters() {
        const ids = this.wizardState.state.selectedCharacterIds;
        await Promise.all(
            ids
                .filter((id) => characters[id]?.shallow)
                .map((id) => unshallowCharacter(String(id))),
        );
        this.sourceCharacters = getValidSelectedCharacters(ids, characters);
    }

    /**
     * Initialise the per-character offset array from wizard state, filling
     * missing entries with defaults.
     *
     * @returns {void}
     */
    #initOffsets() {
        const existing = this.wizardState.state.avatarOffsets;
        this.offsets = this.sourceCharacters.map((_, index) =>
            normalizeOffset(existing[index]),
        );
    }

    /**
     * Populate the sidebar controls from the current wizard config.
     *
     * @returns {void}
     */
    #populateControls() {
        const config = this.wizardState.config;
        const layout = VALID_LAYOUTS.includes(config.layout)
            ? config.layout
            : 'voronoi';
        const ratio = ['9:16', '1:1', '16:9', '4:3'].includes(config.aspectRatio)
            ? config.aspectRatio
            : '9:16';
        const gap = clampNumber(config.gap, 0, 10, 2);
        const maxCols = clampNumber(config.maxCols, 0, 20, 0);

        this.$stage.find('#bcw_layout').val(layout);
        this.$stage.find('#bcw_gap').val(String(gap));
        this.$stage.find('#bcw_gap_value').text(String(gap));
        this.$stage.find('#bcw_max_cols').val(String(maxCols));
        this.$stage.find('#bcw_max_cols_value').text(String(maxCols));

        // Grid controls visibility.
        this.$stage.find('#bcw_grid_controls').prop('hidden', layout === 'voronoi');

        // Aspect ratio pills.
        this.$stage.find('.bcw-ratio-pill').removeClass('active');
        const $activePill = this.$stage.find(`.bcw-ratio-pill[data-ratio="${ratio}"]`);
        if ($activePill.length > 0) {
            $activePill.addClass('active');
        } else {
            this.$stage.find('#bcw_ratio_custom').val(config.aspectRatio);
        }

        this.#applyAspectRatio(ratio);
    }

    /**
     * Wire all sidebar control event handlers.
     *
     * @returns {void}
     */
    #wireControls() {
        // Layout dropdown.
        this.$stage.find('#bcw_layout').on('change', async () => {
            const layout = String(this.$stage.find('#bcw_layout').val() ?? 'voronoi');
            await this.setLayout(layout);
        });

        // Aspect ratio pills.
        this.$stage.find('.bcw-ratio-pill').on('click', async (event) => {
            const ratio = $(event.currentTarget).attr('data-ratio') ?? '9:16';
            this.$stage.find('.bcw-ratio-pill').removeClass('active');
            $(event.currentTarget).addClass('active');
            this.$stage.find('#bcw_ratio_custom').val('');
            this.#applyAspectRatio(ratio);
        });

        // Custom aspect ratio input.
        this.$stage.find('#bcw_ratio_custom').on('input', () => {
            const raw = String(this.$stage.find('#bcw_ratio_custom').val() ?? '').trim();
            const parsed = parseAspectRatio(raw);
            if (parsed) {
                this.$stage.find('.bcw-ratio-pill').removeClass('active');
                this.#applyAspectRatio(parsed);
            }
        });

        // Gap slider.
        this.$stage.find('#bcw_gap').on('input', async () => {
            const gap = clampNumber(this.$stage.find('#bcw_gap').val(), 0, 10, 2);
            this.$stage.find('#bcw_gap_value').text(String(gap));
            await this.regenerate();
        });

        // Max cols slider.
        this.$stage.find('#bcw_max_cols').on('input', async () => {
            const maxCols = clampNumber(
                this.$stage.find('#bcw_max_cols').val(),
                0,
                20,
                0,
            );
            this.$stage.find('#bcw_max_cols_value').text(String(maxCols));
            await this.regenerate();
        });

        // Regenerate button.
        this.$stage.find('#bcw_avatar_regenerate').on('click', async () => {
            await this.regenerate();
        });
    }

    /**
     * Apply an aspect-ratio string to the preview container CSS.
     *
     * @param {string} ratio "W:H" string.
     * @returns {void}
     */
    #applyAspectRatio(ratio) {
        const [w, h] = ratio.split(':').map(Number);
        if (w > 0 && h > 0) {
            this.$stage.find('#bcw_avatar_canvas').css('aspect-ratio', `${w} / ${h}`);
        }
    }

    /**
     * Change the layout, toggle grid controls, and regenerate.
     *
     * @param {string} layout Layout value.
     * @returns {Promise<void>}
     */
    async setLayout(layout) {
        const valid = VALID_LAYOUTS.includes(layout) ? layout : 'voronoi';
        this.$stage.find('#bcw_grid_controls').prop('hidden', valid === 'voronoi');
        await this.regenerate();
    }

    /**
     * Show a hint in the per-cell controls area when nothing is selected.
     *
     * @returns {void}
     */
    #renderCellControlsHint() {
        this.$stage
            .find('#bcw_cell_controls')
            .empty()
            .append(
                $('<p></p>')
                    .addClass('bcw-cell-hint')
                    .css({ opacity: '0.6', 'font-size': '0.8em' })
                    .text('Click a cell in the preview to edit.'),
            );
    }

    /**
     * Generate (or regenerate) the composite avatar via the API. Shows a
     * loading spinner on the preview, updates the image, and renders cell
     * overlays.
     *
     * @returns {Promise<void>} Resolves when the preview updates.
     */
    async regenerate() {
        if (this.regenerating) {
            return;
        }

        const avatars = this.sourceCharacters
            .map((c) => c.avatar)
            .filter(Boolean);

        if (avatars.length === 0) {
            globalThis.toastr?.warning?.(
                'No source avatars available.',
                'Combine into Group Card',
            );
            return;
        }

        this.regenerating = true;
        this.#showLoading(true);

        // Sync offsets to wizard state before the API call.
        this.wizardState.updateField('avatarOffsets', this.#serializeOffsets());

        const config = this.wizardState.config;
        const layout = VALID_LAYOUTS.includes(config.layout)
            ? config.layout
            : 'voronoi';

        try {
            const response = await fetch(
                '/api/characters/generate-voronoi-composite',
                {
                    method: 'POST',
                    headers: {
                        ...getRequestHeaders(),
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        avatars,
                        offsets: this.#serializeOffsets(),
                        cropStrategy: config.cropStrategy,
                        cropPadding: config.cropPadding,
                        layout,
                        gap: config.gap,
                        maxCols: config.maxCols ?? 0,
                        seed: this.wizardState.state.voronoiSeed,
                    }),
                },
            );
            await throwIfNotOk(response, 'Failed to generate composite avatar.');
            const data = await response.json();

            if (data?.image) {
                this.wizardState.updateField('avatarUrl', data.image);
                this.cells = Array.isArray(data.cells) ? data.cells : [];
                this.#renderPreview(data.image);
            }
        } catch (error) {
            console.error(error);
            globalThis.toastr?.error?.(
                error?.message ?? 'Failed to generate composite avatar.',
                'Combine into Group Card',
            );
        } finally {
            this.regenerating = false;
            this.#showLoading(false);
        }
    }

    /**
     * Serialise the working offsets into plain {x, y, scale} objects for
     * the API call and wizard state.
     *
     * @returns {Array<{x: number, y: number, scale: number}>} Offset array.
     */
    #serializeOffsets() {
        return this.offsets.map((o) => ({
            x: o.x,
            y: o.y,
            scale: o.scale,
        }));
    }

    /**
     * Show or hide the loading spinner overlay on the preview.
     *
     * @param {boolean} show Whether to show the spinner.
     * @returns {void}
     */
    #showLoading(show) {
        const $canvas = this.$stage.find('#bcw_avatar_canvas');
        $canvas.find('.bcw-avatar-loading').remove();
        if (show) {
            $canvas.append(
                $('<div></div>')
                    .addClass('bcw-avatar-loading')
                    .css({
                        position: 'absolute',
                        inset: '0',
                        display: 'flex',
                        'align-items': 'center',
                        'justify-content': 'center',
                        'background-color': 'rgba(0,0,0,0.4)',
                        'border-radius': '8px',
                        'z-index': '10',
                    })
                    .append(
                        $('<i></i>')
                            .addClass('fa-solid fa-spinner fa-spin fa-2x')
                            .css({ color: 'var(--SmartThemeQuoteColor)' }),
                    ),
            );
        }
    }

    /**
     * Render the composite image into the preview canvas and wire the image
     * load handler that positions cell overlays.
     *
     * @param {string} imageUrl Data URI of the composite image.
     * @returns {void}
     */
    #renderPreview(imageUrl) {
        const $canvas = this.$stage.find('#bcw_avatar_canvas');
        $canvas.find('img, .bcw-avatar-editor').remove();

        const $img = $('<img />')
            .attr('alt', 'Composite avatar preview')
            .css({
                'max-width': '100%',
                'max-height': '100%',
                'border-radius': '8px',
                display: 'block',
            });

        const $editor = $('<div></div>')
            .addClass('bcw-avatar-editor')
            .css({ position: 'relative', display: 'inline-block' })
            .append($img);

        $canvas.append($editor);

        $img.on('load.bcwAvatar', () => {
            const imgEl = $img[0];
            this.imageNaturalWidth = imgEl.naturalWidth || 1024;
            this.imageNaturalHeight = imgEl.naturalHeight || 1536;
            this.#renderCellOverlays($editor, $img);
        });

        $img.attr('src', imageUrl);

        // If the image is already cached, the load event may have fired
        // before the handler was attached.
        if ($img[0]?.complete && $img[0]?.naturalWidth) {
            const imgEl = $img[0];
            this.imageNaturalWidth = imgEl.naturalWidth;
            this.imageNaturalHeight = imgEl.naturalHeight;
            this.#renderCellOverlays($editor, $img);
        }
    }

    /**
     * Render interactive cell overlays on top of the composite image.
     * Each overlay is a positioned div with the character's avatar image,
     * supporting click-to-select, drag-to-offset, wheel-to-scale, and
     * touch/pinch gestures.
     *
     * @param {JQuery<HTMLElement>} $editor Editor wrapper element.
     * @param {JQuery<HTMLElement>} $img Composite image element.
     * @returns {void}
     */
    #renderCellOverlays($editor, $img) {
        // Abort any previous interaction listeners.
        if (this.abortController) {
            this.abortController.abort();
        }
        this.abortController = new AbortController();
        const { signal } = this.abortController;

        $editor.find('.avatar-editor-cell').remove();

        const imgEl = $img[0];
        if (!imgEl || !this.cells.length || !this.sourceCharacters.length) {
            return;
        }

        const rect = imgEl.getBoundingClientRect();
        const previewWidth = rect.width;
        const previewHeight = rect.height;
        if (!previewWidth || !previewHeight) {
            return;
        }

        $editor.css({
            width: `${previewWidth}px`,
            height: `${previewHeight}px`,
        });

        const scaleX = previewWidth / this.imageNaturalWidth;
        const scaleY = previewHeight / this.imageNaturalHeight;

        this.cells.slice(0, this.sourceCharacters.length).forEach((cell, index) => {
            const bounds = getCellBounds(cell);
            if (!bounds) {
                return;
            }

            const overlayEl = document.createElement('div');
            overlayEl.className = 'avatar-editor-cell';
            overlayEl.dataset.index = String(index);
            overlayEl.style.cssText =
                'position:absolute;overflow:hidden;cursor:pointer;' +
                `left:${bounds.x * scaleX}px;top:${bounds.y * scaleY}px;` +
                `width:${bounds.w * scaleX}px;height:${bounds.h * scaleY}px;` +
                'border:2px solid transparent;border-radius:4px;' +
                'transition:border-color 0.15s;';

            if (cell.type !== 'rect' && Array.isArray(cell.points)) {
                const polygon = cell.points
                    .map(
                        ([px, py]) =>
                            `${((px - bounds.x) / bounds.w) * 100}% ` +
                            `${((py - bounds.y) / bounds.h) * 100}%`,
                    )
                    .join(', ');
                overlayEl.style.clipPath = `polygon(${polygon})`;
            }

            // Character avatar image inside the cell.
            const character = this.sourceCharacters[index];
            const cellImg = document.createElement('img');
            cellImg.alt = 'Avatar cell';
            cellImg.src = getThumbnailUrl(
                'avatar',
                character?.avatar ?? '',
            );
            cellImg.style.cssText =
                `position:absolute;width:${previewWidth}px;` +
                `height:${previewHeight}px;` +
                `left:${-bounds.x * scaleX}px;top:${-bounds.y * scaleY}px;` +
                'pointer-events:none;';
            overlayEl.appendChild(cellImg);
            $editor[0].appendChild(overlayEl);

            this.#updateCellTransform(index);

            // Click to select.
            overlayEl.addEventListener(
                'mousedown',
                (event) =>
                    this.#startDrag(event, index, event.clientX, event.clientY),
                { signal },
            );
            overlayEl.addEventListener(
                'click',
                () => this.selectCell(index),
                { signal },
            );

            // Wheel to scale.
            overlayEl.addEventListener(
                'wheel',
                (event) => {
                    event.preventDefault();
                    this.selectCell(index);
                    const offset = this.offsets[index];
                    const nextScale = clampNumber(
                        offset.scale + (event.deltaY > 0 ? -SCALE_STEP : SCALE_STEP),
                        SCALE_MIN,
                        SCALE_MAX,
                        100,
                    );
                    this.offsets[index] = { ...offset, scale: nextScale };
                    this.#updateCellTransform(index);
                    this.#syncCellControls(index);
                },
                { passive: false, signal },
            );

            // Touch support.
            overlayEl.addEventListener(
                'touchstart',
                (event) => {
                    this.selectCell(index);
                    if (event.touches.length === 2) {
                        const [first, second] = event.touches;
                        this.pinchState = {
                            index,
                            distance: Math.hypot(
                                first.clientX - second.clientX,
                                first.clientY - second.clientY,
                            ),
                            scale: this.offsets[index].scale,
                        };
                        event.preventDefault();
                        return;
                    }
                    const touch = event.touches[0];
                    if (touch) {
                        this.#startDrag(event, index, touch.clientX, touch.clientY);
                    }
                },
                { passive: false, signal },
            );
        });

        // Document-level move / up listeners for drag and pinch.
        document.addEventListener(
            'mousemove',
            (event) => this.#updateDrag(event.clientX, event.clientY),
            { signal },
        );
        document.addEventListener('mouseup', () => this.#finishInteraction(), {
            signal,
        });
        document.addEventListener(
            'touchmove',
            (event) => {
                if (this.pinchState && event.touches.length === 2) {
                    const [first, second] = event.touches;
                    const distance = Math.hypot(
                        first.clientX - second.clientX,
                        first.clientY - second.clientY,
                    );
                    const idx = this.pinchState.index;
                    const nextScale = clampNumber(
                        this.pinchState.scale +
                            (distance - this.pinchState.distance) / 2,
                        SCALE_MIN,
                        SCALE_MAX,
                        100,
                    );
                    this.offsets[idx] = { ...this.offsets[idx], scale: nextScale };
                    this.#updateCellTransform(idx);
                    this.#syncCellControls(idx);
                    event.preventDefault();
                    return;
                }
                if (this.dragState && event.touches.length === 1) {
                    const touch = event.touches[0];
                    this.#updateDrag(touch.clientX, touch.clientY);
                    event.preventDefault();
                }
            },
            { passive: false, signal },
        );
        document.addEventListener('touchend', () => this.#finishInteraction(), {
            signal,
        });

        // Restore selection.
        if (this.selectedCellIndex >= 0) {
            this.selectCell(this.selectedCellIndex);
        }
    }

    /**
     * Begin a drag interaction on a cell.
     *
     * @param {Event} event Original event (for preventDefault).
     * @param {number} index Cell index.
     * @param {number} clientX Start X.
     * @param {number} clientY Start Y.
     * @returns {void}
     */
    #startDrag(event, index, clientX, clientY) {
        this.selectCell(index);
        const offset = this.offsets[index];
        this.dragState = {
            index,
            startX: clientX,
            startY: clientY,
            offsetX: offset.x,
            offsetY: offset.y,
        };
        event.preventDefault();
    }

    /**
     * Update cell offset during a drag.
     *
     * @param {number} clientX Current X.
     * @param {number} clientY Current Y.
     * @returns {void}
     */
    #updateDrag(clientX, clientY) {
        if (!this.dragState) {
            return;
        }
        const { index, startX, startY, offsetX, offsetY } = this.dragState;
        const scaleX = this.imageNaturalWidth > 0
            ? this.#getDisplayScaleX()
            : 1;
        const scaleY = this.imageNaturalHeight > 0
            ? this.#getDisplayScaleY()
            : 1;
        this.offsets[index] = {
            ...this.offsets[index],
            x: clampNumber(
                offsetX + (clientX - startX) / scaleX,
                OFFSET_MIN,
                OFFSET_MAX,
                0,
            ),
            y: clampNumber(
                offsetY + (clientY - startY) / scaleY,
                OFFSET_MIN,
                OFFSET_MAX,
                0,
            ),
        };
        this.#updateCellTransform(index);
        this.#syncCellControls(index);
    }

    /**
     * Compute the X display-to-composite scale factor.
     *
     * @returns {number} Scale factor.
     */
    #getDisplayScaleX() {
        const $img = this.$stage.find('.bcw-avatar-editor img');
        const rect = $img[0]?.getBoundingClientRect();
        if (!rect?.width || !this.imageNaturalWidth) {
            return 1;
        }
        return rect.width / this.imageNaturalWidth;
    }

    /**
     * Compute the Y display-to-composite scale factor.
     *
     * @returns {number} Scale factor.
     */
    #getDisplayScaleY() {
        const $img = this.$stage.find('.bcw-avatar-editor img');
        const rect = $img[0]?.getBoundingClientRect();
        if (!rect?.height || !this.imageNaturalHeight) {
            return 1;
        }
        return rect.height / this.imageNaturalHeight;
    }

    /**
     * Finish a drag or pinch interaction and sync offset state.
     *
     * @returns {void}
     */
    #finishInteraction() {
        this.dragState = null;
        this.pinchState = null;
    }

    /**
     * Apply the CSS transform for a cell's avatar image based on its offset.
     *
     * @param {number} index Cell index.
     * @returns {void}
     */
    #updateCellTransform(index) {
        const $cell = this.$stage.find(
            `.avatar-editor-cell[data-index="${index}"]`,
        );
        const $img = $cell.find('img');
        if (!$cell.length || !$img.length) {
            return;
        }
        const offset = this.offsets[index];
        if (!offset) {
            return;
        }
        const scaleX = this.#getDisplayScaleX();
        const scaleY = this.#getDisplayScaleY();
        $img.css(
            'transform',
            `translate(${offset.x * scaleX}px, ${offset.y * scaleY}px) ` +
                `scale(${offset.scale / 100})`,
        );
    }

    /**
     * Select a cell: highlight it in the preview and render its controls.
     *
     * @param {number} index Cell index.
     * @returns {void}
     */
    selectCell(index) {
        if (index < 0 || index >= this.sourceCharacters.length) {
            return;
        }
        this.selectedCellIndex = index;
        this.$stage
            .find('.avatar-editor-cell')
            .removeClass('selected')
            .css('border-color', 'transparent')
            .filter(`[data-index="${index}"]`)
            .addClass('selected')
            .css('border-color', 'var(--SmartThemeQuoteColor)');
        this.#renderCellControls(index);
    }

    /**
     * Render the per-cell controls for the selected cell into the sidebar.
     *
     * @param {number} index Cell index.
     * @returns {void}
     */
    #renderCellControls(index) {
        const character = this.sourceCharacters[index];
        if (!character) {
            return;
        }
        const name = getCoreCharacterField(character, 'name') || `Cell ${index + 1}`;
        const offset = this.offsets[index];
        const $container = this.$stage.find('#bcw_cell_controls');
        $container.empty();

        const $item = $('<div></div>')
            .addClass('bcw-avatar-cell-control selected')
            .css({ 'margin-bottom': '0.4em' });

        $item.append(
            $('<div></div>')
                .addClass('bcw-cell-name')
                .css({
                    'font-size': '0.8em',
                    'font-weight': '600',
                    'margin-bottom': '0.3em',
                    'white-space': 'nowrap',
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                })
                .text(name),
        );

        // Scale slider.
        const $scaleLabel = $('<label></label>').css({
            display: 'block',
            'font-size': '0.75em',
            'margin-bottom': '0.3em',
        });
        $scaleLabel.append(
            $('<span></span>')
                .css({ display: 'flex', 'justify-content': 'space-between' })
                .append($('<span></span>').text('Scale'))
                .append(
                    $('<span></span>')
                        .addClass('bcw-scale-val')
                        .text(`${offset.scale}%`),
                ),
        );
        const $scaleSlider = $(
            `<input type="range" min="${SCALE_MIN}" max="${SCALE_MAX}" step="${SCALE_STEP}" />`,
        ).val(String(offset.scale));
        $scaleSlider.on('input', () => {
            const scale = clampNumber($scaleSlider.val(), SCALE_MIN, SCALE_MAX, 100);
            this.offsets[index] = { ...this.offsets[index], scale };
            $item.find('.bcw-scale-val').text(`${scale}%`);
            this.#updateCellTransform(index);
        });
        $scaleLabel.append($scaleSlider);
        $item.append($scaleLabel);

        // Crop focus dropdown.
        const $cropLabel = $('<label></label>').css({
            display: 'block',
            'font-size': '0.75em',
            'margin-bottom': '0.3em',
        });
        $cropLabel.append($('<span></span>').text('Crop Focus'));
        const $cropSelect = $('<select class="text_pole"></select>').css({
            width: '100%',
            'font-size': '0.8em',
        });
        VALID_CROP_FOCUS.forEach((focus) => {
            $('<option></option>')
                .val(focus)
                .text(focus.charAt(0).toUpperCase() + focus.slice(1))
                .appendTo($cropSelect);
        });
        $cropSelect.val(offset.cropFocus);
        $cropSelect.on('change', () => {
            this.offsets[index] = {
                ...this.offsets[index],
                cropFocus: String($cropSelect.val() ?? 'attention'),
            };
        });
        $cropLabel.append($cropSelect);
        $item.append($cropLabel);

        // Offset display.
        const $offsetDisplay = $('<div></div>')
            .addClass('bcw-offset-display')
            .css({ 'font-size': '0.7em', opacity: '0.7', 'margin-top': '0.2em' })
            .text(`Offset: X=${offset.x}, Y=${offset.y}`);
        $item.append($offsetDisplay);

        // Reset button.
        const $reset = $('<button class="menu_button"></button>')
            .css({ width: '100%', 'font-size': '0.75em', 'margin-top': '0.3em' })
            .text('Reset');
        $reset.on('click', () => {
            this.offsets[index] = { x: 0, y: 0, scale: 100, cropFocus: 'attention' };
            this.#updateCellTransform(index);
            this.#renderCellControls(index);
        });
        $item.append($reset);

        $container.append($item);
    }

    /**
     * Sync the per-cell controls display (offset/scale) during interaction.
     *
     * @param {number} index Cell index.
     * @returns {void}
     */
    #syncCellControls(index) {
        if (this.selectedCellIndex !== index) {
            return;
        }
        const offset = this.offsets[index];
        if (!offset) {
            return;
        }
        const $item = this.$stage.find('#bcw_cell_controls .bcw-avatar-cell-control');
        $item.find('.bcw-scale-val').text(`${offset.scale}%`);
        $item.find('.bcw-offset-display').text(`Offset: X=${offset.x}, Y=${offset.y}`);
        const $slider = $item.find('input[type="range"]');
        if ($slider.length > 0) {
            $slider.val(String(offset.scale));
        }
    }

    /**
     * Update the configuration of a single cell.
     *
     * @param {number} index Cell index.
     * @param {object} config Partial cell config (scale, cropFocus, x, y).
     * @returns {void}
     */
    updateCellConfig(index, config) {
        if (index < 0 || index >= this.offsets.length) {
            return;
        }
        this.offsets[index] = { ...this.offsets[index], ...config };
        this.#updateCellTransform(index);
        if (this.selectedCellIndex === index) {
            this.#syncCellControls(index);
        }
    }

    /**
     * Read all avatar-editor state into a config patch.
     *
     * @returns {{layout: string, gap: number, maxCols: number, aspectRatio: string, customRatio: string|null, cropStrategy: string, cropPadding: number, avatarOffsets: Array<{x: number, y: number, scale: number}>, avatarUrl: string|null}} Config patch.
     */
    collectConfig() {
        const config = this.wizardState.config;
        const layout = VALID_LAYOUTS.includes(config.layout)
            ? config.layout
            : 'voronoi';

        const activeRatio = this.$stage.find('.bcw-ratio-pill.active').attr('data-ratio');
        const customRaw = String(
            this.$stage.find('#bcw_ratio_custom').val() ?? '',
        ).trim();

        let aspectRatio;
        let customRatio = null;
        if (activeRatio) {
            aspectRatio = activeRatio;
        } else if (parseAspectRatio(customRaw)) {
            aspectRatio = parseAspectRatio(customRaw);
            customRatio = aspectRatio;
        } else {
            aspectRatio = config.aspectRatio || '9:16';
        }

        return {
            layout,
            gap: clampNumber(config.gap, 0, 10, 2),
            maxCols: clampNumber(config.maxCols, 0, 20, 0),
            aspectRatio,
            customRatio,
            cropStrategy: config.cropStrategy ?? 'attention',
            cropPadding: config.cropPadding ?? 15,
            avatarOffsets: this.#serializeOffsets(),
            avatarUrl: this.wizardState.state.avatarUrl,
        };
    }

    /**
     * Tear down the editor: abort interaction listeners and clean up.
     *
     * @returns {void}
     */
    destroy() {
        if (this.abortController) {
            this.abortController.abort();
            this.abortController = null;
        }
        this.dragState = null;
        this.pinchState = null;
    }
}
