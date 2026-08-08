'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for `public/scripts/bulk-combine/wizard/pages/cardsPage.js`.
 *
 * `script.js` is mocked for the `characters` roster and `getThumbnailUrl`;
 * `helpers.js` is mocked for name/core-payload resolution (mirroring the
 * real implementations' fallback chain). The Node test environment has no
 * DOM, so a minimal fake `document`/element tree backs the page (the
 * implementation uses plain DOM APIs only — no jQuery, no HTML parsing).
 */

import {
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

/** @type {object[]} Mutable roster backing the mocked `characters` export. */
const mockCharacters = [];
/** @type {jest.Mock} Controllable unshallowCharacter double. */
const mockUnshallowCharacter = jest.fn(async () => {});

jest.unstable_mockModule('../../public/script.js', () => ({
    characters: mockCharacters,
    getThumbnailUrl: (type, file) => `/thumbnail?type=${type}&file=${encodeURIComponent(String(file ?? ''))}`,
    unshallowCharacter: (...args) => mockUnshallowCharacter(...args),
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/helpers.js', () => ({
    getCharacterName: (character) => character?.name
        ?? character?.ch_name
        ?? character?.data?.name
        ?? character?.data?.ch_name
        ?? '',
    getCoreCharacterPayload: (character) => ({
        name: String(character?.name ?? character?.data?.name ?? ''),
        description: String(character?.description ?? character?.data?.description ?? ''),
        personality: String(character?.personality ?? character?.data?.personality ?? ''),
        scenario: String(character?.scenario ?? character?.data?.scenario ?? ''),
        first_mes: String(character?.first_mes ?? character?.data?.first_mes ?? ''),
        mes_example: String(character?.mes_example ?? character?.data?.mes_example ?? ''),
    }),
}));

// ---------------------------------------------------------------------------
// Minimal fake DOM
// ---------------------------------------------------------------------------

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.className = '';
        this.value = '';
        this.disabled = false;
        this.tabIndex = 0;
        this.title = '';
        this.type = '';
        this.id = '';
        this.src = '';
        this.alt = '';
        this.placeholder = '';
        this.focused = false;
        this._text = '';
        this._listeners = new Map();
    }

    get classList() {
        const el = this;
        const read = () => el.className.split(/\s+/).filter(Boolean);
        return {
            add: (...classes) => {
                el.className = [...new Set([...read(), ...classes])].join(' ');
            },
            remove: (...classes) => {
                el.className = read().filter((c) => !classes.includes(c)).join(' ');
            },
            contains: (c) => read().includes(c),
        };
    }

    get textContent() {
        if (this.children.length > 0) {
            return this.children.map((child) => child.textContent).join('');
        }
        return this._text;
    }

    set textContent(value) {
        this._text = String(value ?? '');
        this.children = [];
    }

    append(...nodes) {
        for (const node of nodes) {
            node.parentElement = this;
            this.children.push(node);
        }
    }

    replaceChildren(...nodes) {
        for (const child of this.children) {
            child.parentElement = null;
        }
        this.children = [];
        this._text = '';
        this.append(...nodes);
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }

    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    removeAttribute(name) {
        this.attributes.delete(name);
    }

    addEventListener(type, fn) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(fn);
    }

    removeEventListener(type, fn) {
        const list = this._listeners.get(type) ?? [];
        this._listeners.set(type, list.filter((f) => f !== fn));
    }

    /**
     * Fires listeners for an event type (test helper).
     *
     * @param {string} type Event type.
     * @param {object} [event] Extra event fields (may override target).
     */
    fire(type, event = {}) {
        for (const fn of this._listeners.get(type) ?? []) {
            fn({ target: this, preventDefault: () => {}, ...event });
        }
    }

    click() {
        if (this.disabled) {
            return;
        }
        this.fire('click');
    }

    focus() {
        this.focused = true;
        fakeDocument.activeElement = this;
    }
}

const fakeDocument = {
    activeElement: null,
    createElement: (tag) => new FakeElement(tag),
};

// ---------------------------------------------------------------------------
// Traversal helpers (the fake DOM has no querySelector)
// ---------------------------------------------------------------------------

/**
 * @param {object} node Root fake element.
 * @param {(node: object) => void} visit Visitor.
 * @returns {void}
 */
function walk(node, visit) {
    visit(node);
    for (const child of node.children ?? []) {
        walk(child, visit);
    }
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object[]} Matching elements in document order.
 */
function findAll(root, predicate) {
    const matches = [];
    walk(root, (element) => {
        if (predicate(element)) {
            matches.push(element);
        }
    });
    return matches;
}

/**
 * @param {object} root Root fake element.
 * @param {(node: object) => boolean} predicate Matcher.
 * @returns {object|null} First match, or null.
 */
function findOne(root, predicate) {
    return findAll(root, predicate)[0] ?? null;
}

/**
 * @param {string} className Single class token.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasClass(className) {
    return (element) => String(element.className ?? '').split(/\s+/).includes(className);
}

/**
 * @param {string} label Expected `aria-label` value.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasAriaLabel(label) {
    return (element) => typeof element.getAttribute === 'function' && element.getAttribute('aria-label') === label;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Character fixture.
 */
function makeCharacter(overrides = {}) {
    return {
        name: 'Alice',
        avatar: 'a.png',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        ...overrides,
    };
}

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Source snapshot fixture.
 */
function makeSource(overrides = {}) {
    return {
        key: 'a.png',
        name: 'Alice',
        avatar: 'a.png',
        fields: { name: 'Alice', description: 'Desc A', personality: '', scenario: '', first_mes: '', mes_example: '' },
        ...overrides,
    };
}

/**
 * @param {object[]} sources Task sources.
 * @param {object} [sourceNotes] Per-source generation notes (`{ [key]: text }`).
 * @returns {object} State snapshot payload (mirrors `TaskWizardState#getSnapshot`).
 */
function makeSnapshot(sources, sourceNotes = {}) {
    return {
        task: { id: 'task-1', name: 'Task', sources, sourceNotes },
        derivedStaleness: {},
        pageStates: [],
        currentPage: 1,
        furthestPage: 1,
        conflict: false,
        syncState: 'saved',
    };
}

/** @returns {object} Actions facade mock. */
function makeActions() {
    return {
        update: jest.fn(async () => {}),
        refresh: jest.fn(async () => {}),
        goToPage: jest.fn(),
        navigate: jest.fn(),
    };
}

let createCardsPage;
let container;

/** @returns {Promise<void>} Flushes microtasks and short timers (async add/refresh handlers). */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Creates a page, renders it, and returns the pieces under test.
 *
 * @param {object[]} sources Task sources.
 * @param {object} [actions] Actions facade mock.
 * @param {object} [sourceNotes] Per-source generation notes.
 * @returns {{page: object, heading: Element, root: Element, actions: object}} Rendered page pieces.
 */
function renderCardsPage(sources, actions = makeActions(), sourceNotes = {}) {
    const page = createCardsPage();
    const heading = page.render(container, makeSnapshot(sources, sourceNotes), actions);
    return { page, heading, root: container.children[0], actions };
}

/**
 * Finds the rendered card element for a source key.
 *
 * @param {object} root Root fake element.
 * @param {string} sourceKey Source key (`data-source-key`).
 * @returns {object|null} Card element, or null.
 */
function cardFor(root, sourceKey) {
    return findOne(root, (element) => typeof element.getAttribute === 'function'
        && element.getAttribute('data-source-key') === sourceKey);
}

beforeAll(async () => {
    ({ createCardsPage } = await import('../../public/scripts/bulk-combine/wizard/pages/cardsPage.js'));
});

beforeEach(() => {
    mockCharacters.splice(0, mockCharacters.length);
    mockUnshallowCharacter.mockClear();
    mockUnshallowCharacter.mockImplementation(async () => {});
    fakeDocument.activeElement = null;
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');
});

afterEach(() => {
    delete global.document;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cardsPage', () => {
    test('renders heading, guidance, and one card per source with name, badge, and field summary', () => {
        mockCharacters.push(
            makeCharacter({ name: 'Alice', avatar: 'a.png', description: 'Desc A', personality: 'brave' }),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
        );
        const { heading, root } = renderCardsPage([
            makeSource({ fields: { name: 'Alice', description: 'Desc A', personality: 'brave', scenario: '', first_mes: '', mes_example: '' } }),
            makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob', description: '', personality: '', scenario: '', first_mes: '', mes_example: '' } }),
        ]);

        // Heading is the focus target.
        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Cards');
        expect(heading.tabIndex).toBe(-1);
        // Guidance covers the immutable-snapshot + staleness contract.
        expect(root.textContent).toContain('immutable snapshots');
        expect(root.textContent).toContain('stale');

        const cards = findAll(root, hasClass('bc-task-card'));
        expect(cards).toHaveLength(2);
        expect(cards[0].textContent).toContain('Alice');
        expect(cards[1].textContent).toContain('Bob');
        for (const card of cards) {
            expect(findOne(card, hasClass('bc-task-snapshot-badge'))?.textContent).toContain('Snapshot');
        }

        // Compact field summary lists only captured core fields.
        const summaries = findAll(root, hasClass('bc-task-card-fields'));
        expect(summaries[0].textContent).toBe('Fields captured: Name, Description, Personality');
        expect(summaries[1].textContent).toBe('Fields captured: Name');

        // Avatar thumbnails resolve via getThumbnailUrl('avatar', file).
        const avatarImg = findOne(cards[0], hasClass('bc-task-card-avatar'));
        expect(avatarImg.src).toBe('/thumbnail?type=avatar&file=a.png');
    });

    test('move up/down reorders via actions.update with the full new array; boundaries disabled', () => {
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        const c = makeSource({ key: 'c.png', name: 'Carol', avatar: 'c.png', fields: { name: 'Carol' } });
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
            makeCharacter({ name: 'Carol', avatar: 'c.png' }),
        );
        const { root, actions } = renderCardsPage([a, b, c]);

        findOne(root, hasAriaLabel('Move Alice down')).click();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ sources: [b, a, c] });

        findOne(root, hasAriaLabel('Move Bob up')).click();
        expect(actions.update).toHaveBeenCalledTimes(2);
        expect(actions.update).toHaveBeenLastCalledWith({ sources: [b, a, c] });

        // Boundary controls are disabled (and the fake click is a no-op).
        expect(findOne(root, hasAriaLabel('Move Alice up')).disabled).toBe(true);
        expect(findOne(root, hasAriaLabel('Move Carol down')).disabled).toBe(true);
        findOne(root, hasAriaLabel('Move Alice up')).click();
        findOne(root, hasAriaLabel('Move Carol down')).click();
        expect(actions.update).toHaveBeenCalledTimes(2);
    });

    test('remove sends the filtered array and locks with an explanation at two sources', () => {
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        const c = makeSource({ key: 'c.png', name: 'Carol', avatar: 'c.png', fields: { name: 'Carol' } });
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
            makeCharacter({ name: 'Carol', avatar: 'c.png' }),
        );
        const { page, root, actions } = renderCardsPage([a, b, c]);

        findOne(root, hasAriaLabel('Remove Bob')).click();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ sources: [a, c] });

        // Re-render with two sources: every remove button locks with a reason.
        page.render(container, makeSnapshot([a, c]), actions);
        const removeButtons = findAll(container, (element) =>
            hasClass('bc-task-card-button')(element)
            && String(element.getAttribute('aria-label') ?? '').startsWith('Remove '));
        expect(removeButtons).toHaveLength(2);
        for (const button of removeButtons) {
            expect(button.disabled).toBe(true);
            expect(button.title).toContain('2 source cards are required');
        }
        removeButtons[0].click();
        expect(actions.update).toHaveBeenCalledTimes(1);
    });

    test('refresh re-snapshots name and fields from the live character; disabled when the character is gone', async () => {
        const a = makeSource({ fields: { name: 'Alice', description: 'OLD', personality: '', scenario: '', first_mes: '', mes_example: '' } });
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        const gone = makeSource({ key: 'gone.png', name: 'Ghost', avatar: 'gone.png', fields: { name: 'Ghost' } });
        mockCharacters.push(
            makeCharacter({ name: 'Alice Renamed', avatar: 'a.png', description: 'NEW DESC', personality: 'brave' }),
            makeCharacter({ name: 'Bob', avatar: 'b.png', description: 'B' }),
        );
        const { root, actions } = renderCardsPage([a, b, gone]);

        findOne(root, hasAriaLabel('Refresh Alice snapshot')).click();
        await flush();
        expect(mockUnshallowCharacter).toHaveBeenCalledWith(0);
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({
            sources: [
                {
                    ...a,
                    name: 'Alice Renamed',
                    fields: { name: 'Alice Renamed', description: 'NEW DESC', personality: 'brave', scenario: '', first_mes: '', mes_example: '' },
                },
                b,
                gone,
            ],
        });

        // Deleted live character: refresh disabled with an explanatory title.
        const missingButton = findOne(root, hasAriaLabel('Refresh Ghost snapshot'));
        expect(missingButton.disabled).toBe(true);
        expect(missingButton.title).toContain('no longer exists');
        missingButton.click();
        await flush();
        expect(actions.update).toHaveBeenCalledTimes(1);
    });

    test('add and refresh unshallow the roster character BEFORE reading payload fields (lazy loading)', async () => {
        // Lazy-loaded roster: fields arrive only after unshallowCharacter
        // replaces the roster entry (mirrors getOneCharacter semantics).
        mockCharacters.push(
            makeCharacter({ name: 'Alice', avatar: 'a.png' }),
            makeCharacter({ name: 'Shallow Sam', avatar: 's.png', shallow: true }),
        );
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        mockUnshallowCharacter.mockImplementation(async (id) => {
            if (id === 1) {
                mockCharacters[1] = makeCharacter({ name: 'Shallow Sam', avatar: 's.png', description: 'FULL DESC', personality: 'calm' });
            }
            if (id === 0) {
                mockCharacters[0] = makeCharacter({ name: 'Alice', avatar: 'a.png', description: 'FULL A' });
            }
        });
        const { page, root, actions } = renderCardsPage([a, b]);

        // Add: the snapshot must carry the unshallowed fields, not ''.
        findOne(root, hasAriaLabel('Add Shallow Sam')).click();
        await flush();
        expect(mockUnshallowCharacter).toHaveBeenCalledWith(1);
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenLastCalledWith({
            sources: [
                a,
                b,
                {
                    key: 's.png',
                    name: 'Shallow Sam',
                    avatar: 's.png',
                    fields: { name: 'Shallow Sam', description: 'FULL DESC', personality: 'calm', scenario: '', first_mes: '', mes_example: '' },
                },
            ],
        });

        // Refresh: re-reads the (replaced) roster entry after unshallowing.
        page.render(container, makeSnapshot([a, b]), actions);
        findOne(container, hasAriaLabel('Refresh Alice snapshot')).click();
        await flush();
        expect(mockUnshallowCharacter).toHaveBeenCalledWith(0);
        expect(actions.update).toHaveBeenCalledTimes(2);
        expect(actions.update).toHaveBeenLastCalledWith({
            sources: [
                { ...a, fields: { name: 'Alice', description: 'FULL A', personality: '', scenario: '', first_mes: '', mes_example: '' } },
                b,
            ],
        });
    });

    test('add appends a correctly shaped source; picker excludes added characters and filters by search', async () => {
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
            makeCharacter({ name: 'Carol', avatar: 'c.png', description: 'C desc', personality: 'calm' }),
            makeCharacter({ name: 'Dave', avatar: 'd.png' }),
            makeCharacter({ name: '', avatar: 'x.png' }), // Unnamed — never listed.
        );
        const { root, actions } = renderCardsPage([a, b]);

        // Only not-yet-added, named characters appear.
        let rows = findAll(root, hasClass('bc-task-picker-row'));
        expect(rows).toHaveLength(2);
        expect(findOne(root, hasAriaLabel('Add Carol'))).not.toBe(null);
        expect(findOne(root, hasAriaLabel('Add Dave'))).not.toBe(null);
        expect(findOne(root, hasAriaLabel('Add Alice'))).toBe(null);
        expect(findOne(root, hasAriaLabel('Add Bob'))).toBe(null);

        findOne(root, hasAriaLabel('Add Carol')).click();
        await flush();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({
            sources: [
                a,
                b,
                {
                    key: 'c.png',
                    name: 'Carol',
                    avatar: 'c.png',
                    fields: { name: 'Carol', description: 'C desc', personality: 'calm', scenario: '', first_mes: '', mes_example: '' },
                },
            ],
        });

        // Search filters the picker rows (list-only re-render, page root kept).
        const search = findOne(root, hasClass('bc-task-add-search'));
        search.value = 'dav';
        search.fire('input');
        rows = findAll(root, hasClass('bc-task-picker-row'));
        expect(rows).toHaveLength(1);
        expect(rows[0].textContent).toContain('Dave');
    });

    test('picker caps rendered rows and asks to refine the search', () => {
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
        );
        for (let index = 0; index < 60; index++) {
            mockCharacters.push(makeCharacter({ name: `Extra ${String(index).padStart(2, '0')}`, avatar: `extra-${index}.png` }));
        }
        const { root } = renderCardsPage([
            makeSource(),
            makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } }),
        ]);

        expect(findAll(root, hasClass('bc-task-picker-row'))).toHaveLength(50);
        expect(root.textContent).toContain('refine your search');
    });

    test('continue is disabled below two sources and goes to page 2 when enabled', () => {
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
        );
        const page = createCardsPage();
        const actions = makeActions();

        // One source: disabled with an explanatory title; singular count.
        page.render(container, makeSnapshot([a]), actions);
        let continueButton = findOne(container, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(true);
        expect(continueButton.title).toContain('2 source cards to continue');
        expect(container.textContent).toContain('1 source card');
        continueButton.click();
        expect(actions.goToPage).not.toHaveBeenCalled();

        // Two sources: enabled and navigates to Prompt & Settings (page 2).
        page.render(container, makeSnapshot([a, b]), actions);
        continueButton = findOne(container, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        expect(container.textContent).toContain('2 source cards');
        continueButton.click();
        expect(actions.goToPage).toHaveBeenCalledTimes(1);
        expect(actions.goToPage).toHaveBeenCalledWith(2);
    });

    test('re-rendering replaces the DOM without duplicating or throwing', () => {
        const a = makeSource();
        const b = makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });
        const c = makeSource({ key: 'c.png', name: 'Carol', avatar: 'c.png', fields: { name: 'Carol' } });
        mockCharacters.push(
            makeCharacter(),
            makeCharacter({ name: 'Bob', avatar: 'b.png' }),
            makeCharacter({ name: 'Carol', avatar: 'c.png' }),
        );
        const page = createCardsPage();
        const actions = makeActions();

        expect(() => {
            page.render(container, makeSnapshot([a, b]), actions);
            page.render(container, makeSnapshot([a, b]), actions);
        }).not.toThrow();
        expect(container.children).toHaveLength(1);
        expect(findAll(container, hasClass('bc-task-card'))).toHaveLength(2);

        // A notify with an updated snapshot swaps the content in place.
        page.render(container, makeSnapshot([a, b, c]), actions);
        expect(container.children).toHaveLength(1);
        expect(findAll(container, hasClass('bc-task-card'))).toHaveLength(3);

        page.dispose();
        expect(() => page.render(container, makeSnapshot([a, b]), actions)).not.toThrow();
    });

    // ------------------------------------------------------------------
    // Per-card notes (collapsible "Notes for generation" editor)
    // ------------------------------------------------------------------

    describe('per-card notes', () => {
        const a = () => makeSource();
        const b = () => makeSource({ key: 'b.png', name: 'Bob', avatar: 'b.png', fields: { name: 'Bob' } });

        beforeEach(() => {
            mockCharacters.push(
                makeCharacter(),
                makeCharacter({ name: 'Bob', avatar: 'b.png' }),
            );
        });

        test('renders the notes editor collapsed by default', () => {
            const { root } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            const section = findOne(card, hasClass('bc-task-card-notes'));
            expect(section).not.toBe(null);
            expect(section.classList.contains('expanded')).toBe(false);

            const toggle = findOne(card, hasAriaLabel('Notes for Alice'));
            expect(toggle).not.toBe(null);
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(toggle.textContent).toContain('Notes for generation');

            const body = findOne(card, hasClass('bc-task-card-notes-body'));
            expect(body.hidden).toBe(true);

            // The draft-keyed textarea is built even while collapsed.
            const textarea = findOne(card, hasClass('bc-task-card-notes-textarea'));
            expect(textarea.rows).toBe(3);
            expect(textarea.getAttribute('data-field-key')).toBe('note:a.png');
            expect(textarea.value).toBe('');

            // Empty note: no filled-dot badge.
            expect(findOne(card, hasClass('bc-task-card-notes-badge')).hidden).toBe(true);
        });

        test('snapshot note text appears in the textarea when expanded', () => {
            const { root } = renderCardsPage([a(), b()], makeActions(), { 'a.png': 'Loves earl grey.' });

            const card = cardFor(root, 'a.png');
            findOne(card, hasAriaLabel('Notes for Alice')).click();

            expect(findOne(card, hasClass('bc-task-card-notes-body')).hidden).toBe(false);
            expect(findOne(card, hasClass('bc-task-card-notes-textarea')).value).toBe('Loves earl grey.');
        });

        test('filled-note badge shows while collapsed only when the note is non-empty', () => {
            const { root } = renderCardsPage(
                [a(), b(), makeSource({ key: 'c.png', name: 'Carol', avatar: 'c.png', fields: { name: 'Carol' } })],
                makeActions(),
                { 'a.png': 'Has a note.', 'b.png': '   ' },
            );

            // Non-empty note: badge visible, editor still collapsed.
            const cardA = cardFor(root, 'a.png');
            expect(findOne(cardA, hasClass('bc-task-card-notes-badge')).hidden).toBe(false);
            expect(findOne(cardA, hasClass('bc-task-card-notes-body')).hidden).toBe(true);

            // Whitespace-only and absent notes count as empty: badge hidden.
            expect(findOne(cardFor(root, 'b.png'), hasClass('bc-task-card-notes-badge')).hidden).toBe(true);
            expect(findOne(cardFor(root, 'c.png'), hasClass('bc-task-card-notes-badge')).hidden).toBe(true);
        });

        test('chevron toggles expansion; the ephemeral collapse state survives re-renders', () => {
            const { page, root, actions } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            const toggle = findOne(card, hasAriaLabel('Notes for Alice'));

            toggle.click();
            expect(findOne(card, hasClass('bc-task-card-notes')).classList.contains('expanded')).toBe(true);
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            expect(findOne(card, hasClass('bc-task-card-notes-body')).hidden).toBe(false);

            toggle.click();
            expect(findOne(card, hasClass('bc-task-card-notes')).classList.contains('expanded')).toBe(false);
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            expect(findOne(card, hasClass('bc-task-card-notes-body')).hidden).toBe(true);

            // Expand again, then re-render from a fresh snapshot: the
            // closure state keeps Alice expanded and Bob collapsed.
            toggle.click();
            page.render(container, makeSnapshot([a(), b()]), actions);
            const rebuiltA = cardFor(container, 'a.png');
            expect(findOne(rebuiltA, hasClass('bc-task-card-notes')).classList.contains('expanded')).toBe(true);
            expect(findOne(rebuiltA, hasClass('bc-task-card-notes-body')).hidden).toBe(false);
            expect(findOne(rebuiltA, hasAriaLabel('Notes for Alice')).getAttribute('aria-expanded')).toBe('true');
            const rebuiltB = cardFor(container, 'b.png');
            expect(findOne(rebuiltB, hasClass('bc-task-card-notes')).classList.contains('expanded')).toBe(false);
            expect(findOne(rebuiltB, hasClass('bc-task-card-notes-body')).hidden).toBe(true);

            // Toggling never touches the server.
            expect(actions.update).not.toHaveBeenCalled();
        });

        test('input updates the draft without patching; the badge follows the draft immediately', () => {
            const { root, actions } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            findOne(card, hasAriaLabel('Notes for Alice')).click();
            const textarea = findOne(card, hasClass('bc-task-card-notes-textarea'));
            const badge = findOne(card, hasClass('bc-task-card-notes-badge'));
            expect(badge.hidden).toBe(true);

            textarea.value = 'Uncommitted thought';
            textarea.fire('input');

            expect(actions.update).not.toHaveBeenCalled();
            expect(badge.hidden).toBe(false);

            // Clearing the text hides the badge again, still without a patch.
            textarea.value = '';
            textarea.fire('input');
            expect(badge.hidden).toBe(true);
            expect(actions.update).not.toHaveBeenCalled();
        });

        test('change commits a sparse sourceNotes patch for exactly the one card', async () => {
            const { page, root, actions } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            findOne(card, hasAriaLabel('Notes for Alice')).click();
            const textarea = findOne(card, hasClass('bc-task-card-notes-textarea'));

            textarea.value = 'Keep her sarcastic.';
            textarea.fire('input');
            textarea.fire('change');

            expect(actions.update).toHaveBeenCalledTimes(1);
            expect(actions.update).toHaveBeenCalledWith({ sourceNotes: { 'a.png': 'Keep her sarcastic.' } });

            // After the patch resolves the draft clears, so a re-render
            // shows the (now stored) snapshot value rather than a stale draft.
            await flush();
            page.render(container, makeSnapshot([a(), b()], { 'a.png': 'Keep her sarcastic.' }), actions);
            expect(findOne(cardFor(container, 'a.png'), hasClass('bc-task-card-notes-textarea')).value).toBe('Keep her sarcastic.');
        });

        test('a snapshot refresh while the textarea is focused does not clobber the focused value', () => {
            const { page, root, actions } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            findOne(card, hasAriaLabel('Notes for Alice')).click();
            const textarea = findOne(card, hasClass('bc-task-card-notes-textarea'));
            textarea.focus();
            textarea.value = 'Uncommitted draft';
            textarea.fire('input');

            // State-driven re-render; the server snapshot still holds the
            // old (empty) note, which must NOT replace the in-progress text.
            page.render(container, makeSnapshot([a(), b()], { 'a.png': '' }), actions);

            const rebuilt = findOne(cardFor(container, 'a.png'), hasClass('bc-task-card-notes-textarea'));
            expect(rebuilt).not.toBe(null);
            expect(rebuilt.value).toBe('Uncommitted draft');
            // Focus is restored to the rebuilt textarea.
            expect(fakeDocument.activeElement).toBe(rebuilt);
            expect(actions.update).not.toHaveBeenCalled();
        });

        test('hint line is present in the notes body', () => {
            const { root } = renderCardsPage([a(), b()]);

            const card = cardFor(root, 'a.png');
            findOne(card, hasAriaLabel('Notes for Alice')).click();

            const hint = findOne(card, hasClass('bc-task-field-hint'));
            expect(hint).not.toBe(null);
            expect(hint.textContent).toBe('Injected into this card\'s Transform 1 prompt.');
        });
    });
});
