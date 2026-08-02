'use strict';

/**
 * @file Cards page (page 1) for the 8-page Bulk Combine guided task wizard.
 *
 * Renders the task's source-card snapshots: avatar thumbnail, name, an
 * immutable-snapshot badge, and a compact captured-field summary per card,
 * in `task.sources` array order. Per-card controls move up/down, refresh
 * the snapshot from the live character, or remove the card (a combine needs
 * at least two sources, so removal locks at that floor). A filterable
 * picker appends characters that are not sources yet; the footer continues
 * to the Prompt & Settings page.
 *
 * Page-module contract: `render(container, snapshot, actions) → Element`
 * (the page heading, used as the focus target). The page is a pure function
 * of the snapshot: every render clears the container and rebuilds from
 * `snapshot.task.sources`. All mutations go through
 * `actions.update({ sources })` — the server PATCH deep-merges records but
 * REPLACES arrays, so the whole new array is always sent. Rendering NEVER
 * executes work: no runPass/resume/cancel calls leave this module.
 *
 * Plain DOM only (no jQuery) so the page runs under the Node unit-test
 * environment with light DOM fakes.
 */

import { characters, getThumbnailUrl } from '../../../../script.js';
import { getCharacterName, getCoreCharacterPayload } from '../../helpers.js';

/**
 * Minimum number of source cards a combine task needs.
 *
 * @type {number}
 */
export const CARDS_PAGE_MIN_SOURCES = 2;

/**
 * Maximum picker rows rendered at once (performance guard for large rosters).
 *
 * @type {number}
 */
export const CARDS_PAGE_PICKER_LIMIT = 50;

const REMOVE_LOCKED_TITLE = `At least ${CARDS_PAGE_MIN_SOURCES} source cards are required to combine.`;
const CONTINUE_LOCKED_TITLE = `Add at least ${CARDS_PAGE_MIN_SOURCES} source cards to continue.`;
const REFRESH_TITLE = 'Re-capture name and core fields from the live character. Marks downstream results stale.';
const REFRESH_MISSING_TITLE = 'The live character for this snapshot no longer exists — refresh is unavailable.';
const SNAPSHOT_BADGE_TITLE = 'Stored snapshot: generation uses this captured data, never the live card, until you refresh.';

/**
 * Core-field labels in canonical order, used for the compact field summary.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
const CORE_FIELD_LABELS = Object.freeze([
    ['name', 'Name'],
    ['description', 'Description'],
    ['personality', 'Personality'],
    ['scenario', 'Scenario'],
    ['first_mes', 'First message'],
    ['mes_example', 'Example messages'],
]);

/**
 * Reads the source list from a state snapshot, tolerating partial shapes.
 *
 * @param {object} [snapshot] State snapshot (`{ task }`).
 * @returns {object[]} Source records (empty when absent).
 */
function sourcesOf(snapshot) {
    return Array.isArray(snapshot?.task?.sources) ? snapshot.task.sources : [];
}

/**
 * Reads the live character roster defensively.
 *
 * @returns {object[]} Character records.
 */
function liveCharacters() {
    return Array.isArray(characters) ? characters : [];
}

/**
 * Finds the live character backing a source snapshot, matched by avatar
 * file name. Sources without an avatar (or whose card was deleted) have no
 * live character.
 *
 * @param {object} [source] Source record (`{ avatar }`).
 * @returns {object|null} Live character, or null when gone.
 */
function findLiveCharacter(source) {
    const avatar = String(source?.avatar ?? '');
    if (!avatar) {
        return null;
    }
    return liveCharacters().find((character) => String(character?.avatar ?? '') === avatar) ?? null;
}

/**
 * Computes the stable source key for a roster character (matches the task
 * seeding in `bulk-combine/index.js`).
 *
 * @param {object} character Character record.
 * @param {number} id Character index within the roster.
 * @returns {string} Source key.
 */
function sourceKeyFor(character, id) {
    return String(character?.avatar ?? `character-${id}`);
}

/**
 * Builds a source snapshot record from a live character (matches the task
 * seeding shape in `bulk-combine/index.js`).
 *
 * @param {object} character Character record.
 * @param {number} id Character index within the roster.
 * @returns {{key: string, name: string, avatar: string, fields: object}} Source record.
 */
function buildSourceFromCharacter(character, id) {
    return {
        key: sourceKeyFor(character, id),
        name: String(getCharacterName(character) ?? ''),
        avatar: String(character?.avatar ?? ''),
        fields: getCoreCharacterPayload(character),
    };
}

/**
 * Formats the compact summary of captured core fields for a source.
 *
 * @param {object} [fields] Captured core fields.
 * @returns {string} Summary line.
 */
function formatFieldSummary(fields) {
    const present = CORE_FIELD_LABELS
        .filter(([key]) => String(fields?.[key] ?? '').trim().length > 0)
        .map(([, label]) => label);
    return present.length > 0 ? `Fields captured: ${present.join(', ')}` : 'No core fields captured.';
}

/**
 * Sends a whole-array sources patch through the actions facade. Failures
 * are logged, never thrown into render/click paths.
 *
 * @param {object} actions Actions facade.
 * @param {object[]} sources New source array (server replaces arrays).
 * @returns {void}
 */
function applySources(actions, sources) {
    let result;
    try {
        result = actions?.update?.({ sources });
    } catch (error) {
        console.error('cardsPage: failed to update sources.', error);
        return;
    }
    Promise.resolve(result).catch((error) => {
        console.error('cardsPage: failed to update sources.', error);
    });
}

/**
 * Builds a small icon-only control button with an accessible label.
 *
 * @param {object} options Button options.
 * @param {string} options.icon Font Awesome icon class (e.g. `fa-arrow-up`).
 * @param {string} options.label Accessible name (`aria-label`).
 * @param {string} [options.title] Tooltip / disabled explanation.
 * @param {boolean} [options.disabled] Whether the button is disabled.
 * @param {() => void} options.onClick Click handler.
 * @returns {Element} Button element.
 */
function buildControlButton({ icon, label, title, disabled, onClick }) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'bc-task-card-button';
    button.setAttribute('aria-label', label);
    if (title) {
        button.title = title;
    }
    button.disabled = disabled === true;

    const iconElement = document.createElement('i');
    iconElement.className = `fa-solid ${icon}`;
    iconElement.setAttribute('aria-hidden', 'true');
    button.append(iconElement);

    button.addEventListener('click', () => onClick());
    return button;
}

/**
 * Creates the Cards page module for the controller's page registry.
 *
 * @returns {{key: string, title: string, render: (container: Element, snapshot: object, actions: object) => Element|null, dispose: () => void}} Page module.
 */
export function createCardsPage() {
    /** @type {Element|null} Host container (the canvas). */
    let host = null;
    /** @type {object|null} Latest state snapshot. */
    let latestSnapshot = null;
    /** @type {object|null} Actions facade. */
    let latestActions = null;
    /** @type {string} Picker search query — survives state-driven re-renders. */
    let searchQuery = '';

    /**
     * Moves the source at `from` to position `to` and patches the array.
     *
     * @param {number} from Current index.
     * @param {number} to Target index.
     * @returns {void}
     */
    function moveSource(from, to) {
        const sources = sourcesOf(latestSnapshot);
        if (to < 0 || to >= sources.length) {
            return;
        }
        const next = [...sources];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        applySources(latestActions, next);
    }

    /**
     * Removes the source at `index` (blocked at the two-source floor).
     *
     * @param {number} index Source index.
     * @returns {void}
     */
    function removeSource(index) {
        const sources = sourcesOf(latestSnapshot);
        if (sources.length <= CARDS_PAGE_MIN_SOURCES) {
            return;
        }
        applySources(latestActions, sources.filter((_, sourceIndex) => sourceIndex !== index));
    }

    /**
     * Re-snapshots one source's name and core fields from its live
     * character. The server derives downstream staleness from the sources
     * change — the page only mutates the array.
     *
     * @param {number} index Source index.
     * @returns {void}
     */
    function refreshSource(index) {
        const sources = sourcesOf(latestSnapshot);
        const source = sources[index];
        const character = findLiveCharacter(source);
        if (!source || !character) {
            return;
        }
        const next = sources.map((entry, sourceIndex) => sourceIndex === index
            ? {
                ...entry,
                name: String(getCharacterName(character) ?? '') || entry.name,
                fields: getCoreCharacterPayload(character),
            }
            : entry);
        applySources(latestActions, next);
    }

    /**
     * Appends a roster character as a new source snapshot.
     *
     * @param {object} character Character record.
     * @param {number} id Character index within the roster.
     * @returns {void}
     */
    function addCharacter(character, id) {
        applySources(latestActions, [...sourcesOf(latestSnapshot), buildSourceFromCharacter(character, id)]);
    }

    /**
     * Lists roster characters that can still be added: named, not already a
     * source, and matching the current search query.
     *
     * @returns {Array<{character: object, id: number}>} Addable characters.
     */
    function availableCharacters() {
        const usedKeys = new Set(sourcesOf(latestSnapshot).map((source) => String(source?.key ?? '')));
        const query = searchQuery.trim().toLowerCase();
        return liveCharacters()
            .map((character, id) => ({ character, id }))
            .filter(({ character, id }) => {
                const name = String(getCharacterName(character) ?? '').trim();
                if (!name || usedKeys.has(sourceKeyFor(character, id))) {
                    return false;
                }
                return query.length === 0 || name.toLowerCase().includes(query);
            });
    }

    /**
     * Builds one source card (avatar, name, snapshot badge, field summary,
     * and the move/refresh/remove controls).
     *
     * @param {object} source Source record.
     * @param {number} index Position within the sources array.
     * @param {number} total Total source count.
     * @returns {Element} Card element.
     */
    function buildSourceCard(source, index, total) {
        const name = String(source?.name ?? '').trim() || 'Unnamed character';
        const liveCharacter = findLiveCharacter(source);
        const removeLocked = sourcesOf(latestSnapshot).length <= CARDS_PAGE_MIN_SOURCES;

        const card = document.createElement('article');
        card.className = 'bc-task-card';
        card.setAttribute('role', 'listitem');
        card.setAttribute('data-source-key', String(source?.key ?? ''));

        const avatar = document.createElement('img');
        avatar.className = 'bc-task-card-avatar';
        avatar.src = getThumbnailUrl('avatar', String(source?.avatar ?? ''));
        avatar.alt = name;
        avatar.title = name;

        const body = document.createElement('div');
        body.className = 'bc-task-card-body';

        const nameRow = document.createElement('div');
        nameRow.className = 'bc-task-card-name-row';
        const nameElement = document.createElement('span');
        nameElement.className = 'bc-task-card-name';
        nameElement.textContent = name;
        nameElement.title = name;
        const badge = document.createElement('span');
        badge.className = 'bc-task-snapshot-badge';
        badge.title = SNAPSHOT_BADGE_TITLE;
        const badgeIcon = document.createElement('i');
        badgeIcon.className = 'fa-solid fa-lock';
        badgeIcon.setAttribute('aria-hidden', 'true');
        const badgeLabel = document.createElement('span');
        badgeLabel.textContent = 'Snapshot';
        badge.append(badgeIcon, badgeLabel);
        nameRow.append(nameElement, badge);

        const fields = document.createElement('div');
        fields.className = 'bc-task-card-fields';
        fields.textContent = formatFieldSummary(source?.fields);

        body.append(nameRow, fields);

        const controls = document.createElement('div');
        controls.className = 'bc-task-card-controls';
        controls.append(
            buildControlButton({
                icon: 'fa-arrow-up',
                label: `Move ${name} up`,
                title: index === 0 ? 'Already at the top.' : `Move ${name} up.`,
                disabled: index === 0,
                onClick: () => moveSource(index, index - 1),
            }),
            buildControlButton({
                icon: 'fa-arrow-down',
                label: `Move ${name} down`,
                title: index === total - 1 ? 'Already at the bottom.' : `Move ${name} down.`,
                disabled: index === total - 1,
                onClick: () => moveSource(index, index + 1),
            }),
            buildControlButton({
                icon: 'fa-arrows-rotate',
                label: `Refresh ${name} snapshot`,
                title: liveCharacter ? REFRESH_TITLE : REFRESH_MISSING_TITLE,
                disabled: !liveCharacter,
                onClick: () => refreshSource(index),
            }),
            buildControlButton({
                icon: 'fa-xmark',
                label: `Remove ${name}`,
                title: removeLocked ? REMOVE_LOCKED_TITLE : `Remove ${name} from this task.`,
                disabled: removeLocked,
                onClick: () => removeSource(index),
            }),
        );

        card.append(avatar, body, controls);
        return card;
    }

    /**
     * Builds one picker row (avatar, name, Add button) for a roster character.
     *
     * @param {object} character Character record.
     * @param {number} id Character index within the roster.
     * @returns {Element} Picker row element.
     */
    function buildPickerRow(character, id) {
        const name = String(getCharacterName(character) ?? '').trim() || 'Unnamed character';

        const row = document.createElement('div');
        row.className = 'bc-task-picker-row';
        row.setAttribute('role', 'listitem');

        const avatar = document.createElement('img');
        avatar.className = 'bc-task-picker-avatar';
        avatar.src = getThumbnailUrl('avatar', String(character?.avatar ?? ''));
        avatar.alt = name;

        const nameElement = document.createElement('span');
        nameElement.className = 'bc-task-picker-name';
        nameElement.textContent = name;
        nameElement.title = name;

        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'bc-task-picker-add';
        addButton.setAttribute('aria-label', `Add ${name}`);
        addButton.textContent = 'Add';
        addButton.addEventListener('click', () => addCharacter(character, id));

        row.append(avatar, nameElement, addButton);
        return row;
    }

    /**
     * Rebuilds just the picker rows (used by the search input so typing
     * does not re-render the whole page or lose focus).
     *
     * @param {Element} listElement Picker list container.
     * @returns {void}
     */
    function renderPickerRows(listElement) {
        const matches = availableCharacters();
        const rows = matches
            .slice(0, CARDS_PAGE_PICKER_LIMIT)
            .map(({ character, id }) => buildPickerRow(character, id));

        const notes = [];
        if (matches.length > CARDS_PAGE_PICKER_LIMIT) {
            notes.push(`Showing the first ${CARDS_PAGE_PICKER_LIMIT} of ${matches.length} matching characters — refine your search.`);
        }
        if (matches.length === 0) {
            notes.push(searchQuery.trim() ? 'No characters match your search.' : 'No more characters to add.');
        }
        const noteElements = notes.map((text) => {
            const note = document.createElement('p');
            note.className = 'bc-task-picker-note';
            note.textContent = text;
            return note;
        });

        listElement.replaceChildren(...rows, ...noteElements);
    }

    /**
     * Builds the add-character picker section (search input + capped list).
     *
     * @returns {Element} Picker section.
     */
    function buildAddSection() {
        const section = document.createElement('section');
        section.className = 'bc-task-add';
        section.setAttribute('aria-label', 'Add a character');

        const title = document.createElement('h3');
        title.className = 'bc-task-add-title';
        title.textContent = 'Add character';

        const note = document.createElement('p');
        note.className = 'bc-task-add-note';
        note.textContent = 'Adding captures a new snapshot — later edits to the live card do not change this task until you refresh it.';

        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'bc-task-add-search';
        search.placeholder = 'Filter characters…';
        search.setAttribute('aria-label', 'Filter characters to add');
        search.value = searchQuery;

        const list = document.createElement('div');
        list.className = 'bc-task-picker-list';
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', 'Characters available to add');

        search.addEventListener('input', () => {
            searchQuery = String(search.value ?? '');
            renderPickerRows(list);
        });

        renderPickerRows(list);

        section.append(title, note, search, list);
        return section;
    }

    /**
     * Builds the footer: source count + Continue button (gated on the
     * two-source minimum).
     *
     * @returns {Element} Footer element.
     */
    function buildFooter() {
        const count = sourcesOf(latestSnapshot).length;

        const footer = document.createElement('footer');
        footer.className = 'bc-task-cards-footer';

        const counter = document.createElement('span');
        counter.className = 'bc-task-source-count';
        counter.textContent = `${count} source card${count === 1 ? '' : 's'}`;

        const continueButton = document.createElement('button');
        continueButton.type = 'button';
        continueButton.className = 'bc-task-continue';
        continueButton.textContent = 'Continue to Prompt & Settings';
        continueButton.disabled = count < CARDS_PAGE_MIN_SOURCES;
        if (continueButton.disabled) {
            continueButton.title = CONTINUE_LOCKED_TITLE;
        }
        continueButton.addEventListener('click', () => {
            if (sourcesOf(latestSnapshot).length >= CARDS_PAGE_MIN_SOURCES) {
                latestActions?.goToPage?.(2);
            }
        });

        footer.append(counter, continueButton);
        return footer;
    }

    /**
     * Rebuilds the whole page from the latest snapshot into the host.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        const sources = sourcesOf(latestSnapshot);

        const root = document.createElement('div');
        root.className = 'bc-task-page bc-task-cards';

        const heading = document.createElement('h2');
        heading.className = 'bc-task-page-title';
        heading.tabIndex = -1;
        heading.textContent = 'Cards';

        const guidance = document.createElement('p');
        guidance.className = 'bc-task-page-note';
        guidance.textContent = 'Source cards are stored as immutable snapshots: generation uses this captured data, never the live card. Refreshing a snapshot re-captures it and marks downstream results stale.';

        const list = document.createElement('div');
        list.className = 'bc-task-cards-list';
        list.setAttribute('role', 'list');
        list.setAttribute('aria-label', 'Source cards');
        if (sources.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'bc-task-cards-empty';
            empty.textContent = 'No source cards yet — add at least two characters below.';
            list.append(empty);
        } else {
            for (const [index, source] of sources.entries()) {
                list.append(buildSourceCard(source, index, sources.length));
            }
        }

        root.append(heading, guidance, list, buildAddSection(), buildFooter());
        host.replaceChildren(root);
        return heading;
    }

    return {
        key: 'cards',
        title: 'Cards',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call, and all listeners live on the
         * replaced elements (never on the container or external targets).
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
         * Releases stored references. No listeners were added to external
         * targets, so there is nothing else to detach.
         *
         * @returns {void}
         */
        dispose() {
            host = null;
            latestSnapshot = null;
            latestActions = null;
            searchQuery = '';
        },
    };
}
