'use strict';

/**
 * @file Draggable character card used in Stage 1.
 *
 * Renders a card with an avatar circle, truncated name, drag handle, and a
 * remove button. Supports drag-to-reorder via jQuery UI sortable (card order
 * maps to avatar cell order in Stage 5) and a remove action. Designed to be
 * dropped into the `.bcw-character-strip` container.
 */

import { characters, getThumbnailUrl } from '../../../script.js';
import { getSortableDelay } from '../../utils.js';
import { getCharacterName } from '../helpers.js';

/**
 * Create a draggable character card element.
 *
 * The character is resolved from the global `characters` list unless
 * `options.character` is provided (useful for tests and lazy-loaded entries).
 *
 * @param {number} characterId Character this card represents.
 * @param {object} [options] Card options.
 * @param {object} [options.character] Character object (overrides lookup).
 * @param {string} [options.avatarUrl] Avatar image URL (overrides lookup).
 * @param {string} [options.name] Display name (overrides lookup).
 * @param {boolean} [options.selected] Whether the card starts selected.
 * @returns {JQuery<HTMLElement>} The card element, ready to insert.
 */
export function createCharacterCard(characterId, options = {}) {
    const id = Number(characterId);
    const character = options.character ?? characters[id];
    const name = options.name ?? getCharacterName(character);
    const avatarUrl =
        options.avatarUrl ?? getThumbnailUrl('avatar', character?.avatar ?? '');

    const $card = $('<div></div>')
        .addClass('bcw-character-card')
        .attr('data-character-id', String(id))
        .attr('role', 'listitem');

    if (options.selected) {
        $card.addClass('selected');
    }

    const $avatar = $('<img>')
        .addClass('avatar')
        .attr('alt', name)
        .attr('src', avatarUrl)
        .attr('title', name);

    const $name = $('<span></span>')
        .addClass('name')
        .text(name)
        .attr('title', name);

    const $controls = $('<div></div>')
        .addClass('bcw-card-controls')
        .css({ display: 'flex', justifyContent: 'center', gap: '0.5em', marginTop: '0.2em' });

    const $dragHandle = $('<i></i>')
        .addClass('fa-solid fa-grip-vertical bcw-drag-handle')
        .css({ cursor: 'grab', opacity: 0.5 })
        .attr('title', 'Drag to reorder')
        .attr('aria-hidden', 'true');

    const $removeButton = $('<i></i>')
        .addClass('fa-solid fa-xmark bcw-remove-button')
        .css({ cursor: 'pointer', opacity: 0.7 })
        .attr('title', 'Remove')
        .attr('role', 'button')
        .attr('aria-label', `Remove ${name}`)
        .attr('tabindex', '0');

    $controls.append($dragHandle, $removeButton);
    $card.append($avatar, $name, $controls);
    return $card;
}

/**
 * Attach drag-and-drop reorder handlers to a character strip container using
 * jQuery UI sortable (available globally in SillyTavern). The drag handle is
 * the `.bcw-drag-handle` element inside each card.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} container Character strip container.
 * @param {(newOrder: number[]) => void} [onReorder] Callback receiving the new
 *     character-id order when a drag completes.
 * @returns {void}
 */
export function attachDragHandlers(container, onReorder) {
    const $container = $(container);
    if (typeof $container.sortable !== 'function') {
        return;
    }

    $container.sortable({
        items: '.bcw-character-card',
        handle: '.bcw-drag-handle',
        delay: getSortableDelay(),
        placeholder: 'bcw-character-card-placeholder',
        forcePlaceholderSize: true,
        tolerance: 'pointer',
        start(_event, ui) {
            ui.item.addClass('dragging');
        },
        stop(_event, ui) {
            ui.item.removeClass('dragging');
            if (typeof onReorder === 'function') {
                const newOrder = $container
                    .find('.bcw-character-card')
                    .map(function () {
                        return Number($(this).attr('data-character-id'));
                    })
                    .get();
                onReorder(newOrder);
            }
        },
    });
}
