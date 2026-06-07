import { describe, test, expect, jest, beforeAll } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);
const fixtures = JSON.parse(
    fs.readFileSync(
        path.join(projectRoot, 'tests/fixtures/openrouter-chat-completions.json'),
        'utf8',
    ),
);

const openRouterSettings = {
    chat_completion_source: 'openrouter',
    function_calling: true,
    custom_prompt_post_processing: '',
};

global.toastr = global.toastr ?? { info: jest.fn(), clear: jest.fn() };

jest.unstable_mockModule('../public/lib.js', () => ({
    DOMPurify: { sanitize: (value) => value },
}));
jest.unstable_mockModule('../public/script.js', () => ({
    addOneMessage: jest.fn(),
    chat: [],
    event_types: {},
    eventSource: { emit: jest.fn() },
    getGeneratingApi: () => 'openai',
    getGeneratingModel: () => 'openrouter/test-model',
    main_api: 'openai',
    saveChatConditional: jest.fn(),
    system_avatar: 'img/ai4.png',
    systemUserName: 'System',
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: {
        OPENAI: 'openai',
        CUSTOM: 'custom',
        MISTRALAI: 'mistralai',
        CLAUDE: 'claude',
        OPENROUTER: 'openrouter',
        AIMLAPI: 'aimlapi',
        GROQ: 'groq',
        COHERE: 'cohere',
        DEEPSEEK: 'deepseek',
        MAKERSUITE: 'makersuite',
        VERTEXAI: 'vertexai',
        AI21: 'ai21',
        XAI: 'xai',
        POLLINATIONS: 'pollinations',
        MOONSHOT: 'moonshot',
        FIREWORKS: 'fireworks',
        COMETAPI: 'cometapi',
        CHUTES: 'chutes',
        ELECTRONHUB: 'electronhub',
        AZURE_OPENAI: 'azure_openai',
        ZAI: 'zai',
        SILICONFLOW: 'siliconflow',
        NANOGPT: 'nanogpt',
        WORKERS_AI: 'workers_ai',
        MINIMAX: 'minimax',
    },
    custom_prompt_post_processing_types: {
        NONE: '',
        MERGE_TOOLS: 'merge_tools',
        SEMI_TOOLS: 'semi_tools',
        STRICT_TOOLS: 'strict_tools',
    },
    getChatCompletionModel: () => 'openrouter/test-model',
    model_list: [],
    oai_settings: openRouterSettings,
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    Popup: class Popup {},
}));
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommand.js',
    () => ({ SlashCommand: class SlashCommand {} }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandArgument.js',
    () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: class SlashCommandArgument {},
        SlashCommandNamedArgument: class SlashCommandNamedArgument {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandClosure.js',
    () => ({ SlashCommandClosure: class SlashCommandClosure {} }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js',
    () => ({ enumIcons: {} }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandEnumValue.js',
    () => ({
        enumTypes: {},
        SlashCommandEnumValue: class SlashCommandEnumValue {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandParser.js',
    () => ({ SlashCommandParser: { addCommandObject: jest.fn() } }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandReturnHelper.js',
    () => ({ slashCommandReturnHelper: { doReturn: (value) => value } }),
);
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    isTrueBoolean: (value) => value === true || value === 'true',
}));

/** @type {typeof import('../public/scripts/tool-calling.js').ToolManager} */
let ToolManager;

beforeAll(async () => {
    ({ ToolManager } = await import('../public/scripts/tool-calling.js'));
});

describe('OpenRouter Chat Completion tool call parsing', () => {
    test('accumulates streaming delta.tool_calls by choice and tool index', () => {
        const toolCalls = [];

        for (const chunk of fixtures.streamingToolCalls) {
            ToolManager.parseToolCalls(toolCalls, chunk, {});
        }

        expect(toolCalls).toEqual([
            [
                {
                    index: 0,
                    id: 'call_search',
                    type: 'function',
                    function: {
                        name: 'search_web',
                        arguments: '{"query":"OpenRouter reasoning"}',
                    },
                },
            ],
        ]);
    });

    test('keeps streaming tool calls separate from accumulated reasoning', () => {
        const toolCalls = [];
        let reasoning = '';

        const [reasoningChunk, toolChunk] =
			fixtures.streamingToolCallsWithReasoning;
        reasoning += reasoningChunk.choices[0].delta.reasoning;
        ToolManager.parseToolCalls(toolCalls, reasoningChunk, {});
        ToolManager.parseToolCalls(toolCalls, toolChunk, {});

        expect(reasoning).toBe('Need external facts before answering.');
        expect(toolCalls[0][0]).toEqual({
            index: 0,
            id: 'call_search',
            type: 'function',
            function: {
                name: 'search_web',
                arguments: '{"query":"reasoning"}',
            },
        });
    });

    test('applies OpenRouter encrypted tool-call signatures by call id while parsing deltas', () => {
        const toolCalls = [];
        const toolSignatures = { call_search: 'encrypted-tool-signature' };

        for (const chunk of fixtures.streamingToolCalls) {
            ToolManager.parseToolCalls(toolCalls, chunk, toolSignatures);
        }

        expect(toolCalls[0][0].signature).toBe('encrypted-tool-signature');
    });

    test('recognizes non-streaming message.tool_calls as complete OpenRouter tool calls', async () => {
        ToolManager.registerFunctionTool({
            name: 'lookup',
            displayName: 'Lookup',
            description: 'Lookup fixture data',
            parameters: {},
            action: async (params) => `looked up ${params.id}`,
        });

        const invocation = await ToolManager.invokeFunctionTools(
            fixtures.nonStreamingFullResponse,
        );

        expect(ToolManager.hasToolCalls(fixtures.nonStreamingFullResponse)).toBe(
            true,
        );
        expect(invocation.errors).toEqual([]);
        expect(invocation.stealthCalls).toEqual([]);
        expect(invocation.invocations).toEqual([
            {
                id: 'call_lookup',
                displayName: 'Lookup',
                name: 'lookup',
                parameters: '{"id":1}',
                result: 'looked up 1',
                error: false,
                signature: null,
                reasoning: null,
            },
        ]);
    });

    test('keeps non-stealth tool errors as invocations for retry context', async () => {
        ToolManager.registerFunctionTool({
            name: 'failing_lookup',
            displayName: 'Failing Lookup',
            description: 'Fails fixture lookup',
            parameters: {},
            action: async () => {
                throw new Error('missing required id');
            },
        });
        const consoleErrorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});

        const invocation = await ToolManager.invokeFunctionTools({
            choices: [
                {
                    index: 0,
                    message: {
                        tool_calls: [
                            {
                                id: 'call_failing_lookup',
                                type: 'function',
                                function: {
                                    name: 'failing_lookup',
                                    arguments: '{"id":null}',
                                },
                            },
                        ],
                    },
                },
            ],
        });
        consoleErrorSpy.mockRestore();

        expect(invocation.errors).toHaveLength(1);
        expect(invocation.stealthCalls).toEqual([]);
        expect(invocation.invocations).toEqual([
            {
                id: 'call_failing_lookup',
                displayName: 'Failing Lookup',
                name: 'failing_lookup',
                parameters: '{"id":null}',
                result: 'Error: missing required id',
                error: true,
                signature: null,
                reasoning: null,
            },
        ]);
    });
});
