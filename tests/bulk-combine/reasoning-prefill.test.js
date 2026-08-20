/* eslint-disable playwright/no-standalone-expect -- Jest parameterized tests are not Playwright tests. */

import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

const fetchMock = jest.fn();
const originalCwd = process.cwd();
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const mockExtensionSettings = { connectionManager: { profiles: [] } };
const mockPresetNames = {};
const mockPresets = [];

jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
}));

jest.unstable_mockModule('../../src/users.js', () => ({
    getAllUserHandles: jest.fn(async () => []),
    getUserDirectories: jest.fn(() => ({ root: '' })),
    getCookieSecret: jest.fn(() => 'test-cookie-secret'),
}));

jest.unstable_mockModule('../../src/endpoints/secrets.js', () => ({
    allowKeysExposure: false,
    readSecret: () => 'test-secret',
    writeSecret: jest.fn(),
    SECRETS_FILE: 'secrets.json',
    SECRET_KEYS: {
        CUSTOM: 'api_key_custom',
    },
}));

jest.unstable_mockModule('../../public/scripts/extensions.js', () => ({
    extension_settings: mockExtensionSettings,
}));

jest.unstable_mockModule('../../public/scripts/openai.js', () => ({
    openai_setting_names: mockPresetNames,
    openai_settings: mockPresets,
    proxies: [],
}));

let executeChatCompletion;
let resolveCompletionSettings;
let sanitizeCompletionSettings;

beforeAll(async () => {
    process.chdir(projectRoot);
    const { setConfigFilePath } = await import('../../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../../config.yaml', import.meta.url)));
    global.DATA_ROOT = projectRoot;
    ({ executeChatCompletion } = await import('../../src/endpoints/backends/chat-completions.js'));
    ({ sanitizeCompletionSettings } = await import('../../src/endpoints/bulk-combine.js'));
    ({ resolveCompletionSettings } = await import('../../public/scripts/bulk-combine/services/resolveCompletionSettings.js'));
});

beforeEach(() => {
    fetchMock.mockReset();
});

afterAll(() => {
    process.chdir(originalCwd);
});

describe('Bulk Combine reasoning prefill settings', () => {
    test('layers a non-empty preset prefill even when a connection profile is active', () => {
        const result = resolveCompletionSettings(
            { settings: { connectionProfile: 'profile-1', preset: 'Reasoning' } },
            {
                profiles: [{ id: 'profile-1', api: 'custom', model: 'profile-model' }],
                presets: {
                    Reasoning: {
                        chat_completion_source: 'custom',
                        custom_model: 'preset-model',
                        reasoning_prefill: 'Plan before answering.',
                    },
                },
                apiMap: { custom: { selected: 'openai', source: 'custom' } },
            },
        );

        expect(result.reasoning_prefill).toBe('Plan before answering.');
        expect(result.model).toBe('profile-model');
    });

    test.each([
        ['missing', {}],
        ['empty', { reasoning_prefill: '   ' }],
    ])('omits a %s preset prefill', (_label, presetOverrides) => {
        const result = resolveCompletionSettings(
            { settings: { preset: 'Default' } },
            {
                presets: {
                    Default: {
                        chat_completion_source: 'custom',
                        custom_model: 'test-model',
                        ...presetOverrides,
                    },
                },
            },
        );

        expect(result).not.toHaveProperty('reasoning_prefill');
    });

    test('sanitizer keeps reasoning prefill while dropping secret-looking fields', () => {
        expect(sanitizeCompletionSettings({
            reasoning_prefill: 'Plan first.',
            api_key: 'leak',
        })).toEqual({ reasoning_prefill: 'Plan first.' });
    });
});

describe('programmatic Chat Completion reasoning prefill', () => {
    const providerData = { choices: [{ message: { content: 'Completed' } }] };

    test('applies and strips the prefill before the provider request', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => providerData,
        });
        const body = {
            chat_completion_source: 'custom',
            custom_url: 'https://example.test/v1',
            messages: [{ role: 'user', content: 'Combine cards' }],
            model: 'test-model',
            stream: false,
            logprobs: 0,
            reasoning_prefill: '  Plan before answering.  ',
        };

        await executeChatCompletion({ body, userDirectories: {} });

        const outgoingBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(outgoingBody).not.toHaveProperty('reasoning_prefill');
        expect(outgoingBody.messages.at(-1)).toEqual({
            role: 'assistant',
            content: '',
            reasoning_content: 'Plan before answering.',
            partial: true,
        });
        expect(body).not.toHaveProperty('reasoning_prefill');
        expect(body.include_reasoning).toBe(true);
    });

    test('strips but does not apply the prefill when tools are present', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => providerData,
        });
        const tools = [{ type: 'function', function: { name: 'lookup' } }];
        const body = {
            chat_completion_source: 'custom',
            custom_url: 'https://example.test/v1',
            messages: [{ role: 'user', content: 'Combine cards' }],
            model: 'test-model',
            stream: false,
            logprobs: 0,
            tools,
            reasoning_prefill: 'Plan before answering.',
        };

        await executeChatCompletion({ body, userDirectories: {} });

        const outgoingBody = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(outgoingBody).not.toHaveProperty('reasoning_prefill');
        expect(outgoingBody.messages).toEqual([{ role: 'user', content: 'Combine cards' }]);
        expect(outgoingBody.tools).toEqual(tools);
        expect(body).not.toHaveProperty('reasoning_prefill');
        expect(body).not.toHaveProperty('include_reasoning');
    });
});
