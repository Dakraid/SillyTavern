'use strict';

/**
 * @file Generation result card used in Stage 2.
 *
 * Renders a per-character result card with avatar, name, status badge, a
 * collapsible editable XML editor, Auto-fix / Regenerate action buttons, and a
 * parse-status indicator. Status transitions follow the generation lifecycle:
 * pending → generating → complete / failed.
 *
 * The card resolves avatar/name from the global `characters` list, matching the
 * CharacterCard pattern. All action buttons fire callbacks (no state mutation
 * beyond the card's own DOM) so the owning stage stays the source of truth.
 */

import { characters, getThumbnailUrl } from '../../../script.js';
import {
    autoFixXml,
    extractTopLevelXmlBlocks,
} from '../../group-card-xml-parser.js';
import { getCharacterName } from '../helpers.js';
import { initCollapsible } from './CollapsibleSection.js';

/**
 * Generation lifecycle status values.
 *
 * @type {Readonly<{PENDING: string, QUEUED: string, GENERATING: string, COMPLETE: string, FAILED: string}>}
 */
export const RESULT_STATUS = Object.freeze({
    PENDING: 'pending',
    QUEUED: 'queued',
    GENERATING: 'generating',
    COMPLETE: 'complete',
    FAILED: 'failed',
});

/**
 * Badge icon + label per status.
 *
 * @type {Record<string, {icon: string, label: string}>}
 */
const STATUS_BADGE = {
    [RESULT_STATUS.PENDING]: { icon: 'fa-hourglass-half', label: 'Pending' },
    [RESULT_STATUS.QUEUED]: { icon: 'fa-hourglass-half', label: 'Queued' },
    [RESULT_STATUS.GENERATING]: { icon: 'fa-spinner fa-spin', label: 'Generating' },
    [RESULT_STATUS.COMPLETE]: { icon: 'fa-check', label: 'Complete' },
    [RESULT_STATUS.FAILED]: { icon: 'fa-xmark', label: 'Failed' },
};

/**
 * Build a status-badge element for the given lifecycle status.
 *
 * @param {string} status One of {@link RESULT_STATUS}.
 * @returns {JQuery<HTMLElement>} Badge element.
 */
function createStatusBadge(status) {
    const info = STATUS_BADGE[status] ?? STATUS_BADGE[RESULT_STATUS.PENDING];
    return $('<span></span>')
        .addClass(`bcw-status-badge ${status}`)
        .attr('role', 'status')
        .attr('aria-label', info.label)
        .append($('<i></i>').addClass(`fa-solid ${info.icon}`))
        .append($('<span></span>').text(info.label));
}

/**
 * Refresh the parse-status text from the current textarea content.
 *
 * @param {JQuery<HTMLElement>} $card Result card root.
 * @param {string} xml XML text.
 * @returns {void}
 */
function refreshParseStatus($card, xml) {
    const $parse = $card.find('.bcw-parse-status');
    const trimmed = String(xml ?? '').trim();
    $parse.removeClass('ok error');

    if (trimmed === '') {
        $parse.text('');
        return;
    }
    if (extractTopLevelXmlBlocks(trimmed).length > 0) {
        $parse.text('Parse: ✓ Valid').addClass('ok');
    } else {
        $parse.text('Parse: ✕ Invalid').addClass('error');
    }
}

/**
 * Create a result card for a single character's generation output.
 *
 * @param {number} characterId Character this result belongs to.
 * @param {object} [callbacks] Action callbacks.
 * @param {(id: number, xml: string) => void} [callbacks.onEditXml] XML textarea changed.
 * @param {(id: number) => void} [callbacks.onAutoFix] Auto-fix clicked.
 * @param {(id: number) => void} [callbacks.onRegenerate] Regenerate clicked.
 * @returns {JQuery<HTMLElement>} The result card element.
 */
export function createResultCard(characterId, callbacks = {}) {
    const id = Number(characterId);
    const character = characters[id];
    const name = getCharacterName(character) || `Character ${id + 1}`;
    const avatarUrl = getThumbnailUrl('avatar', character?.avatar ?? '');

    const $card = $('<div></div>')
        .addClass('bcw-result-card')
        .attr('data-character-id', String(id))
        .attr('role', 'listitem');

    // --- Header: avatar + name + status badge ---
    const $avatar = $('<img>')
        .addClass('avatar')
        .attr('alt', name)
        .attr('src', avatarUrl)
        .attr('title', name);

    const $name = $('<span></span>')
        .addClass('name')
        .text(name)
        .attr('title', name);

    const $badge = createStatusBadge(RESULT_STATUS.PENDING);

    const $header = $('<div></div>')
        .addClass('card-header')
        .append($avatar, $name, $badge);

    // --- Collapsible XML editor ---
    const $xml = $('<textarea></textarea>')
        .addClass('text_pole xml')
        .attr('rows', '8')
        .attr('spellcheck', 'false')
        .attr('aria-label', `XML output for ${name}`)
        .attr('placeholder', 'Generated XML will appear here…');

    const $xmlHeader = $('<div></div>')
        .addClass('bcw-collapsible-header')
        .attr('role', 'button')
        .attr('tabindex', '0')
        .attr('aria-expanded', 'true')
        .append(
            $('<i></i>').addClass(
                'fa-solid fa-chevron-down bcw-collapsible-chevron',
            ),
        )
        .append($('<span></span>').text('XML Output'));

    const $xmlContent = $('<div></div>')
        .addClass('bcw-collapsible-content')
        .append($xml);

    const $xmlSection = $('<div></div>')
        .addClass('bcw-collapsible expanded')
        .append($xmlHeader, $xmlContent);

    initCollapsible($xmlHeader);

    // --- Action buttons ---
    const $autoFix = $('<div></div>')
        .addClass('menu_button bcw-autofix-btn')
        .attr('role', 'button')
        .attr('tabindex', '0')
        .text('Auto-fix');

    const $regen = $('<div></div>')
        .addClass('menu_button bcw-regen-btn')
        .attr('role', 'button')
        .attr('tabindex', '0')
        .text('Regenerate');

    const $actions = $('<div></div>')
        .addClass('actions')
        .append($autoFix, $regen);

    // --- Parse status ---
    const $parseStatus = $('<div></div>')
        .addClass('bcw-parse-status')
        .css({ fontSize: '0.8em', opacity: '0.8' });

    $card.append($header, $xmlSection, $actions, $parseStatus);

    // --- Wiring ---
    $xml.on('input', function () {
        const xml = String($(this).val() ?? '');
        refreshParseStatus($card, xml);
        callbacks.onEditXml?.(id, xml);
    });

    const activateButton = ($btn, handler) => {
        $btn.on('click', () => handler());
        $btn.on('keydown', function (event) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                handler();
            }
        });
    };

    activateButton($autoFix, () => {
        // Apply auto-fix in-place so the user sees immediate feedback.
        const xml = String($xml.val() ?? '');
        const fixed = autoFixXml(xml);
        $xml.val(fixed.fixed);
        refreshParseStatus($card, fixed.fixed);
        callbacks.onAutoFix?.(id);
    });

    activateButton($regen, () => {
        callbacks.onRegenerate?.(id);
    });

    return $card;
}

/**
 * Update a result card's status badge, visual state, and parse indicator.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} element Result card element.
 * @param {string} status One of {@link RESULT_STATUS}.
 * @param {'ok'|'error'|null} [parseStatus] Parse validity, or null to leave unchanged.
 * @returns {void}
 */
export function updateResultCardStatus(element, status, parseStatus) {
    const $card = $(element);

    // Rebuild the badge for the new status.
    const $newBadge = createStatusBadge(status);
    $card.find('.bcw-status-badge').first().replaceWith($newBadge);

    // Disable the regen button while a card is queued to prevent
    // duplicate-click re-queuing; re-enable for all other statuses.
    const $regenBtn = $card.find('.bcw-regen-btn');
    const isQueued = status === RESULT_STATUS.QUEUED;
    $regenBtn
        .toggleClass('disabled', isQueued)
        .attr('aria-disabled', isQueued ? 'true' : 'false')
        .css('pointer-events', isQueued ? 'none' : '');

    if (parseStatus === 'ok' || parseStatus === 'error') {
        const $parse = $card.find('.bcw-parse-status');
        $parse.removeClass('ok error');
        if (parseStatus === 'ok') {
            $parse.text('Parse: ✓ Valid').addClass('ok');
        } else {
            $parse.text('Parse: ✕ Invalid').addClass('error');
        }
    }
}

/**
 * Get the XML content from a result card's textarea.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} element Result card element.
 * @returns {string} XML text.
 */
export function getResultCardXml(element) {
    return String($(element).find('.xml').val() ?? '');
}

/**
 * Set the XML content in a result card's textarea and refresh parse status.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} element Result card element.
 * @param {string} xml XML text.
 * @returns {void}
 */
export function setResultCardXml(element, xml) {
    const $card = $(element);
    const text = String(xml ?? '');
    $card.find('.xml').val(text);
    refreshParseStatus($card, text);
}
