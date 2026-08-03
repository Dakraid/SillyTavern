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
 * (`escapeHtml`). The Node test environment has no DOM, so a minimal fake
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

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: mockExtensionSettings,
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: mockPresetNames,
    openai_settings: mockPresets,
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
 * @param {object} [options] Fixture options.
 * @param {object} [options.settings] Settings overrides.
 * @param {object} [options.prompts] Prompt overrides (whole records).
 * @returns {object} State snapshot payload (mirrors `TaskWizardState#getSnapshot`).
 */
function makeSnapshot({ settings = {}, prompts = {} } = {}) {
    return {
        task: {
            id: 'task-1',
            name: 'Task',
            sources: [],
            settings: {
                mode: 'individual',
                concurrency: 2,
                connectionProfile: null,
                preset: null,
                totalContextTokens: null,
                outputTokens: null,
                destination: 'card',
                xmlEnabled: false,
                xmlMinify: false,
                postProcessingEnabled: false,
                postProcessingMode: 'replace',
                secondPassEnabled: false,
                ...settings,
            },
            prompts: {
                main: makePrompt('Combine these cards into one.'),
                secondPass: makePrompt(''),
                summary: makePrompt(''),
                post: makePrompt(''),
                ...prompts,
            },
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

        const combined = findOne(container, hasAriaLabel('Combined'));
        combined.checked = true;
        combined.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { mode: 'combined' } });

        const concurrency = findOne(container, hasAriaLabel('Concurrency'));
        concurrency.value = '3';
        concurrency.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { concurrency: 3 } });

        const destination = findOne(container, hasAriaLabel('Output destination'));
        destination.value = 'lorebook';
        destination.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { destination: 'lorebook' } });

        const xmlEnabled = findOne(container, hasAriaLabel('XML tagging'));
        xmlEnabled.checked = true;
        xmlEnabled.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { xmlEnabled: true } });

        const secondPass = findOne(container, hasAriaLabel('Second pass'));
        secondPass.checked = true;
        secondPass.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { secondPassEnabled: true } });

        const postMode = findOne(container, hasAriaLabel('Post-processing mode'));
        postMode.value = 'append';
        postMode.fire('change');
        expect(actions.update).toHaveBeenLastCalledWith({ settings: { postProcessingMode: 'append' } });

        expect(actions.update).toHaveBeenCalledTimes(6);
    });

    test('concurrency locks in combined mode; pass rows hide unless enabled; summary needs lorebook', () => {
        const page = createPromptSettingsPage();
        const actions = makeActions();

        // Default snapshot: individual mode, nothing enabled, card destination.
        page.render(container, makeSnapshot(), actions);
        expect(findOne(container, hasAriaLabel('Concurrency')).disabled).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:secondPass:text')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasFieldKey('prompt:post:text')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasAriaLabel('Post-processing mode')).parentElement.hidden).toBe(true);
        expect(findOne(container, hasFieldKey('prompt:summary:text')).parentElement.hidden).toBe(true);

        // Combined + passes enabled + lorebook destination.
        page.render(container, makeSnapshot({
            settings: {
                mode: 'combined',
                secondPassEnabled: true,
                postProcessingEnabled: true,
                destination: 'lorebook',
            },
        }), actions);
        const locked = findOne(container, hasAriaLabel('Concurrency'));
        expect(locked.disabled).toBe(true);
        expect(locked.title).toContain('individual mode');
        expect(findOne(container, hasFieldKey('prompt:secondPass:text')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:post:text')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasAriaLabel('Post-processing mode')).parentElement.hidden).toBe(false);
        expect(findOne(container, hasFieldKey('prompt:summary:text')).parentElement.hidden).toBe(false);
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
            page.render(container, makeSnapshot({ settings: { mode: 'combined' } }), actions);
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
});
