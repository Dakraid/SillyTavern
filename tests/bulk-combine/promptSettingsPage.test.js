'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for
 * `public/scripts/bulk-combine/wizard/pages/promptSettingsPage.js`.
 *
 * `extensions.js` (connection profiles), `openai.js` (chat completion
 * presets), and `slash-commands.js` (`CONNECT_API_MAP`) are mocked; the
 * real `resolveCompletionSettings` service runs on top of those mocks. The
 * prompt-preset feature runs the REAL `promptPresets` service on top of
 * mocked `script.js` (`saveSettingsDebounced`), `power-user.js`
 * (`power_user`), `popup.js` (`callGenericPopup`), and `utils.js`
 * (`escapeHtml`). `components/StructureBuilder.js` is mocked with a
 * minimal `{element, setStructure, getValue, dispose}` fake — page-level
 * tests only assert the wiring. The Node test environment has no DOM, so a minimal fake
 * `document`/element tree backs the page (the implementation uses plain
 * DOM APIs only — no jQuery, no HTML parsing).
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

/** @type {object} Mutable fixture backing the mocked `extension_settings` export. */
const mockExtensionSettings = { connectionManager: { profiles: [] } };
/** @type {Record<string, number>} Mutable fixture backing `openai_setting_names`. */
const mockPresetNames = {};
/** @type {object[]} Mutable fixture backing `openai_settings`. */
const mockPresets = [];
/** @type {object} Mutable fixture backing the mocked `power_user` export. */
const mockPowerUser = {};
/** @type {object} Mock backing the `callGenericPopup` export. */
const mockCallGenericPopup = jest.fn();
/** @type {object[]} Builder instances created through the mocked StructureBuilder module (reset per test). */
const mockBuilders = [];

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: mockExtensionSettings,
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: mockPresetNames,
    openai_settings: mockPresets,
    proxies: [],
}));

jest.unstable_mockModule('../../public/scripts/slash-commands.js', () => ({
    CONNECT_API_MAP: {
        openai: { selected: 'openai', source: 'openai' },
        oai: { selected: 'openai', source: 'openai' },
        google: { selected: 'openai', source: 'makersuite' },
        makersuite: { selected: 'openai', source: 'makersuite' },
        claude: { selected: 'openai', source: 'claude' },
        textgenerationwebui: { selected: 'textgenerationwebui', source: 'textgenerationwebui' },
    },
}));

jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: jest.fn(),
}));

jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: mockPowerUser,
}));

jest.unstable_mockModule('../../public/scripts/popup.js', () => ({
    callGenericPopup: mockCallGenericPopup,
    POPUP_TYPE: { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 },
    POPUP_RESULT: { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null },
}));

jest.unstable_mockModule('../../public/scripts/utils.js', () => ({
    escapeHtml: (value) => String(value ?? ''),
}));

jest.unstable_mockModule('../../public/scripts/bulk-combine/components/StructureBuilder.js', () => ({
    /**
     * Minimal component fake implementing the
     * `{element, setStructure, getValue, dispose}` contract with plain
     * data; creation options (including `onCommit`) stay reachable.
     *
     * @param {object} [options] Component options (`{ structure, onCommit }`).
     * @returns {object} Fake builder instance.
     */
    createStructureBuilder: (options = {}) => {
        let current = {
            format: typeof options.structure?.format === 'string' ? options.structure.format : 'xml',
            template: Array.isArray(options.structure?.template) ? options.structure.template : [],
        };
        const element = fakeDocument.createElement('div');
        element.className = 'bc-task-sb-mock';
        const builder = {
            element,
            options,
            setStructure: jest.fn((next = {}) => {
                current = {
                    format: typeof next.format === 'string' ? next.format : current.format,
                    template: Array.isArray(next.template) ? next.template : current.template,
                };
            }),
            getValue: jest.fn(() => JSON.parse(JSON.stringify(current))),
            dispose: jest.fn(),
        };
        mockBuilders.push(builder);
        return builder;
    },
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
        this.checked = false;
        this.disabled = false;
        this.hidden = false;
        this.open = false;
        this.tabIndex = 0;
        this.title = '';
        this.type = '';
        this.id = '';
        this.src = '';
        this.alt = '';
        this.placeholder = '';
        this.name = '';
        this.rows = 0;
        this.selectionStart = null;
        this.selectionEnd = null;
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

    /**
     * Records a text selection (test stand-in for the real API).
     *
     * @param {number} start Selection start.
     * @param {number} end Selection end.
     */
    setSelectionRange(start, end) {
        this.selectionStart = start;
        this.selectionEnd = end;
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

/**
 * @param {string} key Expected `data-field-key` value.
 * @returns {(element: object) => boolean} Matcher.
 */
function hasFieldKey(key) {
    return (element) => typeof element.getAttribute === 'function' && element.getAttribute('data-field-key') === key;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Assistant record fixture.
 */
function makeAssistant(overrides = {}) {
    return { request: '', proposal: '', diff: '', applied: false, error: '', ...overrides };
}

/**
 * @param {string} [text] Prompt text.
 * @param {object} [assistant] Assistant overrides.
 * @returns {object} Prompt record fixture.
 */
function makePrompt(text = '', assistant = {}) {
    return { text, assistant: makeAssistant(assistant) };
}

/**
 * @param {object} [overrides] Shallow-merged root-node overrides.
 * @returns {object[]} Single-root template fixture (mirrors `templateModel` nodes).
 */
function makeTemplate(overrides = {}) {
    return [{
        id: 'structured-0',
        name: 'character',
        hint: '',
        attributes: [{ name: 'name', values: '' }],
        maxLength: null,
        children: [],
        ...overrides,
    }];
}

/**
 * @param {object} [options] Fixture options.
 * @param {object} [options.settings] Settings overrides.
 * @param {object} [options.prompts] Prompt overrides (whole records).
 * @param {string} [options.status] Task lifecycle status (`draft` | `completed`).
 * @param {object} [options.structure] Structure override (`{ format, template }`).
 * @param {object} [options.passes] Pass records override (`{ transform1, … }`).
 * @returns {object} State snapshot payload (mirrors `TaskWizardState#getSnapshot`).
 */
function makeSnapshot({ settings = {}, prompts = {}, status = 'draft', structure, passes } = {}) {
    return {
        task: {
            id: 'task-1',
            name: 'Task',
            status,
            sources: [],
            structure: structure ?? { format: 'xml', template: makeTemplate() },
            settings: {
                concurrency: 2,
                connectionProfile: null,
                preset: null,
                totalContextTokens: null,
                outputTokens: null,
                destination: 'card',
                xmlMinify: false,
                postProcessingEnabled: false,
                postProcessingMode: 'append',
                secondPassEnabled: false,
                secondPassMode: 'individual',
                ...settings,
            },
            prompts: {
                main: makePrompt('Combine these cards into one.'),
                secondPass: makePrompt(''),
                summary: makePrompt(''),
                post: makePrompt(''),
                ...prompts,
            },
            passes: passes ?? {},
        },
        derivedStaleness: {},
        pageStates: [],
        currentPage: 2,
        furthestPage: 2,
        conflict: false,
        syncState: 'saved',
    };
}

/** @returns {object} Actions facade mock (full controller surface). */
function makeActions() {
    return {
        update: jest.fn(async () => {}),
        refresh: jest.fn(async () => {}),
        goToPage: jest.fn(),
        navigate: jest.fn(),
        runPass: jest.fn(async () => {}),
        resumePass: jest.fn(async () => {}),
        cancel: jest.fn(async () => {}),
        runPostProcess: jest.fn(async () => {}),
        runPromptAssist: jest.fn(async () => {}),
        getReview: jest.fn(async () => ({})),
    };
}

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Chat Completion preset body fixture.
 */
function makePreset(overrides = {}) {
    return {
        chat_completion_source: 'openai',
        openai_model: 'gpt-4o-mini',
        google_model: 'gemini-2.0-flash',
        claude_model: 'claude-3-5-sonnet',
        openai_max_context: 128000,
        openai_max_tokens: 4096,
        temperature: 0.7,
        frequency_penalty: 0,
        presence_penalty: 0,
        top_p: 1,
        top_k: 0,
        ...overrides,
    };
}

let createPromptSettingsPage;
let container;
/** @type {object} Popup result enum from the mocked `popup.js`. */
let POPUP_RESULT;
/** @type {object} Popup type enum from the mocked `popup.js`. */
let POPUP_TYPE;

/**
 * Creates a page, renders it, and returns the pieces under test.
 *
 * @param {object} snapshot State snapshot.
 * @param {object} [actions] Actions facade mock.
 * @returns {{page: object, heading: Element, root: Element, actions: object}} Rendered page pieces.
 */
function renderPage(snapshot, actions = makeActions()) {
    const page = createPromptSettingsPage();
    const heading = page.render(container, snapshot, actions);
    return { page, heading, root: container.children[0], actions };
}

beforeAll(async () => {
    ({ createPromptSettingsPage } = await import('../../public/scripts/bulk-combine/wizard/pages/promptSettingsPage.js'));
    ({ POPUP_RESULT, POPUP_TYPE } = await import('../../public/scripts/popup.js'));
});

beforeEach(() => {
    fakeDocument.activeElement = null;
    global.document = fakeDocument;
    container = fakeDocument.createElement('div');

    mockExtensionSettings.connectionManager.profiles = [
        { id: 'p1', name: 'GPT Profile', api: 'openai', model: 'gpt-4o', 'secret-id': 'ref-1', 'api-url': '' },
        { id: 'p2', name: 'Claude Profile', api: 'claude', model: 'claude-3-5-sonnet', 'secret-id': 'ref-2', 'api-url': '' },
        { id: 'p3', name: 'Local GGUF', api: 'textgenerationwebui', model: 'local-llama', 'secret-id': '', 'api-url': '' },
    ];
    for (const key of Object.keys(mockPresetNames)) {
        delete mockPresetNames[key];
    }
    mockPresetNames.Fast = 0;
    mockPresetNames.Creative = 1;
    mockPresets.splice(0, mockPresets.length);
    mockPresets.push(makePreset(), makePreset({ openai_model: 'gpt-4o' }));

    for (const key of Object.keys(mockPowerUser)) {
        delete mockPowerUser[key];
    }
    mockCallGenericPopup.mockReset();
    mockBuilders.length = 0;
    delete global.toastr;
});

afterEach(() => {
    delete global.document;
    delete global.diff_match_patch;
    delete global.toastr;
    jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('promptSettingsPage', () => {
    test('exposes the registry identity and renders heading, workspaces, and the snapshot prompt', () => {
        const page = createPromptSettingsPage();
        expect(page.key).toBe('prompt');
        expect(page.title).toBe('Prompt & Settings');

        const actions = makeActions();
        const heading = page.render(container, makeSnapshot(), actions);
        const root = container.children[0];

        expect(heading.tagName).toBe('H2');
        expect(heading.textContent).toBe('Prompt & Settings');
        expect(heading.tabIndex).toBe(-1);

        const mainArea = findOne(root, hasFieldKey('prompt:main:text'));
        expect(mainArea.tagName).toBe('TEXTAREA');
        expect(mainArea.value).toBe('Combine these cards into one.');

        const requestArea = findOne(root, hasFieldKey('assistant:main:request'));
        expect(requestArea.tagName).toBe('TEXTAREA');
        expect(requestArea.value).toBe('');

        // Both workspaces render side by side; no proposal/status without data.
        expect(findOne(root, hasClass('bc-task-workspace-main'))).not.toBe(null);
        expect(findOne(root, hasClass('bc-task-workspace-assist'))).not.toBe(null);
        expect(findOne(root, hasClass('bc-task-proposal'))).toBe(null);
        expect(findOne(root, hasClass('bc-task-assist-status'))).toBe(null);
        expect(actions.update).not.toHaveBeenCalled();
        expect(actions.runPromptAssist).not.toHaveBeenCalled();
    });

    test('Save prompt commits the draft as a sparse prompts patch; button gates on unsaved changes', () => {
        const { root, actions } = renderPage(makeSnapshot());

        const saveButton = findOne(root, hasClass('bc-task-save-prompt'));
        expect(saveButton.disabled).toBe(true);
        saveButton.click();
        expect(actions.update).not.toHaveBeenCalled();

        const mainArea = findOne(root, hasFieldKey('prompt:main:text'));
        mainArea.value = 'A brand new combine prompt.';
        mainArea.fire('input');
        expect(saveButton.disabled).toBe(false);

        saveButton.click();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ prompts: { main: { text: 'A brand new combine prompt.' } } });
    });

    test('Suggest starts a background assist with the request and resolved completionSettings', () => {
        const { actions } = renderPage(makeSnapshot());

        const requestArea = findOne(container, hasFieldKey('assistant:main:request'));
        requestArea.value = 'Make it spicier';
        requestArea.fire('input');

        findOne(container, hasClass('bc-task-suggest')).click();
        expect(actions.runPromptAssist).toHaveBeenCalledTimes(1);
        expect(actions.runPromptAssist).toHaveBeenCalledWith('main', {
            request: 'Make it spicier',
            // No profile/preset selected in the fixture → nothing resolvable.
            completionSettings: { stream: false },
        });
        // No task PATCH for the suggest itself.
        expect(actions.update).not.toHaveBeenCalled();

        // The click re-rendered into the in-flight state.
        expect(container.textContent).toContain('Generating a proposal');
        const suggestButton = findOne(container, hasClass('bc-task-suggest'));
        expect(suggestButton.disabled).toBe(true);
        suggestButton.click();
        expect(actions.runPromptAssist).toHaveBeenCalledTimes(1);

        // The request draft survives the in-flight re-render.
        expect(findOne(container, hasFieldKey('assistant:main:request')).value).toBe('Make it spicier');
    });

    test('the in-flight state clears and the proposal diff renders once the proposal lands', () => {
        global.diff_match_patch = class {
            diff_main() {
                return [[0, 'Combine '], [-1, 'these'], [1, 'both'], [0, ' cards into one.']];
            }

            diff_cleanupSemantic() {}
        };

        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);

        const requestArea = findOne(container, hasFieldKey('assistant:main:request'));
        requestArea.value = 'Make it spicier';
        requestArea.fire('input');
        findOne(container, hasClass('bc-task-suggest')).click();
        expect(container.textContent).toContain('Generating a proposal');

        // Snapshot notify: the proposal arrived (background run finished).
        const assistant = makeAssistant({ request: 'Make it spicier', proposal: 'Combine both cards into one.' });
        page.render(container, makeSnapshot({ prompts: { main: makePrompt('Combine these cards into one.', assistant) } }), actions);

        expect(container.textContent).not.toContain('Generating a proposal');
        const proposal = findOne(container, hasClass('bc-task-proposal'));
        expect(proposal).not.toBe(null);
        expect(findOne(proposal, hasClass('bc-task-diff-ins')).textContent).toBe('both');
        expect(findOne(proposal, hasClass('bc-task-diff-del')).textContent).toBe('these');
        expect(findOne(container, hasClass('bc-task-suggest')).disabled).toBe(false);
    });

    test('Apply replaces the prompt and marks the assistant record applied', () => {
        const assistant = makeAssistant({ request: 'Make it spicier', proposal: 'Combine both cards into one.' });
        const { actions } = renderPage(makeSnapshot({
            prompts: { main: makePrompt('Combine these cards into one.', assistant) },
        }));

        findOne(container, hasClass('bc-task-apply-proposal')).click();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({
            prompts: {
                main: {
                    text: 'Combine both cards into one.',
                    assistant: { ...assistant, applied: true },
                },
            },
        });
    });

    test('Dismiss resets the whole assistant record', () => {
        const assistant = makeAssistant({ request: 'Make it spicier', proposal: 'Combine both cards into one.', diff: 'cached' });
        const { actions } = renderPage(makeSnapshot({
            prompts: { main: makePrompt('Combine these cards into one.', assistant) },
        }));

        findOne(container, hasClass('bc-task-dismiss-proposal')).click();
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({
            prompts: {
                main: {
                    assistant: { request: '', proposal: '', diff: '', applied: false, error: '' },
                },
            },
        });
    });

    test('an applied proposal is not offered again', () => {
        const assistant = makeAssistant({ request: 'r', proposal: 'Already applied.', applied: true });
        renderPage(makeSnapshot({ prompts: { main: makePrompt('Already applied.', assistant) } }));
        expect(findOne(container, hasClass('bc-task-proposal'))).toBe(null);
    });

    test('the diff falls back to plain proposal text when diff_match_patch is unavailable', () => {
        const assistant = makeAssistant({ request: 'r', proposal: 'Plain proposal text.' });
        renderPage(makeSnapshot({ prompts: { main: makePrompt('Original.', assistant) } }));

        const diff = findOne(container, hasClass('bc-task-proposal-diff'));
        expect(diff.textContent).toBe('Plain proposal text.');
        expect(findAll(diff, (element) => element.tagName === 'INS')).toHaveLength(0);
        expect(findAll(diff, (element) => element.tagName === 'DEL')).toHaveLength(0);
    });

    test('assistant errors render in an alert block', () => {
        const assistant = makeAssistant({ request: 'r', error: 'Assist exploded.' });
        renderPage(makeSnapshot({ prompts: { main: makePrompt('Original.', assistant) } }));

        const error = findOne(container, hasClass('bc-task-assist-error'));
        expect(error).not.toBe(null);
        expect(error.getAttribute('role')).toBe('alert');
        expect(error.textContent).toBe('Assist exploded.');
        expect(findOne(container, hasClass('bc-task-proposal'))).toBe(null);
    });

    test('connection selects list CC profiles + presets and PATCH sparse settings', () => {
        const { actions } = renderPage(makeSnapshot());

        // The text-generation profile is filtered out of the options.
        const profileSelect = findOne(container, hasAriaLabel('Connection profile'));
        const optionLabels = profileSelect.children.map((option) => option.textContent);
        expect(optionLabels).toEqual(['No profile (use a preset)', 'GPT Profile', 'Claude Profile']);

        profileSelect.value = 'p1';
        profileSelect.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { connectionProfile: 'p1' } });

        const presetSelect = findOne(container, hasAriaLabel('Chat completion preset'));
        presetSelect.value = 'Fast';
        presetSelect.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(2);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { preset: 'Fast' } });

        // Clearing the profile stores null (not an empty string).
        profileSelect.value = '';
        profileSelect.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(3);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { connectionProfile: null } });
    });

    test('the resolved readout reflects the selected profile', () => {
        renderPage(makeSnapshot({ settings: { connectionProfile: 'p1' } }));
        const readout = findOne(container, hasClass('bc-task-resolved-readout'));
        expect(readout.textContent).toContain('Model: gpt-4o');
        expect(readout.textContent).toContain('Source: openai');
    });

    test('window inputs PATCH positive integers or null (inherit)', () => {
        const { actions } = renderPage(makeSnapshot());

        const contextInput = findOne(container, hasAriaLabel('Total context tokens'));
        contextInput.value = '64000';
        contextInput.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { totalContextTokens: 64000 } });

        contextInput.value = '';
        contextInput.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { totalContextTokens: null } });

        const outputInput = findOne(container, hasAriaLabel('Output tokens'));
        outputInput.value = '0';
        outputInput.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { outputTokens: null } });

        outputInput.value = '2048';
        outputInput.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { outputTokens: 2048 } });
        expect(actions.update).toHaveBeenCalledTimes(4);
    });

    test('processing, output, and passes controls PATCH sparse settings', () => {
        const { actions } = renderPage(makeSnapshot());

        const concurrency = findOne(container, hasAriaLabel('Concurrency'));
        concurrency.value = '3';
        concurrency.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { concurrency: 3 } });

        const destination = findOne(container, hasAriaLabel('Output destination'));
        destination.value = 'lorebook';
        destination.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { destination: 'lorebook' } });

        const secondPass = findOne(container, hasAriaLabel('Second pass'));
        secondPass.checked = true;
        secondPass.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { secondPassEnabled: true } });

        const postMode = findOne(container, hasAriaLabel('Post-processing mode'));
        postMode.value = 'prepend';
        postMode.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { postProcessingMode: 'prepend' } });

        expect(actions.update).toHaveBeenCalledTimes(4);
    });

    // ------------------------------------------------------------------
    // Captured fields (Processing group)
    // ------------------------------------------------------------------

    test('captured fields render from settings.fields; legacy absent means all four checked', () => {
        // Legacy task (no fields key): every optional field checked.
        const legacy = renderPage(makeSnapshot());
        for (const label of ['Personality', 'Scenario', 'First message', 'Example messages']) {
            const box = findOne(legacy.root, hasAriaLabel(label));
            expect(box).not.toBe(null);
            expect(box.type).toBe('checkbox');
            expect(box.checked).toBe(true);
            expect(box.disabled).toBe(false);
        }
        expect(legacy.root.textContent).toContain('Name and description are always captured');

        // A stored subset checks only those, in the task default's clothes.
        const subset = renderPage(makeSnapshot({ settings: { fields: ['personality', 'first_mes'] } }));
        expect(findOne(subset.root, hasAriaLabel('Personality')).checked).toBe(true);
        expect(findOne(subset.root, hasAriaLabel('Scenario')).checked).toBe(false);
        expect(findOne(subset.root, hasAriaLabel('First message')).checked).toBe(true);
        expect(findOne(subset.root, hasAriaLabel('Example messages')).checked).toBe(false);

        // Junk keys in the stored array are ignored.
        const junk = renderPage(makeSnapshot({ settings: { fields: ['scenario', 'bogus'] } }));
        expect(findOne(junk.root, hasAriaLabel('Scenario')).checked).toBe(true);
        expect(findOne(junk.root, hasAriaLabel('Personality')).checked).toBe(false);
    });

    test('captured fields PATCH the checked optional keys in canonical order', () => {
        const { actions } = renderPage(makeSnapshot());

        // Uncheck Scenario: the other three remain, in canonical order.
        const scenario = findOne(container, hasAriaLabel('Scenario'));
        scenario.checked = false;
        scenario.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { fields: ['personality', 'first_mes', 'mes_example'] } });

        // Re-checking restores Scenario to its canonical position (the
        // selection accumulates until the snapshot round-trip rebuilds).
        scenario.checked = true;
        scenario.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(2);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { fields: ['personality', 'scenario', 'first_mes', 'mes_example'] } });

        // Unchecking everything patches an explicit empty selection.
        for (const label of ['Personality', 'Scenario', 'First message', 'Example messages']) {
            const box = findOne(container, hasAriaLabel(label));
            box.checked = false;
            box.fire('change');
        }
        expect(actions.update).toHaveBeenCalledTimes(6);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { fields: [] } });
    });

    // ------------------------------------------------------------------
    // Refusal retries (Processing group)
    // ------------------------------------------------------------------

    test('refusal retries renders the default 3, clamps to 0–5 integers, and ignores junk', () => {
        const { root, actions } = renderPage(makeSnapshot());

        const retries = findOne(root, hasAriaLabel('Refusal retries'));
        expect(retries).not.toBe(null);
        expect(retries.type).toBe('number');
        expect(retries.getAttribute('min')).toBe('0');
        expect(retries.getAttribute('max')).toBe('5');
        expect(retries.getAttribute('step')).toBe('1');
        // Absent on legacy tasks → default 3.
        expect(retries.value).toBe('3');
        expect(root.textContent).toContain('model refusals');
        expect(root.textContent).toContain('0 disables');

        retries.value = '4';
        retries.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { refusalRetries: 4 } });

        // Out-of-range commits clamp into 0–5; fractions truncate.
        retries.value = '9';
        retries.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { refusalRetries: 5 } });
        retries.value = '-2';
        retries.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { refusalRetries: 0 } });
        retries.value = '2.9';
        retries.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { refusalRetries: 2 } });

        // Blank/non-numeric input never PATCHes.
        retries.value = '';
        retries.fire('change');
        retries.value = 'abc';
        retries.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(4);

        // A stored value renders as-is.
        const stored = renderPage(makeSnapshot({ settings: { refusalRetries: 5 } }));
        expect(findOne(stored.root, hasAriaLabel('Refusal retries')).value).toBe('5');
    });

    test('the processing mode radios are gone; concurrency is always enabled; pass rows hide unless enabled; summary needs lorebook', () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();

        // Default snapshot: nothing enabled, card destination.
        page.render(container, makeSnapshot(), actions);
        expect(findOne(container, hasAriaLabel('Individual'))).toBe(null);
        expect(findOne(container, hasAriaLabel('Combined'))).toBe(null);
        expect(findAll(container, (element) => element.type === 'radio')).toHaveLength(0);
        expect(findOne(container, hasAriaLabel('Concurrency')).disabled).toBe(false);
        expect(findOne(container, hasAriaLabel('Concurrency')).value).toBe('2');
        expect(findOne(container, hasAriaLabel('Second-pass mode')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasFieldKey('prompt:secondPass:text')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasFieldKey('prompt:post:text')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasAriaLabel('Post-processing mode')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasFieldKey('prompt:summary:text')).parentElement.hidden).toBe(true);

        // Passes enabled + lorebook destination: concurrency STAYS enabled
        // (Transform 1 is always per-card) and the pass rows reveal.
        page.render(container, makeSnapshot({
            settings: {
                secondPassEnabled: true,
                secondPassMode: 'combined',
                postProcessingEnabled: true,
                destination: 'lorebook',
            },
        }), actions);
        expect(findOne(container, hasAriaLabel('Concurrency')).disabled).toBe(false);
        expect(findOne(container, hasAriaLabel('Second-pass mode')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:secondPass:text')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:post:text')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasAriaLabel('Post-processing mode')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:summary:text')).parentElement.hidden).toBe(false);
    });

    test('the second-pass mode select lists the pinned options and PATCHes secondPassMode', () => {
        const { actions } = renderPage(makeSnapshot({ settings: { secondPassEnabled: true } }));

        const select = findOne(container, hasAriaLabel('Second-pass mode'));
        expect(select.tagName).toBe('SELECT');
        expect(select.children.map((option) => option.value)).toEqual(['individual', 'combined']);
        expect(select.children[0].textContent).toContain('Per-card');
        expect(select.children[1].textContent).toContain('Full card');
        // Default resolution: absent/unknown values show individual.
        expect(select.value).toBe('individual');

        select.value = 'combined';
        select.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { secondPassMode: 'combined' } });

        // A stored combined mode renders selected.
        const combined = renderPage(makeSnapshot({ settings: { secondPassEnabled: true, secondPassMode: 'combined' } }));
        expect(findOne(combined.root, hasAriaLabel('Second-pass mode')).value).toBe('combined');
    });

    test('the post-processing mode select offers only Prepend/Append; legacy replace resolves to append', () => {
        const { root } = renderPage(makeSnapshot({ settings: { postProcessingEnabled: true } }));
        const select = findOne(root, hasAriaLabel('Post-processing mode'));
        expect(select.children.map((option) => option.value)).toEqual(['prepend', 'append']);
        // Fixture default.
        expect(select.value).toBe('append');

        // A legacy stored 'replace' normalizes to 'append' for display.
        const legacy = renderPage(makeSnapshot({ settings: { postProcessingEnabled: true, postProcessingMode: 'replace' } }));
        expect(findOne(legacy.root, hasAriaLabel('Post-processing mode')).value).toBe('append');

        // Unknown values fall back to append as well.
        const unknown = renderPage(makeSnapshot({ settings: { postProcessingEnabled: true, postProcessingMode: 'weird' } }));
        expect(findOne(unknown.root, hasAriaLabel('Post-processing mode')).value).toBe('append');
    });

    // ------------------------------------------------------------------
    // Output format & structure template
    // ------------------------------------------------------------------

    /**
     * @param {object} root Root fake element.
     * @returns {object|null} The mounted mock builder element, or null.
     */
    function findBuilderElement(root) {
        return findOne(root, hasClass('bc-task-sb-mock'));
    }

    test('the XML tagging checkbox is gone; the output format select lists the four formats with the current one selected', () => {
        const { root } = renderPage(makeSnapshot());

        expect(findOne(root, hasAriaLabel('XML tagging'))).toBe(null);

        const formatSelect = findOne(root, hasAriaLabel('Output format'));
        expect(formatSelect.tagName).toBe('SELECT');
        expect(formatSelect.children.map((option) => option.value)).toEqual(['xml', 'json', 'toon', 'none']);
        expect(formatSelect.children.map((option) => option.textContent)).toEqual(['XML', 'JSON', 'TOON', 'None (freeform)']);
        expect(formatSelect.value).toBe('xml');

        // A stored format renders selected.
        const toon = renderPage(makeSnapshot({ structure: { format: 'toon', template: makeTemplate() } }));
        expect(findOne(toon.root, hasAriaLabel('Output format')).value).toBe('toon');
    });

    test('changing the output format PATCHes { structure: { format } } exactly', () => {
        const { actions } = renderPage(makeSnapshot());

        const formatSelect = findOne(container, hasAriaLabel('Output format'));
        formatSelect.value = 'json';
        formatSelect.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ structure: { format: 'json' } });
    });

    test('the format stale-warning hint only shows when generated pass outputs exist', () => {
        // No pass has produced output yet → no warning.
        const clean = renderPage(makeSnapshot({
            passes: { transform1: { status: 'running', items: { 'a.png': { status: 'running' } } } },
        }));
        expect(findOne(clean.root, hasClass('bc-task-format-stale'))).toBe(null);

        // A succeeded pass item → the warning line renders under the select.
        const generated = renderPage(makeSnapshot({
            passes: {
                transform1: {
                    status: 'succeeded',
                    items: { 'a.png': { status: 'succeeded', output: 'AAA' }, 'b.png': { status: 'pending' } },
                },
            },
        }));
        const hint = findOne(generated.root, hasClass('bc-task-format-stale'));
        expect(hint).not.toBe(null);
        expect(hint.textContent).toBe('Changing the format marks all passes stale.');
        expect(hint.parentElement).toBe(findOne(generated.root, hasAriaLabel('Output format')).parentElement);
    });

    test('the Minify XML row is visible for xml and hidden for other formats; it still PATCHes xmlMinify', () => {
        const xml = renderPage(makeSnapshot());
        const minify = findOne(xml.root, hasAriaLabel('Minify XML'));
        expect(minify.parentElement.hidden).toBe(false);

        minify.checked = true;
        minify.fire('change');
        expect(xml.actions.update).toHaveBeenCalledTimes(1);
        expect(xml.actions.update).toHaveBeenLastCalledWith({ settings: { xmlMinify: true } });

        for (const format of ['json', 'toon', 'none']) {
            const page = renderPage(makeSnapshot({ structure: { format, template: makeTemplate() } }));
            expect(findOne(page.root, hasAriaLabel('Minify XML')).parentElement.hidden).toBe(true);
        }
    });

    test('the structure builder mounts once with the snapshot template and is kept across re-renders', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);

        expect(mockBuilders).toHaveLength(1);
        const builder = mockBuilders[0];
        expect(builder.options.structure).toEqual({ format: 'xml', template: makeTemplate() });
        expect(findBuilderElement(container)).toBe(builder.element);

        // State-driven re-render with identical structure: no new instance,
        // no setStructure, and the same element re-appends into the rebuilt DOM.
        page.render(container, makeSnapshot(), actions);
        expect(mockBuilders).toHaveLength(1);
        expect(builder.setStructure).not.toHaveBeenCalled();
        expect(findBuilderElement(container)).toBe(builder.element);
    });

    test('builder commits PATCH { structure: { template } } sparsely', () => {
        const { actions } = renderPage(makeSnapshot());
        const builder = mockBuilders[0];

        const nextTemplate = makeTemplate({ name: 'hero' });
        builder.options.onCommit(nextTemplate);
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ structure: { template: nextTemplate } });
    });

    test('format none swaps the builder canvas for the freeform hint; the tree is retained when switching back', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot({ structure: { format: 'none', template: makeTemplate() } }), actions);

        expect(mockBuilders).toHaveLength(1);
        const builder = mockBuilders[0];
        expect(findBuilderElement(container)).toBe(null);
        const hint = findOne(container, hasClass('bc-task-structure-freeform'));
        expect(hint).not.toBe(null);
        expect(hint.textContent).toBe('Freeform output — no structure enforced.');

        // Switch back to xml: the same instance returns to the DOM with the
        // same template (no reset to default).
        page.render(container, makeSnapshot(), actions);
        expect(mockBuilders).toHaveLength(1);
        expect(findBuilderElement(container)).toBe(builder.element);
        expect(builder.setStructure).toHaveBeenCalledTimes(1);
        expect(builder.setStructure).toHaveBeenCalledWith({ format: 'xml', template: makeTemplate() });
        expect(builder.getValue().template).toEqual(makeTemplate());
    });

    test('the builder absorbs a newer server-confirmed structure via setStructure', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);
        const builder = mockBuilders[0];
        expect(builder.setStructure).not.toHaveBeenCalled();

        const nextTemplate = makeTemplate({ name: 'hero', hint: 'new hint' });
        page.render(container, makeSnapshot({ structure: { format: 'xml', template: nextTemplate } }), actions);
        expect(builder.setStructure).toHaveBeenCalledTimes(1);
        expect(builder.setStructure).toHaveBeenCalledWith({ format: 'xml', template: nextTemplate });
        expect(builder.getValue().template).toEqual(nextTemplate);

        // The absorbed state sticks: re-rendering the same snapshot does not push it again.
        page.render(container, makeSnapshot({ structure: { format: 'xml', template: nextTemplate } }), actions);
        expect(builder.setStructure).toHaveBeenCalledTimes(1);
    });

    test('page dispose disposes the builder; a later render mounts a fresh one', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);
        const builder = mockBuilders[0];

        page.dispose();
        expect(builder.dispose).toHaveBeenCalledTimes(1);

        page.render(container, makeSnapshot(), actions);
        expect(mockBuilders).toHaveLength(2);
        expect(mockBuilders[1]).not.toBe(builder);
    });

    test('pass prompt textareas commit on change as sparse prompt patches', () => {
        const { actions } = renderPage(makeSnapshot({
            settings: { secondPassEnabled: true, destination: 'lorebook' },
        }));

        const secondPassArea = findOne(container, hasFieldKey('prompt:secondPass:text'));
        secondPassArea.value = 'Refine each card.';
        secondPassArea.fire('input');
        expect(actions.update).not.toHaveBeenCalled(); // input never PATCHes.
        secondPassArea.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenLastCalledWith({ prompts: { secondPass: { text: 'Refine each card.' } } });

        const summaryArea = findOne(container, hasFieldKey('prompt:summary:text'));
        summaryArea.value = 'Summarize everything.';
        summaryArea.fire('change');
        expect(actions.update).toHaveBeenCalledTimes(2);
        expect(actions.update).toHaveBeenLastCalledWith({ prompts: { summary: { text: 'Summarize everything.' } } });
    });

    test('a focused textarea keeps its draft, focus, and selection across re-renders', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);

        const mainArea = findOne(container, hasFieldKey('prompt:main:text'));
        mainArea.value = 'Combine these cards into one. TYPED';
        mainArea.fire('input');
        mainArea.focus();
        mainArea.setSelectionRange(38, 38);
        expect(fakeDocument.activeElement).toBe(mainArea);

        // State-driven re-render (e.g. an unrelated settings PATCH echo).
        page.render(container, makeSnapshot({ settings: { concurrency: 4 } }), actions);

        const rebuilt = findOne(container, hasFieldKey('prompt:main:text'));
        expect(rebuilt).not.toBe(mainArea); // the DOM was rebuilt…
        expect(rebuilt.value).toBe('Combine these cards into one. TYPED'); // …but the draft survived.
        expect(fakeDocument.activeElement).toBe(rebuilt);
        expect(rebuilt.selectionStart).toBe(38);
        expect(rebuilt.selectionEnd).toBe(38);
    });

    test('settings groups are native details; toggling persists across re-renders', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);

        const groups = findAll(container, (element) => element.tagName === 'DETAILS');
        expect(groups).toHaveLength(5);
        const titles = groups.map((group) => findOne(group, (element) => element.tagName === 'SUMMARY')?.textContent);
        expect(titles).toEqual(['Connection', 'Windows', 'Processing', 'Output / Lorebook', 'Optional Passes']);

        // Only Connection starts open; toggling Windows open survives a rebuild.
        expect(groups[0].open).toBe(true);
        expect(groups[1].open).toBe(false);
        groups[1].open = true;
        groups[1].fire('toggle');

        page.render(container, makeSnapshot(), actions);
        const rebuilt = findAll(container, (element) => element.tagName === 'DETAILS');
        expect(rebuilt[0].open).toBe(true);
        expect(rebuilt[1].open).toBe(true);
        expect(rebuilt[2].open).toBe(false);
    });

    test('re-rendering replaces the DOM without duplicating or throwing; dispose is safe', () => {
        const actions = makeActions();
        const page = createPromptSettingsPage();

        expect(() => {
            page.render(container, makeSnapshot(), actions);
            page.render(container, makeSnapshot({ settings: { secondPassMode: 'combined' } }), actions);
        }).not.toThrow();
        expect(container.children).toHaveLength(1);
        expect(findAll(container, hasFieldKey('prompt:main:text'))).toHaveLength(1);

        page.dispose();
        expect(() => page.render(container, makeSnapshot(), actions)).not.toThrow();
    });

    // ------------------------------------------------------------------
    // Prompt presets (new bulk_combine_task_prompt_presets store)
    // ------------------------------------------------------------------

    /** @type {string} `power_user` key holding the new preset store. */
    const STORE_KEY = 'bulk_combine_task_prompt_presets';
    /** @type {string} `power_user` key flagging the legacy migration as done. */
    const MIGRATED_KEY = 'bulk_combine_task_prompt_presets_migrated';

    /**
     * Seeds the new preset store directly (migration already done).
     *
     * @param {object} fields Field → preset list map.
     * @returns {void}
     */
    function seedPromptPresets(fields) {
        mockPowerUser[STORE_KEY] = { main: [], secondPass: [], summary: [], post: [], ...fields };
        mockPowerUser[MIGRATED_KEY] = true;
    }

    /**
     * Finds the preset row containing the select with the given aria-label.
     *
     * @param {object} root Root fake element.
     * @param {string} selectAriaLabel Select `aria-label`.
     * @returns {object|null} Preset row element, or null.
     */
    function findPresetRow(root, selectAriaLabel) {
        const select = findOne(root, hasAriaLabel(selectAriaLabel));
        return select?.parentElement ?? null;
    }

    /** @returns {Promise<void>} Flushes pending microtasks after an async click handler. */
    async function flushAsync() {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }

    test('renders a preset row per prompt field; Apply/Delete gate on a selection', () => {
        const { root } = renderPage(makeSnapshot({
            settings: { secondPassEnabled: true, postProcessingEnabled: true, destination: 'lorebook' },
        }));

        for (const ariaLabel of ['combine prompt presets', 'second-pass instructions presets', 'post-processing prompt presets', 'summary prompt presets']) {
            const select = findOne(root, hasAriaLabel(ariaLabel));
            expect(select.tagName).toBe('SELECT');
            expect(select.children.map((option) => option.textContent)).toEqual(['— Load preset —']);
            const row = select.parentElement;
            expect(findOne(row, hasClass('bc-task-preset-apply')).disabled).toBe(true);
            expect(findOne(row, hasClass('bc-task-preset-save')).disabled).toBe(false);
            expect(findOne(row, hasClass('bc-task-preset-delete')).disabled).toBe(true);
        }

        // The first store access ran the (no-op) legacy migration lazily.
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
    });

    test('legacy presets migrate into the row options on first render and the legacy keys are deleted', () => {
        mockPowerUser.group_card_combine_prompt_presets = [{ name: 'Legacy', prompt: 'L' }];
        mockPowerUser.group_card_post_merge_prompt_presets = [{ name: 'Legacy Post', prompt: 'LP' }];

        renderPage(makeSnapshot({ settings: { postProcessingEnabled: true } }));

        const mainSelect = findOne(container, hasAriaLabel('combine prompt presets'));
        expect(mainSelect.children.map((option) => option.textContent)).toEqual(['— Load preset —', 'Legacy']);
        const postSelect = findOne(container, hasAriaLabel('post-processing prompt presets'));
        expect(postSelect.children.map((option) => option.textContent)).toEqual(['— Load preset —', 'Legacy Post']);
        expect(mockPowerUser.group_card_combine_prompt_presets).toBeUndefined();
        expect(mockPowerUser.group_card_post_merge_prompt_presets).toBeUndefined();
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
    });

    test('Apply loads the preset into the main prompt and commits through the prompt patch path', () => {
        global.toastr = { success: jest.fn(), warning: jest.fn() };
        seedPromptPresets({ main: [{ name: 'Dark', prompt: 'Combine darkly.' }] });
        const { actions } = renderPage(makeSnapshot());

        // Typing first enables the explicit Save button.
        const mainArea = findOne(container, hasFieldKey('prompt:main:text'));
        mainArea.value = 'Unsaved typing.';
        mainArea.fire('input');
        expect(findOne(container, hasClass('bc-task-save-prompt')).disabled).toBe(false);

        const row = findPresetRow(container, 'combine prompt presets');
        const select = findOne(row, hasAriaLabel('combine prompt presets'));
        select.value = '0';
        select.fire('change');

        const applyButton = findOne(row, hasClass('bc-task-preset-apply'));
        expect(applyButton.disabled).toBe(false);
        applyButton.click();

        expect(findOne(container, hasFieldKey('prompt:main:text')).value).toBe('Combine darkly.');
        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ prompts: { main: { text: 'Combine darkly.' } } });
        // Apply committed the prompt, so the explicit Save gates off again.
        expect(findOne(container, hasClass('bc-task-save-prompt')).disabled).toBe(true);
        expect(global.toastr.success).toHaveBeenCalledWith('Loaded prompt preset "Dark".', 'Combine into Group Card');
    });

    test('Apply on a pass field patches that prompt field', () => {
        seedPromptPresets({ secondPass: [{ name: 'Refine', prompt: 'Refine harder.' }] });
        const { actions } = renderPage(makeSnapshot({ settings: { secondPassEnabled: true } }));

        const row = findPresetRow(container, 'second-pass instructions presets');
        const select = findOne(row, hasAriaLabel('second-pass instructions presets'));
        select.value = '0';
        select.fire('change');
        findOne(row, hasClass('bc-task-preset-apply')).click();

        expect(actions.update).toHaveBeenCalledTimes(1);
        expect(actions.update).toHaveBeenCalledWith({ prompts: { secondPass: { text: 'Refine harder.' } } });
        expect(findOne(container, hasFieldKey('prompt:secondPass:text')).value).toBe('Refine harder.');
    });

    test('Save stores the current field text as a named preset and refreshes the select', async () => {
        global.toastr = { success: jest.fn(), warning: jest.fn() };
        renderPage(makeSnapshot());
        const row = findPresetRow(container, 'combine prompt presets');

        mockCallGenericPopup.mockResolvedValueOnce('My Preset');
        findOne(row, hasClass('bc-task-preset-save')).click();
        await flushAsync();

        expect(mockCallGenericPopup).toHaveBeenCalledTimes(1);
        expect(mockCallGenericPopup).toHaveBeenCalledWith(
            expect.stringContaining('Save the current combine prompt'),
            POPUP_TYPE.INPUT,
            '',
            expect.objectContaining({ okButton: 'Save' }),
        );
        expect(mockPowerUser[STORE_KEY].main).toEqual([{ name: 'My Preset', prompt: 'Combine these cards into one.' }]);
        expect(global.toastr.success).toHaveBeenCalledWith('Saved prompt preset "My Preset".', 'Combine into Group Card');

        // The re-rendered select lists and pre-selects the new preset.
        const rebuilt = findOne(container, hasAriaLabel('combine prompt presets'));
        expect(rebuilt.children.map((option) => option.textContent)).toEqual(['— Load preset —', 'My Preset']);
        expect(rebuilt.value).toBe('0');
    });

    test('Save confirms before overwriting an existing preset', async () => {
        seedPromptPresets({ main: [{ name: 'Dup', prompt: 'Original.' }] });
        renderPage(makeSnapshot());

        const select = findOne(container, hasAriaLabel('combine prompt presets'));
        select.value = '0';
        select.fire('change');
        const row = select.parentElement;

        // Cancelled overwrite: the input popup returns the existing name
        // (pre-filled from the selection), the confirm popup is declined.
        mockCallGenericPopup.mockResolvedValueOnce('Dup').mockResolvedValueOnce(POPUP_RESULT.NEGATIVE);
        findOne(row, hasClass('bc-task-preset-save')).click();
        await flushAsync();

        expect(mockCallGenericPopup).toHaveBeenNthCalledWith(1, expect.any(String), POPUP_TYPE.INPUT, 'Dup', expect.any(Object));
        expect(mockCallGenericPopup).toHaveBeenNthCalledWith(2, expect.stringContaining('Overwrite prompt preset "Dup"?'), POPUP_TYPE.CONFIRM, '', expect.objectContaining({ okButton: 'Overwrite' }));
        expect(mockPowerUser[STORE_KEY].main).toEqual([{ name: 'Dup', prompt: 'Original.' }]);

        // Confirmed overwrite (no re-render happened on the cancel, the row
        // is still live).
        mockCallGenericPopup.mockReset();
        mockCallGenericPopup.mockResolvedValueOnce('Dup').mockResolvedValueOnce(POPUP_RESULT.AFFIRMATIVE);
        findOne(row, hasClass('bc-task-preset-save')).click();
        await flushAsync();

        expect(mockPowerUser[STORE_KEY].main).toEqual([{ name: 'Dup', prompt: 'Combine these cards into one.' }]);
    });

    test('a cancelled save popup changes nothing', async () => {
        renderPage(makeSnapshot());

        mockCallGenericPopup.mockResolvedValueOnce(POPUP_RESULT.CANCELLED);
        findOne(findPresetRow(container, 'combine prompt presets'), hasClass('bc-task-preset-save')).click();
        await flushAsync();

        expect(mockCallGenericPopup).toHaveBeenCalledTimes(1);
        expect(mockPowerUser[STORE_KEY].main).toEqual([]);
    });

    test('Delete removes the selected preset and refreshes the select', () => {
        global.toastr = { success: jest.fn() };
        seedPromptPresets({ main: [{ name: 'A', prompt: 'a' }, { name: 'B', prompt: 'b' }] });
        renderPage(makeSnapshot());

        const select = findOne(container, hasAriaLabel('combine prompt presets'));
        select.value = '0';
        select.fire('change');
        const row = select.parentElement;
        findOne(row, hasClass('bc-task-preset-delete')).click();

        expect(mockPowerUser[STORE_KEY].main).toEqual([{ name: 'B', prompt: 'b' }]);
        expect(global.toastr.success).toHaveBeenCalledWith('Deleted prompt preset "A".', 'Combine into Group Card');

        const rebuilt = findOne(container, hasAriaLabel('combine prompt presets'));
        expect(rebuilt.children.map((option) => option.textContent)).toEqual(['— Load preset —', 'B']);
        expect(rebuilt.value).toBe('');
        expect(findOne(rebuilt.parentElement, hasClass('bc-task-preset-delete')).disabled).toBe(true);
    });

    test('preset rows follow their pass-row visibility', () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();

        page.render(container, makeSnapshot(), actions);
        const summaryRow = findOne(container, hasFieldKey('prompt:summary:text')).parentElement;
        expect(summaryRow.hidden).toBe(true);
        expect(findOne(summaryRow, hasAriaLabel('summary prompt presets'))).not.toBe(null);

        page.render(container, makeSnapshot({ settings: { destination: 'lorebook' } }), actions);
        const visibleSummaryRow = findOne(container, hasFieldKey('prompt:summary:text')).parentElement;
        expect(visibleSummaryRow.hidden).toBe(false);
        expect(findOne(visibleSummaryRow, hasAriaLabel('summary prompt presets'))).not.toBe(null);
    });

    // ------------------------------------------------------------------
    // Continue (page advance), assist durability, read-only completed tasks
    // ------------------------------------------------------------------

    test('Continue is gated on the main prompt and advances to Transform 1 (page 3)', async () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();

        // Empty prompt: disabled with an explanation; click is a no-op.
        page.render(container, makeSnapshot({ prompts: { main: makePrompt('  ') } }), actions);
        let continueButton = findOne(container, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(true);
        expect(continueButton.title).toContain('combine prompt');
        continueButton.click();
        await flushAsync();
        expect(actions.goToPage).not.toHaveBeenCalled();

        // Saved prompt text: enabled and advances to Transform 1.
        page.render(container, makeSnapshot(), actions);
        continueButton = findOne(container, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        await flushAsync();
        expect(actions.goToPage).toHaveBeenCalledTimes(1);
        expect(actions.goToPage).toHaveBeenCalledWith(3);
    });

    test('Continue commits an unsaved prompt draft before advancing', async () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();
        page.render(container, makeSnapshot(), actions);

        const textarea = findOne(container, hasFieldKey('prompt:main:text'));
        textarea.value = 'Draft replacement prompt';
        textarea.fire('input');

        findOne(container, hasClass('bc-task-continue')).click();
        await flushAsync();

        expect(actions.update).toHaveBeenCalledWith({ prompts: { main: { text: 'Draft replacement prompt' } } });
        expect(actions.goToPage).toHaveBeenCalledWith(3);
    });

    test('a snapshot-persisted pending assist request keeps Suggest disabled and offers Discard', async () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();

        // Re-opened page with an outstanding assist request (no proposal/error
        // yet): the waiting state is derived from the snapshot, not a closure.
        const pending = makeSnapshot({ prompts: { main: makePrompt('Combine these cards into one.', { request: 'Make it shorter' }) } });
        page.render(container, pending, actions);

        const suggestButton = findOne(container, hasClass('bc-task-suggest'));
        expect(suggestButton.disabled).toBe(true);
        expect(container.textContent).toContain('Generating a proposal');
        suggestButton.click();
        await flushAsync();
        expect(actions.runPromptAssist).not.toHaveBeenCalled();

        // The pending request can be discarded so Suggest becomes usable again.
        findOne(container, hasClass('bc-task-discard-request')).click();
        await flushAsync();
        expect(actions.update).toHaveBeenCalledWith({
            prompts: { main: { assistant: { request: '', proposal: '', diff: '', applied: false, error: '' } } },
        });
    });

    test('an assist launch failure surfaces an inline alert (not console-only)', async () => {
        const actions = makeActions();
        actions.runPromptAssist = jest.fn(async () => {
            throw new Error('assist route down');
        });
        const page = createPromptSettingsPage();
        page.render(container, makeSnapshot(), actions);

        const requestArea = findOne(container, hasFieldKey('assistant:main:request'));
        requestArea.value = 'Make it spicier';
        requestArea.fire('input');
        findOne(container, hasClass('bc-task-suggest')).click();
        await flushAsync();

        const alert = findOne(container, (element) => element.getAttribute?.('role') === 'alert' && hasClass('bc-task-assist-error')(element));
        expect(alert).not.toBe(null);
        expect(alert.textContent).toContain('assist route down');
        // Suggest is usable again after the failed launch.
        expect(findOne(container, hasClass('bc-task-suggest')).disabled).toBe(false);
    });

    test('completed tasks render read-only (edits/runs disabled) but stay navigable', async () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();
        page.render(container, makeSnapshot({ status: 'completed' }), actions);

        expect(container.textContent).toContain('read-only');
        expect(findOne(container, hasFieldKey('prompt:main:text')).readOnly).toBe(true);
        expect(findOne(container, hasFieldKey('assistant:main:request')).readOnly).toBe(true);
        expect(findOne(container, hasClass('bc-task-save-prompt')).disabled).toBe(true);
        expect(findOne(container, hasClass('bc-task-suggest')).disabled).toBe(true);
        // Settings controls are disabled too.
        expect(findOne(container, hasAriaLabel('Connection profile')).disabled).toBe(true);
        expect(findOne(container, hasAriaLabel('Second pass')).disabled).toBe(true);
        expect(findOne(container, hasAriaLabel('Total context tokens')).disabled).toBe(true);
        expect(findOne(container, hasAriaLabel('Refusal retries')).disabled).toBe(true);
        for (const label of ['Personality', 'Scenario', 'First message', 'Example messages']) {
            expect(findOne(container, hasAriaLabel(label)).disabled).toBe(true);
        }

        // Navigation still works: Continue is pure navigation.
        const continueButton = findOne(container, hasClass('bc-task-continue'));
        expect(continueButton.disabled).toBe(false);
        continueButton.click();
        await flushAsync();
        expect(actions.goToPage).toHaveBeenCalledWith(3);
        // …without committing anything (read-only).
        expect(actions.update).not.toHaveBeenCalled();
    });
});
