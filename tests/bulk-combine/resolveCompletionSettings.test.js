'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for
 * `public/scripts/bulk-combine/services/resolveCompletionSettings.js`.
 *
 * The resolver is pure given injected deps; `extensions.js`/`openai.js` are
 * mocked only for the default-deps path (fixed-reference mutable fixtures).
 */

import {
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

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: mockExtensionSettings,
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: mockPresetNames,
    openai_settings: mockPresets,
}));

/**
 * Chat-completion api map fixture (shaped like `CONNECT_API_MAP`).
 *
 * @type {Record<string, {selected: string, source: string}>}
 */
const CC_MAP = {
    openai: { selected: 'openai', source: 'openai' },
    oai: { selected: 'openai', source: 'openai' },
    google: { selected: 'openai', source: 'makersuite' },
    makersuite: { selected: 'openai', source: 'makersuite' },
    claude: { selected: 'openai', source: 'claude' },
    textgenerationwebui: { selected: 'textgenerationwebui', source: 'textgenerationwebui' },
};

/**
 * @param {object} [settings] Settings overrides over the task defaults.
 * @returns {object} Task fixture.
 */
function makeTask(settings = {}) {
    return {
        settings: {
            mode: 'individual',
            concurrency: 1,
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
    };
}

/**
 * @param {object} [overrides] Shallow-merged overrides.
 * @returns {object} Connection profile fixture.
 */
function makeProfile(overrides = {}) {
    return {
        id: 'profile-1',
        mode: 'cc',
        name: 'GPT Profile',
        api: 'openai',
        preset: '',
        model: 'gpt-4o',
        proxy: '',
        'api-url': 'https://proxy.example/v1',
        'secret-id': 'openai-key-ref',
        ...overrides,
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
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        top_p: 0.9,
        top_k: 40,
        ...overrides,
    };
}

let resolveCompletionSettings;

beforeAll(async () => {
    ({ resolveCompletionSettings } = await import('../../public/scripts/bulk-combine/services/resolveCompletionSettings.js'));
});

beforeEach(() => {
    mockExtensionSettings.connectionManager.profiles = [];
    for (const key of Object.keys(mockPresetNames)) {
        delete mockPresetNames[key];
    }
    mockPresets.splice(0, mockPresets.length);
});

describe('resolveCompletionSettings', () => {
    test('profile wins for model/source/transport; explicit windows win over the preset', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1', preset: 'Fast', totalContextTokens: 64000, outputTokens: 2048 }),
            { profiles: [makeProfile()], presets: { Fast: makePreset() }, apiMap: CC_MAP },
        );

        expect(result).toEqual({
            stream: false,
            chat_completion_source: 'openai',
            model: 'gpt-4o', // profile.model beats preset openai_model.
            max_context: 64000, // override beats preset openai_max_context.
            max_tokens: 2048, // override beats preset openai_max_tokens.
            temperature: 0.7,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            top_p: 0.9,
            top_k: 40,
            secret_id: 'openai-key-ref',
            custom_url: 'https://proxy.example/v1',
        });
        // The runner spreads this body verbatim: the old-pipeline key is wrong here.
        expect(result).not.toHaveProperty('amount_gen');
    });

    test('preset layer supplies model/source/windows when no profile is set', () => {
        const result = resolveCompletionSettings(
            makeTask({ preset: 'Fast' }),
            { profiles: [makeProfile()], presets: { Fast: makePreset() }, apiMap: CC_MAP },
        );

        expect(result).toEqual({
            stream: false,
            chat_completion_source: 'openai',
            model: 'gpt-4o-mini',
            max_context: 128000,
            max_tokens: 4096,
            temperature: 0.7,
            frequency_penalty: 0.1,
            presence_penalty: 0.2,
            top_p: 0.9,
            top_k: 40,
        });
    });

    test('override-only tasks emit just the windows (unresolvable keys are omitted)', () => {
        const result = resolveCompletionSettings(
            makeTask({ totalContextTokens: 100000.9, outputTokens: 500 }),
            { profiles: [], presets: {}, apiMap: CC_MAP },
        );

        expect(result).toEqual({ stream: false, max_context: 100000, max_tokens: 500 });
        expect(result).not.toHaveProperty('model');
        expect(result).not.toHaveProperty('chat_completion_source');
    });

    test('blank/0/negative window overrides inherit the preset windows', () => {
        const result = resolveCompletionSettings(
            makeTask({ preset: 'Fast', totalContextTokens: 0, outputTokens: -5 }),
            { presets: { Fast: makePreset() }, apiMap: CC_MAP },
        );

        expect(result.max_context).toBe(128000);
        expect(result.max_tokens).toBe(4096);
    });

    test('unresolvable tasks degrade to stream:false only', () => {
        expect(resolveCompletionSettings(null)).toEqual({ stream: false });
        expect(resolveCompletionSettings({})).toEqual({ stream: false });
        expect(resolveCompletionSettings(makeTask(), { profiles: [], presets: {}, apiMap: CC_MAP })).toEqual({ stream: false });
    });

    test('makersuite presets resolve the model via google_model (only special case)', () => {
        const result = resolveCompletionSettings(
            makeTask({ preset: 'Gem' }),
            {
                presets: {
                    Gem: makePreset({
                        chat_completion_source: 'makersuite',
                        google_model: 'gemini-2.0-pro',
                        makersuite_model: 'WRONG-KEY-NEVER-USED',
                    }),
                },
                apiMap: CC_MAP,
            },
        );

        expect(result.chat_completion_source).toBe('makersuite');
        expect(result.model).toBe('gemini-2.0-pro');
    });

    test('a missing profile id falls through to the preset layer', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'gone', preset: 'Fast' }),
            { profiles: [makeProfile()], presets: { Fast: makePreset() }, apiMap: CC_MAP },
        );

        expect(result.model).toBe('gpt-4o-mini');
        expect(result).not.toHaveProperty('secret_id');
        expect(result).not.toHaveProperty('custom_url');
    });

    test('text-generation profiles cannot drive chat completions and fall through to the preset', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'p-local', preset: 'Fast' }),
            {
                profiles: [makeProfile({ id: 'p-local', api: 'textgenerationwebui', model: 'local-llama', 'secret-id': 'local-ref' })],
                presets: { Fast: makePreset() },
                apiMap: CC_MAP,
            },
        );

        expect(result.chat_completion_source).toBe('openai');
        expect(result.model).toBe('gpt-4o-mini');
        expect(result).not.toHaveProperty('secret_id');
        expect(result).not.toHaveProperty('custom_url');
    });

    test('never emits plaintext secrets or proxy material — only the secret_id reference', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1' }),
            {
                profiles: [makeProfile({
                    api_key: 'sk-PLAINTEXT',
                    key: 'sk-PLAINTEXT',
                    token: 'tok-PLAINTEXT',
                    proxy_password: 'hunter2',
                    reverse_proxy: 'http://reverse.example',
                })],
                apiMap: CC_MAP,
            },
        );

        expect(result.secret_id).toBe('openai-key-ref');
        for (const key of ['api_key', 'key', 'token', 'proxy_password', 'reverse_proxy', 'password']) {
            expect(result).not.toHaveProperty(key);
        }
        expect(Object.values(result)).not.toContain('sk-PLAINTEXT');
        expect(Object.values(result)).not.toContain('tok-PLAINTEXT');
        expect(Object.values(result)).not.toContain('hunter2');
        expect(Object.values(result)).not.toContain('http://reverse.example');
    });

    test('profiles with empty secret-id / api-url omit those keys', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1' }),
            { profiles: [makeProfile({ 'secret-id': '', 'api-url': '   ' })], apiMap: CC_MAP },
        );

        expect(result).not.toHaveProperty('secret_id');
        expect(result).not.toHaveProperty('custom_url');
        expect(result.model).toBe('gpt-4o');
    });

    test('api aliases resolve through the injected map (oai → openai)', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1' }),
            { profiles: [makeProfile({ api: 'oai' })], apiMap: CC_MAP },
        );

        expect(result.chat_completion_source).toBe('openai');
        expect(result.secret_id).toBe('openai-key-ref');
    });

    test('unknown profile apis pass through as raw chat-completion sources', () => {
        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1' }),
            { profiles: [makeProfile({ api: 'custom-backend' })], apiMap: CC_MAP },
        );

        expect(result.chat_completion_source).toBe('custom-backend');
        expect(result.model).toBe('gpt-4o');
    });

    test('google profile api maps to the makersuite preset model key', () => {
        const result = resolveCompletionSettings(
            makeTask({ preset: 'Gem' }),
            {
                presets: { Gem: makePreset({ chat_completion_source: 'makersuite', google_model: 'gemini-2.0-flash' }) },
                apiMap: CC_MAP,
            },
        );

        expect(result.model).toBe('gemini-2.0-flash');
    });

    test('default deps read the mocked extension_settings / openai exports (array presets via name index)', () => {
        mockExtensionSettings.connectionManager.profiles = [makeProfile()];
        mockPresetNames.Fast = 0;
        mockPresets.push(makePreset());

        const result = resolveCompletionSettings(
            makeTask({ connectionProfile: 'profile-1', preset: 'Fast', outputTokens: 1024 }),
        );

        expect(result.model).toBe('gpt-4o');
        expect(result.chat_completion_source).toBe('openai');
        expect(result.max_tokens).toBe(1024);
        expect(result.max_context).toBe(128000);
        expect(result.temperature).toBe(0.7);
        expect(result.secret_id).toBe('openai-key-ref');
        expect(result.stream).toBe(false);
    });

    test('default deps tolerate unloaded openai state (undefined exports)', () => {
        // With empty fixtures there is nothing to resolve — no throw, no keys.
        const result = resolveCompletionSettings(makeTask({ preset: 'Missing', connectionProfile: 'nope' }));
        expect(result).toEqual({ stream: false });
    });
});
