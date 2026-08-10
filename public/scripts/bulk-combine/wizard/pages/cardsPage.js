'use strict';

/**
 * @file Cards page (page 1) for the 8-page Bulk Combine guided task wizard.
 *
 * Renders the task's source-card snapshots: avatar thumbnail, name, an
 * immutable-snapshot badge, and a compact captured-field summary per card,
 * in `task.sources` array order. Per-card controls move up/down, refresh
 * the snapshot from the live character, or remove the card (a combine needs
 * at least two sources, so removal locks at that floor). Each card also
 * carries a collapsible "Notes for generation" editor (ephemeral collapse
 * state; notes commit as sparse `sourceNotes` patches) with a
 * captured-fields block below it (a "Use task default" inherit toggle plus
 * the four optional-field checkboxes, committing sparse `sourceFields`
 * patches). A filterable
 * picker appends characters that are not sources yet; the footer continues
 * to the Prompt & Settings page. Rebuilds preserve scroll positions via
 * `scrollRestore` (the card list carries `data-scroll-key="card-list"`).
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

import { characters, getThumbnailUrl, unshallowCharacter } from '../../../../script.js';
import { getCharacterName, getCoreCharacterPayload } from '../../helpers.js';
import { ALL_CAPTURABLE_KEYS, CAPTURABLE_FIELDS, effectiveSourceFields, sourceFieldsOverride } from './fieldsModel.js';
import { captureScroll, restoreScroll } from './scrollRestore.js';

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
const NOTES_BADGE_TITLE = 'This card has notes for generation.';
const NOTES_HINT = 'Injected into this card\'s Transform 1 prompt.';
const CAPTURED_FIELDS_LABEL = 'Captured fields';
const FIELDS_INHERIT_LABEL = 'Use task default';
const READ_ONLY_NOTE = 'This task is completed — it is read-only. Duplicate it from Task History to keep iterating.';

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
 * file name, together with its roster index. Sources without an avatar (or
 * whose card was deleted) have no live character.
 *
 * @param {object} [source] Source record (`{ avatar }`).
 * @returns {{character: object, id: number}|null} Live character + roster index, or null when gone.
 */
function findLiveCharacterEntry(source) {
    const avatar = String(source?.avatar ?? '');
    if (!avatar) {
        return null;
    }
    const id = liveCharacters().findIndex((character) => String(character?.avatar ?? '') === avatar);
    return id >= 0 ? { character: liveCharacters()[id], id } : null;
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
    return findLiveCharacterEntry(source)?.character ?? null;
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
 * Reads the stored generation note for a source key from a state snapshot,
 * tolerating partial shapes.
 *
 * @param {object} [snapshot] State snapshot (`{ task }`).
 * @param {string} sourceKey Source key.
 * @returns {string} Stored note text ('' when absent).
 */
function storedNote(snapshot, sourceKey) {
    return String(snapshot?.task?.sourceNotes?.[sourceKey] ?? '');
}

/**
 * Whether a note counts as filled (drives the collapsed-view badge).
 *
 * @param {string} text Note text.
 * @returns {boolean} True when the note has non-whitespace content.
 */
function noteFilled(text) {
    return String(text).trim().length > 0;
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
     * Uncommitted note text, keyed by `data-field-key` (`note:<sourceKey>`).
     * Updated on `input`, committed on `change`, restored across rebuilds so
     * re-renders never clobber typing.
     *
     * @type {Map<string, string>}
     */
    const noteDrafts = new Map();
    /**
     * Source keys whose notes editor is expanded. Ephemeral UI state —
     * cards default to collapsed and the set is never persisted.
     *
     * @type {Set<string>}
     */
    const expandedNotes = new Set();
    /**
     * Note textareas built this render, keyed by `data-field-key` — used to
     * restore focus after a rebuild (the fake DOM has no querySelector).
     *
     * @type {Map<string, Element>}
     */
    let fieldRefs = new Map();
    /**
     * Whether the task is completed and therefore read-only: recomputed on
     * every render from the snapshot.
     *
     * @type {boolean}
     */
    let readOnlyMode = false;

    /**
     * Commits one card's note as a sparse PATCH (the server deep-merges
     * records, so only the one key is sent). The draft is kept until the
     * patch resolves so a failed update never loses typing; it is cleared
     * on success when unchanged since. Failures are logged, never thrown
     * into render/change paths.
     *
     * @param {string} sourceKey Source key.
     * @param {string} draftKey Draft-map key (`note:<sourceKey>`).
     * @param {string} text Committed note text.
     * @returns {void}
     */
    function commitNote(sourceKey, draftKey, text) {
        let result;
        try {
            result = latestActions?.update?.({ sourceNotes: { [sourceKey]: text } });
        } catch (error) {
            console.error('cardsPage: failed to update the note.', error);
            return;
        }
        Promise.resolve(result).then(() => {
            if (noteDrafts.get(draftKey) === text) {
                noteDrafts.delete(draftKey);
            }
        }).catch((error) => {
            console.error('cardsPage: failed to update the note.', error);
        });
    }

    /**
     * Commits one card's captured-fields selection as a sparse PATCH (the
     * server deep-merges records, so only the one key is sent). `null`
     * clears the override, returning the card to the task default.
     * Failures are logged, never thrown into render/change paths.
     *
     * @param {string} sourceKey Source key.
     * @param {string[]|null} fields Selected optional keys, or null to inherit.
     * @returns {void}
     */
    function patchSourceFields(sourceKey, fields) {
        let result;
        try {
            result = latestActions?.update?.({ sourceFields: { [sourceKey]: fields } });
        } catch (error) {
            console.error('cardsPage: failed to update captured fields.', error);
            return;
        }
        Promise.resolve(result).catch((error) => {
            console.error('cardsPage: failed to update captured fields.', error);
        });
    }

    /**
     * Builds a small checkbox row (input + text label) that commits on
     * `change`. A field key registers the input in the focus-restore map
     * so state-driven rebuilds do not strand keyboard users.
     *
     * @param {object} options Checkbox options.
     * @param {string} options.label Visible label.
     * @param {string} options.ariaLabel Accessible name.
     * @param {boolean} options.checked Current state.
     * @param {boolean} [options.disabled] Disabled state.
     * @param {string} [options.fieldKey] Stable `data-field-key` for focus tracking.
     * @param {(checked: boolean) => void} options.onChange Commit callback.
     * @returns {Element} Label element wrapping the input.
     */
    function buildFieldsCheckbox({ label, ariaLabel, checked, disabled, fieldKey, onChange }) {
        const wrapper = document.createElement('label');
        wrapper.className = 'bc-task-card-field-option';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = checked === true;
        input.disabled = disabled === true;
        input.setAttribute('aria-label', ariaLabel);
        if (fieldKey) {
            input.setAttribute('data-field-key', fieldKey);
            fieldRefs.set(fieldKey, input);
        }
        input.addEventListener('change', () => onChange(input.checked === true));
        const text = document.createElement('span');
        text.className = 'bc-task-card-field-option-label';
        text.textContent = label;
        wrapper.append(input, text);
        return wrapper;
    }

    /**
     * Builds the per-card captured-fields block: a "Use task default"
     * inherit toggle plus the four optional-field checkboxes showing the
     * EFFECTIVE selection (override ?? task default). While inheriting,
     * the four boxes are disabled; turning inherit off commits the current
     * effective selection as the card's override, and turning it back on
     * clears the override with a null patch. Checkbox toggles while not
     * inheriting PATCH the new selection sparsely (canonical order).
     *
     * @param {object} source Source record.
     * @param {string} name Display name (for accessible names).
     * @returns {Element} Captured-fields block.
     */
    function buildCapturedFieldsBlock(source, name) {
        const sourceKey = String(source?.key ?? '');
        const task = recordOfTask();
        const inheriting = sourceFieldsOverride(task, sourceKey) === null;
        const selection = new Set(effectiveSourceFields(task, sourceKey));
        const commitSelection = () => patchSourceFields(sourceKey, ALL_CAPTURABLE_KEYS.filter((key) => selection.has(key)));

        const block = document.createElement('div');
        block.className = 'bc-task-card-captured-fields';

        const label = document.createElement('span');
        label.className = 'bc-task-card-captured-fields-label';
        label.textContent = CAPTURED_FIELDS_LABEL;

        const inheritToggle = buildFieldsCheckbox({
            label: FIELDS_INHERIT_LABEL,
            ariaLabel: `Use the task default captured fields for ${name}`,
            checked: inheriting,
            disabled: readOnlyMode,
            fieldKey: `fields-inherit:${sourceKey}`,
            onChange: (checked) => {
                if (checked) {
                    patchSourceFields(sourceKey, null);
                } else {
                    commitSelection();
                }
            },
        });

        const options = document.createElement('div');
        options.className = 'bc-task-card-captured-fields-options';
        for (const { key, label: fieldLabel } of CAPTURABLE_FIELDS) {
            options.append(buildFieldsCheckbox({
                label: fieldLabel,
                ariaLabel: `Capture ${fieldLabel} for ${name}`,
                checked: selection.has(key),
                disabled: inheriting || readOnlyMode,
                fieldKey: `fields:${sourceKey}:${key}`,
                onChange: (checked) => {
                    if (checked) {
                        selection.add(key);
                    } else {
                        selection.delete(key);
                    }
                    commitSelection();
                },
            }));
        }

        block.append(label, inheritToggle, options);
        return block;
    }

    /**
     * Reads the current task record defensively.
     *
     * @returns {object} Task record (possibly empty).
     */
    function recordOfTask() {
        const task = latestSnapshot?.task;
        return task !== null && typeof task === 'object' && !Array.isArray(task) ? task : {};
    }

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
     * character. With lazy character loading the roster entry may be
     * shallow, so the character is unshallowed BEFORE reading payload
     * fields — otherwise the snapshot would capture empty descriptions.
     * The server derives downstream staleness from the sources change —
     * the page only mutates the array.
     *
     * @param {number} index Source index.
     * @returns {Promise<void>}
     */
    async function refreshSource(index) {
        const sources = sourcesOf(latestSnapshot);
        const source = sources[index];
        const live = findLiveCharacterEntry(source);
        if (!source || !live) {
            return;
        }
        const { character, id } = live;
        try {
            await unshallowCharacter(id);
        } catch (error) {
            console.error('cardsPage: failed to load the full character before refreshing.', error);
            return;
        }
        // unshallowCharacter REPLACES the roster entry (getOneCharacter), so
        // re-read the live record — the pre-await reference stays shallow.
        const full = liveCharacters()[id] ?? character;
        const next = sources.map((entry, sourceIndex) => sourceIndex === index
            ? {
                ...entry,
                name: String(getCharacterName(full) ?? '') || entry.name,
                fields: getCoreCharacterPayload(full),
            }
            : entry);
        applySources(latestActions, next);
    }

    /**
     * Appends a roster character as a new source snapshot. With lazy
     * character loading the roster entry may be shallow, so the character
     * is unshallowed BEFORE reading payload fields — otherwise the
     * snapshot would capture empty descriptions.
     *
     * @param {object} character Character record.
     * @param {number} id Character index within the roster.
     * @returns {Promise<void>}
     */
    async function addCharacter(character, id) {
        try {
            await unshallowCharacter(id);
        } catch (error) {
            console.error('cardsPage: failed to load the full character before adding.', error);
            return;
        }
        // unshallowCharacter REPLACES the roster entry (getOneCharacter), so
        // re-read the live record — the pre-await reference stays shallow.
        const full = liveCharacters()[id] ?? character;
        applySources(latestActions, [...sourcesOf(latestSnapshot), buildSourceFromCharacter(full, id)]);
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
                disabled: index === 0 || readOnlyMode,
                onClick: () => moveSource(index, index - 1),
            }),
            buildControlButton({
                icon: 'fa-arrow-down',
                label: `Move ${name} down`,
                title: index === total - 1 ? 'Already at the bottom.' : `Move ${name} down.`,
                disabled: index === total - 1 || readOnlyMode,
                onClick: () => moveSource(index, index + 1),
            }),
            buildControlButton({
                icon: 'fa-arrows-rotate',
                label: `Refresh ${name} snapshot`,
                title: liveCharacter ? REFRESH_TITLE : REFRESH_MISSING_TITLE,
                disabled: !liveCharacter || readOnlyMode,
                onClick: () => void refreshSource(index),
            }),
            buildControlButton({
                icon: 'fa-xmark',
                label: `Remove ${name}`,
                title: removeLocked ? REMOVE_LOCKED_TITLE : `Remove ${name} from this task.`,
                disabled: removeLocked || readOnlyMode,
                onClick: () => removeSource(index),
            }),
        );

        card.append(avatar, body, controls, buildNotesSection(source));
        return card;
    }

    /**
     * Builds the collapsible per-card notes editor: a chevron toggle row
     * (with a filled dot while a note exists, so non-empty notes stay
     * visible when collapsed) over a draft-protected textarea. Collapse
     * state is ephemeral — held in `expandedNotes`, never persisted — and
     * the toggle/badge update from local state immediately, without a
     * server round-trip.
     *
     * @param {object} source Source record.
     * @returns {Element} Notes section element.
     */
    function buildNotesSection(source) {
        const sourceKey = String(source?.key ?? '');
        const name = String(source?.name ?? '').trim() || 'Unnamed character';
        const draftKey = `note:${sourceKey}`;
        const expanded = expandedNotes.has(sourceKey);
        const text = noteDrafts.has(draftKey) ? noteDrafts.get(draftKey) : storedNote(latestSnapshot, sourceKey);

        const section = document.createElement('div');
        section.className = `bc-task-card-notes${expanded ? ' expanded' : ''}`;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'bc-task-card-notes-toggle';
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.setAttribute('aria-label', `Notes for ${name}`);
        const bodyId = `bc-task-card-notes-body-${sourceKey}`;
        toggle.setAttribute('aria-controls', bodyId);

        const chevron = document.createElement('i');
        chevron.className = 'fa-solid fa-chevron-right bc-task-card-notes-chevron';
        chevron.setAttribute('aria-hidden', 'true');

        const label = document.createElement('span');
        label.className = 'bc-task-card-notes-label';
        label.textContent = 'Notes for generation';

        const badge = document.createElement('span');
        badge.className = 'bc-task-card-notes-badge';
        badge.title = NOTES_BADGE_TITLE;
        badge.setAttribute('role', 'img');
        badge.setAttribute('aria-label', 'Has notes');
        badge.hidden = !noteFilled(text);

        toggle.append(chevron, label, badge);

        const body = document.createElement('div');
        body.className = 'bc-task-card-notes-body';
        body.id = bodyId;
        body.hidden = !expanded;

        const textarea = document.createElement('textarea');
        textarea.className = 'bc-task-card-notes-textarea';
        textarea.rows = 3;
        textarea.setAttribute('data-field-key', draftKey);
        textarea.setAttribute('aria-label', `Notes for generation for ${name}`);
        textarea.readOnly = readOnlyMode === true;
        textarea.value = text;
        textarea.addEventListener('input', () => {
            const draft = String(textarea.value ?? '');
            noteDrafts.set(draftKey, draft);
            badge.hidden = !noteFilled(draft);
        });
        textarea.addEventListener('change', () => {
            const committed = String(textarea.value ?? '');
            noteDrafts.set(draftKey, committed);
            commitNote(sourceKey, draftKey, committed);
        });
        fieldRefs.set(draftKey, textarea);

        const hint = document.createElement('p');
        hint.className = 'bc-task-field-hint';
        hint.textContent = NOTES_HINT;

        body.append(textarea, hint, buildCapturedFieldsBlock(source, name));

        toggle.addEventListener('click', () => {
            const nowExpanded = !expandedNotes.has(sourceKey);
            if (nowExpanded) {
                expandedNotes.add(sourceKey);
                section.classList.add('expanded');
            } else {
                expandedNotes.delete(sourceKey);
                section.classList.remove('expanded');
            }
            toggle.setAttribute('aria-expanded', nowExpanded ? 'true' : 'false');
            body.hidden = !nowExpanded;
        });

        section.append(toggle, body);
        return section;
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
        addButton.disabled = readOnlyMode === true;
        addButton.textContent = 'Add';
        addButton.addEventListener('click', () => void addCharacter(character, id));

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
        search.disabled = readOnlyMode === true;

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
     * Captures the focused field (by `data-field-key`) plus selection before
     * the rebuild and restores them afterwards, so state-driven re-renders
     * never clobber an in-progress note edit.
     *
     * @returns {Element} The page heading (focus target).
     */
    function renderPage() {
        readOnlyMode = recordOfTask().status === 'completed';
        const sources = sourcesOf(latestSnapshot);

        const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
        const activeKey = activeElement?.getAttribute?.('data-field-key') ?? null;
        const selectionStart = typeof activeElement?.selectionStart === 'number' ? activeElement.selectionStart : null;
        const selectionEnd = typeof activeElement?.selectionEnd === 'number' ? activeElement.selectionEnd : null;
        fieldRefs = new Map();

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
        list.setAttribute('data-scroll-key', 'card-list');
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

        root.append(heading, guidance);

        if (readOnlyMode) {
            const readOnly = document.createElement('p');
            readOnly.className = 'bc-task-readonly-note';
            readOnly.setAttribute('role', 'status');
            readOnly.textContent = READ_ONLY_NOTE;
            root.append(readOnly);
        }

        root.append(list, buildAddSection(), buildFooter());
        const scrollPositions = captureScroll(host);
        host.replaceChildren(root);
        restoreScroll(host, scrollPositions);

        if (activeKey && fieldRefs.has(activeKey)) {
            const element = fieldRefs.get(activeKey);
            element.focus?.();
            if (selectionStart !== null && typeof element.setSelectionRange === 'function') {
                try {
                    element.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
                } catch {
                    // Not a text-entry element in a real browser — focus is enough.
                }
            }
        }
        return heading;
    }

    return {
        key: 'cards',
        title: 'Cards',
        /**
         * Renders the page from the state snapshot. Idempotent: the host is
         * cleared and rebuilt on every call, and all listeners live on the
         * replaced elements (never on the container or external targets).
         * Uncommitted note drafts win over the server values so re-renders
         * never clobber typing.
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
         * Releases stored references and ephemeral UI state. No listeners
         * were added to external targets, so there is nothing else to detach.
         *
         * @returns {void}
         */
        dispose() {
            host = null;
            latestSnapshot = null;
            latestActions = null;
            searchQuery = '';
            noteDrafts.clear();
            expandedNotes.clear();
            fieldRefs = new Map();
            readOnlyMode = false;
        },
    };
}
