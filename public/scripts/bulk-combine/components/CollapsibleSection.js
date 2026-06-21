'use strict';

/**
 * @file Progressive-disclosure collapsible section.
 *
 * Header with a chevron toggle and a content slot. Used for Advanced Options
 * (Stage 1), collapsible XML editors (Stage 2), and before/after previews
 * (Stage 3). The expand/collapse animation is driven by the `.expanded`
 * class on the `.bcw-collapsible` root (CSS max-height transition in
 * styles.css).
 *
 * Template-loaded sections start with a `hidden` attribute on the content
 * element for no-JS progressive enhancement. {@link initCollapsible} removes
 * it so the CSS transition can animate.
 */

/**
 * Apply the expanded or collapsed visual state to a section.
 *
 * @param {JQuery<HTMLElement>} $section The `.bcw-collapsible` root element.
 * @param {boolean} expanded Whether the section should be expanded.
 * @returns {void}
 */
function applyExpanded($section, expanded) {
    $section.toggleClass('expanded', expanded);
    const $content = $section.find('.bcw-collapsible-content').first();
    const $header = $section.find('.bcw-collapsible-header').first();
    const $chevron = $header.find('.bcw-collapsible-chevron').first();

    // Remove the `hidden` attribute so the CSS max-height transition runs.
    // When collapsed, the CSS `max-height: 0` + `overflow: hidden` visually
    // hides the content without removing it from the layout.
    $content.removeAttr('hidden');

    if ($chevron.length > 0) {
        $chevron.removeClass('fa-chevron-right fa-chevron-down');
        $chevron.addClass(expanded ? 'fa-chevron-down' : 'fa-chevron-right');
    }

    $header.attr('aria-expanded', expanded ? 'true' : 'false');
}

/**
 * Resolve the `.bcw-collapsible` root from a section root or header element.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} element Section root or header.
 * @returns {JQuery<HTMLElement>} The `.bcw-collapsible` root, possibly empty.
 */
function resolveSection(element) {
    const $element = $(element);
    if ($element.hasClass('bcw-collapsible')) {
        return $element;
    }
    return $element.closest('.bcw-collapsible');
}

/**
 * Toggle a collapsible section between expanded and collapsed.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} element Section root or header element.
 * @returns {void}
 */
export function toggleSection(element) {
    const $section = resolveSection(element);
    if ($section.length === 0) {
        return;
    }
    applyExpanded($section, !$section.hasClass('expanded'));
}

/**
 * Initialize a template-loaded collapsible section by wiring the header's
 * click and keyboard handlers and preparing the content for animation.
 *
 * @param {JQuery<HTMLElement>|HTMLElement} headerElement The `.bcw-collapsible-header` element.
 * @returns {void}
 */
export function initCollapsible(headerElement) {
    const $header = $(headerElement);
    const $section = $header.closest('.bcw-collapsible');
    if ($section.length === 0) {
        return;
    }

    // Sync the visual state with the initial `.expanded` class and remove the
    // `hidden` attribute so the CSS transition can animate.
    applyExpanded($section, $section.hasClass('expanded'));

    $header
        .off('click.bcwCollapsible')
        .on('click.bcwCollapsible', (event) => {
            event.preventDefault();
            toggleSection($header);
        })
        .off('keydown.bcwCollapsible')
        .on('keydown.bcwCollapsible', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                toggleSection($header);
            }
        });
}

/**
 * Create a collapsible section element from scratch.
 *
 * @param {string} title Section title (displayed in the header).
 * @param {string} contentHtml Inner HTML for the collapsible content slot.
 * @param {object} [options] Creation options.
 * @param {boolean} [options.collapsed=true] Whether the section starts collapsed.
 * @returns {JQuery<HTMLElement>} The assembled `.bcw-collapsible` element.
 */
export function createCollapsibleSection(title, contentHtml, options = {}) {
    const collapsed = options.collapsed !== false;
    const expanded = !collapsed;

    const $section = $('<div></div>').addClass('bcw-collapsible');
    if (expanded) {
        $section.addClass('expanded');
    }

    const $header = $('<div></div>')
        .addClass('bcw-collapsible-header')
        .attr('role', 'button')
        .attr('tabindex', '0')
        .attr('aria-expanded', expanded ? 'true' : 'false')
        .append(
            $('<i></i>').addClass(
                `fa-solid ${expanded ? 'fa-chevron-down' : 'fa-chevron-right'} bcw-collapsible-chevron`,
            ),
        )
        .append($('<span></span>').text(String(title ?? '')));

    const $content = $('<div></div>')
        .addClass('bcw-collapsible-content')
        .html(String(contentHtml ?? ''));

    $section.append($header, $content);
    initCollapsible($header);
    return $section;
}
