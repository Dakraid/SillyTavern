import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const fetchMock = jest.fn();
const originalCwd = process.cwd();
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

jest.unstable_mockModule('node-fetch', () => ({
    default: fetchMock,
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

let countOpenAIMessageTokens;
let dispatchChatCompletion;
let executeChatCompletion;
let router;

beforeAll(async () => {
    process.chdir(projectRoot);
    const { setConfigFilePath } = await import('../../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../../config.yaml', import.meta.url)));
    global.DATA_ROOT = projectRoot;
    ({ countOpenAIMessageTokens } = await import('../../src/endpoints/tokenizers.js'));
    ({ dispatchChatCompletion, executeChatCompletion, router } = await import('../../src/endpoints/backends/chat-completions.js'));
});

beforeEach(() => {
    fetchMock.mockReset();
});

afterAll(() => {
    process.chdir(originalCwd);
});

describe('internal Chat Completion execution', () => {
    test('keeps the HTTP generate route wired to the shared dispatcher', () => {
        const generateLayer = router.stack.find(layer => layer.route?.path === '/generate');

        expect(generateLayer.route.stack[0].handle).toBe(dispatchChatCompletion);
    });

    test('returns normalized data and propagates an independent AbortSignal', async () => {
        const data = { choices: [{ message: { content: 'Combined result' } }] };
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => data,
        });
        const controller = new AbortController();

        const result = await executeChatCompletion({
            body: {
                chat_completion_source: 'custom',
                custom_url: 'https://example.test/v1',
                messages: [{ role: 'user', content: 'Combine cards' }],
                model: 'test-model',
                stream: false,
                logprobs: 0,
            },
            userDirectories: {},
            signal: controller.signal,
        });

        expect(result).toEqual({ status: 200, data, content: 'Combined result' });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://example.test/v1/chat/completions',
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    test('creates a non-aborted signal when programmatic execution omits one', async () => {
        const data = { choices: [{ message: { content: 'Completed' } }] };
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => data,
        });

        await expect(executeChatCompletion({
            body: {
                chat_completion_source: 'custom',
                custom_url: 'https://example.test/v1',
                messages: [{ role: 'user', content: 'Combine cards' }],
                model: 'test-model',
                stream: false,
                logprobs: 0,
            },
            userDirectories: {},
        })).resolves.toEqual({ status: 200, data, content: 'Completed' });

        const signal = fetchMock.mock.calls[0][1].signal;
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
    });

    test('does not mutate the caller body during prompt post-processing', async () => {
        const data = { choices: [{ message: { content: 'Completed' } }] };
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => data,
        });
        const body = {
            chat_completion_source: 'custom',
            custom_url: 'https://example.test/v1',
            messages: [
                { role: 'user', content: 'First' },
                { role: 'user', content: 'Second' },
            ],
            model: 'test-model',
            stream: false,
            logprobs: 0,
            merge_consecutive_roles: true,
        };
        const originalBody = structuredClone(body);

        await executeChatCompletion({ body, userDirectories: {} });

        expect(body).toEqual(originalBody);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages).toHaveLength(1);
    });

    test('normalizes provider error payloads to a non-success status without changing the data', async () => {
        const data = { error: { message: 'Provider rejected the request', code: 'invalid_request' } };
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => data,
        });

        const result = await executeChatCompletion({
            body: {
                chat_completion_source: 'custom',
                custom_url: 'https://example.test/v1',
                messages: [{ role: 'user', content: 'Combine cards' }],
                model: 'test-model',
                stream: false,
                logprobs: 0,
            },
            userDirectories: {},
        });

        expect(result).toEqual({ status: 502, data, content: '' });
        expect(result.data).toBe(data);
    });

    test('preserves a meaningful non-success status captured by the adapter', async () => {
        await expect(executeChatCompletion({
            body: {
                chat_completion_source: 'unsupported',
                stream: false,
            },
            userDirectories: {},
        })).resolves.toEqual({ status: 400, data: { error: true }, content: '' });
    });

    test('aborts the outbound fetch signal when an HTTP socket closes', async () => {
        const socket = new EventEmitter();
        const data = { choices: [{ message: { content: 'Completed' } }] };
        fetchMock.mockImplementation(async (_url, options) => {
            expect(options.signal.aborted).toBe(false);
            socket.emit('close');
            expect(options.signal.aborted).toBe(true);
            return {
                ok: true,
                json: async () => data,
            };
        });
        const response = {
            headersSent: false,
            writableEnded: false,
            send: jest.fn(),
            status() {
                return this;
            },
        };

        await dispatchChatCompletion({
            body: {
                chat_completion_source: 'custom',
                custom_url: 'https://example.test/v1',
                messages: [{ role: 'user', content: 'Combine cards' }],
                model: 'test-model',
                stream: false,
                logprobs: 0,
            },
            user: { directories: {} },
            socket,
        }, response);

        expect(response.send).toHaveBeenCalledWith(data);
    });

    test('ignores the native request signal for HTTP generation', async () => {
        const socket = new EventEmitter();
        const requestController = new AbortController();
        const data = { choices: [{ message: { content: 'Completed' } }] };
        fetchMock.mockImplementation(async (_url, options) => {
            expect(options.signal.aborted).toBe(false);
            requestController.abort();
            expect(options.signal.aborted).toBe(false);
            return {
                ok: true,
                json: async () => data,
            };
        });
        const response = {
            headersSent: false,
            writableEnded: false,
            send: jest.fn(),
            status() {
                return this;
            },
        };

        await dispatchChatCompletion({
            body: {
                chat_completion_source: 'custom',
                custom_url: 'https://example.test/v1',
                messages: [{ role: 'user', content: 'Combine cards' }],
                model: 'test-model',
                stream: false,
                logprobs: 0,
            },
            user: { directories: {} },
            socket,
            signal: requestController.signal,
        }, response);

        expect(response.send).toHaveBeenCalledWith(data);
    });

    test('rejects streaming programmatic requests', async () => {
        await expect(executeChatCompletion({
            body: { stream: true },
            userDirectories: {},
        })).rejects.toThrow('non-streaming');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('model-aware OpenAI message token counting', () => {
    test('counts a representative tiktoken chat payload', async () => {
        await expect(countOpenAIMessageTokens(
            [{ role: 'user', content: 'Hello' }],
            'gpt-4',
        )).resolves.toBe(8);
    });

    test('safely sanitizes omitted and non-string token models', async () => {
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        for (const queryModel of [undefined, { unexpected: true }]) {
            await expect(countOpenAIMessageTokens(
                [{ role: 'user', content: 'Hello' }],
                queryModel,
            )).resolves.toBe(8);
        }

        expect(consoleError).not.toHaveBeenCalled();
        consoleError.mockRestore();
    });

    test('falls back to the byte-length estimate when model tokenization fails', async () => {
        const messages = { invalid: true };
        const expected = Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 3.35);
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

        await expect(countOpenAIMessageTokens(messages, 'claude')).resolves.toBe(expected);
        consoleError.mockRestore();
    });
});
