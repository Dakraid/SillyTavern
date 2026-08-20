import {
    describe,
    test,
    expect,
    jest,
    beforeAll,
    beforeEach,
} from '@jest/globals';
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

const chainableJquery = () => ({
    on: () => chainableJquery(),
    off: () => chainableJquery(),
    trigger: () => chainableJquery(),
    val: () => chainableJquery(),
    text: () => chainableJquery(),
    empty: () => chainableJquery(),
    append: () => chainableJquery(),
    attr: () => chainableJquery(),
    prop: () => chainableJquery(),
    data: () => chainableJquery(),
    find: () => chainableJquery(),
    closest: () => chainableJquery(),
    toggle: () => chainableJquery(),
    hide: () => chainableJquery(),
    show: () => chainableJquery(),
    length: 0,
});

global.$ = global.$ ?? (() => chainableJquery());
global.Option =
	global.Option ??
	class Option {
	    constructor(text, value) {
	        this.text = text;
	        this.value = value;
	    }
	};
global.toastr = global.toastr ?? {
    error: jest.fn(),
    warning: jest.fn(),
    info: jest.fn(),
    clear: jest.fn(),
};

jest.unstable_mockModule('../public/lib.js', () => ({
    Fuse: class Fuse {},
    DOMPurify: { sanitize: (value) => value },
    moment: {
        duration: () => ({
            asSeconds: () => 0,
            humanize: () => '0 seconds',
            locale() {
                return this;
            },
        }),
    },
}));

jest.unstable_mockModule('../public/script.js', () => ({
    abortStatusCheck: jest.fn(),
    cancelStatusCheck: jest.fn(),
    characters: [],
    chat: [],
    closeMessageEditor: jest.fn(),
    event_types: {},
    eventSource: { emit: jest.fn(), on: jest.fn(), makeLast: jest.fn() },
    extension_prompt_roles: {},
    extension_prompt_types: {},
    Generate: jest.fn(),
    getCurrentChatId: jest.fn(),
    getExtensionPrompt: jest.fn(),
    getExtensionPromptMaxDepth: jest.fn(),
    getMediaDisplay: jest.fn(),
    getMediaIndex: jest.fn(),
    getPromptWrapperStateForMessage: jest.fn(),
    getRequestHeaders: () => ({}),
    is_send_press: false,
    main_api: 'openai',
    messageFormatting: (value) => value,
    name1: 'User',
    name2: 'Assistant',
    resultCheckStatus: jest.fn(),
    saveChatConditional: jest.fn(),
    saveChatDebounced: jest.fn(),
    saveSettingsDebounced: jest.fn(),
    setOnlineStatus: jest.fn(),
    startStatusLoading: jest.fn(),
    substituteParams: (value) => value,
    substituteParamsExtended: (value) => value,
    syncMesToSwipe: jest.fn(),
    system_message_types: {},
    this_chid: 0,
    updateMessageBlock: jest.fn(),
}));

jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({
    getGroupNames: () => [],
    selected_group: null,
}));
jest.unstable_mockModule('../public/scripts/PromptManager.js', () => ({
    chatCompletionDefaultPrompts: {},
    INJECTION_POSITION: {},
    Prompt: class Prompt {},
    PromptManager: class PromptManager {},
    promptManagerDefaultPromptOrders: {},
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    forceCharacterEditorTokenize: false,
    getCustomStoppingStrings: () => [],
    performFuzzySearch: () => [],
    persona_description_positions: {},
    power_user: { reasoning: {}, context: {} },
}));
jest.unstable_mockModule('../public/scripts/secrets.js', () => ({
    SECRET_KEYS: {},
    secret_state: {},
    writeSecret: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/sse-stream.js', () => ({
    getEventSourceStream: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    clamp: (value, min, max) => Math.min(max, Math.max(min, value)),
    createThumbnail: jest.fn(),
    delay: () => Promise.resolve(),
    download: jest.fn(),
    getAudioDurationFromDataURL: jest.fn(),
    getBase64Async: jest.fn(),
    getFileText: jest.fn(),
    getImageSizeFromDataURL: jest.fn(),
    getSortableDelay: () => 0,
    getStringHash: (value) => String(value).length,
    getVideoDurationFromDataURL: jest.fn(),
    copyText: jest.fn(),
    escapeRegex: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    isDataURL: (value) => typeof value === 'string' && /^data:/.test(value),
    isFalseBoolean: (value) => value === false || value === 'false',
    isTrueBoolean: (value) => value === true || value === 'true',
    isUuid: () => false,
    isValidUrl: () => false,
    parseJsonFile: jest.fn(),
    resetScrollHeight: jest.fn(),
    setDatasetProperty: jest.fn(),
    stringFormat: (value, ...args) =>
        String(value).replace(/\{(\d+)\}/g, (_, i) => args[i] ?? ''),
    stringToRange: () => null,
    textValueMatcher: () => false,
    trimSpaces: (value) => String(value ?? '').trim(),
    uuidv4: () => '00000000-0000-4000-8000-000000000000',
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    countTokensOpenAIAsync: jest.fn(async () => 0),
    getTokenizerModel: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    isMobile: () => false,
}));
jest.unstable_mockModule('../public/scripts/logprobs.js', () => ({
    saveLogprobsForActiveMessage: jest.fn(),
}));
jest.unstable_mockModule(
    '../public/scripts/extensions/regex/engine.js',
    () => ({
        getRegexedString: (value) => value,
        regex_placement: { REASONING: 'reasoning' },
    }),
);
jest.unstable_mockModule('../public/scripts/macros/macro-system.js', () => ({
    MacroCategory: {},
    macros: {},
}));
jest.unstable_mockModule('../public/scripts/preset-manager.js', () => ({
    getPresetManager: () => ({}),
}));
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandParser.js',
    () => ({ SlashCommandParser: class SlashCommandParser {} }),
);
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
    '../public/scripts/slash-commands/SlashCommandEnumValue.js',
    () => ({
        enumTypes: {},
        SlashCommandEnumValue: class SlashCommandEnumValue {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js',
    () => ({ commonEnumProviders: {}, enumIcons: {} }),
);
jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    callGenericPopup: jest.fn(),
    Popup: class Popup {},
    POPUP_RESULT: {},
    POPUP_TYPE: {},
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    getCurrentLocale: () => 'en',
    t: (strings) => (Array.isArray(strings) ? strings.join('') : strings),
    translate: jest.fn(async (value) => value),
}));
jest.unstable_mockModule('../public/scripts/tool-calling.js', () => ({
    ToolManager: class ToolManager {
        static parseToolCalls() {}
    },
}));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: {},
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    COMETAPI_IGNORE_PATTERNS: [],
    IGNORE_SYMBOL: Symbol('ignore'),
    MEDIA_DISPLAY: {},
    MEDIA_TYPE: {},
}));
jest.unstable_mockModule('../public/scripts/textgen-models.js', () => ({
    syncNanoGptProvidersForModel: jest.fn(),
    syncOpenRouterProvidersForModel: jest.fn(),
    updateNanoGptProvidersWarning: jest.fn(),
    updateOpenRouterProvidersWarning: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgen_types: { OPENROUTER: 'openrouter', OLLAMA: 'ollama' },
    textgenerationwebui_settings: { type: null },
}));
jest.unstable_mockModule('../public/scripts/util/stream-fadein.js', () => ({
    applyStreamFadeIn: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/prompt-wrappers.js', () => ({
    wrapPromptWrapperContent: (value) => value,
}));

/** @type {import('../public/scripts/openai.js')} */
let openai;
/** @type {import('../public/scripts/reasoning.js')} */
let reasoning;
/** @type {import('../public/script.js')} */
let script;

beforeAll(async () => {
    script = await import('../public/script.js');
    openai = await import('../public/scripts/openai.js');
    reasoning = await import('../public/scripts/reasoning.js');
});

beforeEach(() => {
    script.chat.length = 0;
    openai.oai_settings.chat_completion_source =
		openai.chat_completion_sources.OPENROUTER;
    openai.oai_settings.show_thoughts = true;
});

function makeState() {
    return {
        reasoning: '',
        images: [],
        signature: '',
        reasoningDetails: [],
        toolSignatures: {},
        finishReason: null,
    };
}

function accumulateReply(chunks) {
    const state = makeState();
    let content = '';
    for (const chunk of chunks) {
        content += openai.getStreamingReply(chunk, state, {
            chatCompletionSource: openai.chat_completion_sources.OPENROUTER,
        });
    }
    return { content, state };
}

function accumulateStreamingLoopState(chunks) {
    const state = makeState();
    let content = '';
    for (const chunk of chunks) {
        const finishReason = chunk.choices?.[0]?.finish_reason ?? null;
        if (finishReason) {
            state.finishReason = finishReason;
        }
        content += openai.getStreamingReply(chunk, state, {
            chatCompletionSource: openai.chat_completion_sources.OPENROUTER,
        });
    }
    return { content, state };
}

describe('OpenRouter Chat Completion streaming reasoning parsing', () => {
    test('accumulates reasoning-only chunks separately while content remains empty', () => {
        const { content, state } = accumulateReply(fixtures.streamingReasoningOnly);

        expect(content).toBe('');
        expect(state.reasoning).toBe('Think step 1. Think step 2.');
    });

    test('accumulates content-only chunks while reasoning remains empty', () => {
        const { content, state } = accumulateReply(fixtures.streamingContentOnly);

        expect(content).toBe('Final answer.');
        expect(state.reasoning).toBe('');
    });

    test('tracks final stop finishReason in streaming loop state', () => {
        const { content, state } = accumulateStreamingLoopState(
            fixtures.streamingContentOnly,
        );

        expect(content).toBe('Final answer.');
        expect(state.finishReason).toBe('stop');
    });

    test('tracks tool_calls finishReason in streaming loop state', () => {
        const { content, state } = accumulateStreamingLoopState(
            fixtures.streamingToolCalls,
        );

        expect(content).toBe('');
        expect(state.finishReason).toBe('tool_calls');
    });

    test('keeps interleaved reasoning and final content separate', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingInterleavedReasoningContent,
        );

        expect(state.reasoning).toBe('Analyze facts. Choose response.');
        expect(content).toBe('Visible reply.');
    });

    test('keeps reasoning and content separate when both fields arrive in one chunk', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingReasoningAndContentSameChunk,
        );

        expect(state.reasoning).toBe('Private thought.');
        expect(content).toBe('Public answer.');
    });

    test('captures encrypted reasoning signatures without mixing them into text', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingEncryptedReasoningDetails,
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe('');
        expect(state.signature).toBe('encrypted-reasoning-signature');
        expect(state.toolSignatures.call_search).toBe('encrypted-tool-signature');
    });

    test('preserves raw reasoning_details for OpenRouter continuation echo', () => {
        const { state } = accumulateReply(
            fixtures.streamingEncryptedReasoningDetails,
        );

        expect(state.reasoningDetails).toEqual([
            {
                type: 'reasoning.encrypted',
                id: 'reasoning-1',
                data: 'encrypted-reasoning-signature',
            },
            {
                type: 'reasoning.encrypted',
                id: 'call_search',
                data: 'encrypted-tool-signature',
            },
        ]);
    });

    test('captures reasoning summary details as reasoning text', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingSummaryReasoningDetails,
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe(
            'Used the provided facts to plan a concise answer.',
        );
    });

    test('does not duplicate reasoning_details when plaintext reasoning is present', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingDuplicatePlaintextReasoningDetails,
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe('Choose tool. Read result.');
    });

    test('uses reasoning_details when plaintext reasoning fields are blank', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingBlankPlaintextReasoningDetails,
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe('Fallback detail text.Fallback summary.');
    });

    test('does not parse final usage-only chunk as content or reasoning', () => {
        const state = makeState();
        const content = openai.getStreamingReply(fixtures.finalUsageChunk, state, {
            chatCompletionSource: openai.chat_completion_sources.OPENROUTER,
        });

        expect(content).toBe('');
        expect(state.reasoning).toBe('');
        expect(state.images).toEqual([]);
    });

    test('mid-stream error chunk does not create phantom content or reasoning', () => {
        const state = makeState();
        const content = openai.getStreamingReply(
            fixtures.midStreamErrorChunk,
            state,
            { chatCompletionSource: openai.chat_completion_sources.OPENROUTER },
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe('');
    });

    test('extracts alternative delta.reasoning_content field as reasoning', () => {
        const { content, state } = accumulateReply(
            fixtures.streamingReasoningContentAlternative,
        );

        expect(content).toBe('');
        expect(state.reasoning).toBe('Alternative reasoning field.');
    });

    test('captures OpenRouter image deltas in state.images', () => {
        const { content, state } = accumulateReply(fixtures.streamingImages);

        expect(content).toBe('');
        expect(state.reasoning).toBe('');
        expect(state.images).toEqual(['data:image/png;base64,aW1hZ2U=']);
    });

    test('extracts non-streaming message.reasoning and message.content separately', () => {
        const state = makeState();
        const content = openai.getStreamingReply(
            fixtures.nonStreamingFullResponse,
            state,
            { chatCompletionSource: openai.chat_completion_sources.OPENROUTER },
        );

        expect(content).toBe('Full public answer.');
        expect(state.reasoning).toBe('Full private reasoning.');
        expect(state.signature).toBe('nonstream-signature');
    });

    test('does not double-count non-streaming message.reasoning and reasoning_details', () => {
        const extractedReasoning = reasoning.extractReasoningFromData(
            fixtures.nonStreamingReasoningWithDetails,
            {
                mainApi: 'openai',
                ignoreShowThoughts: true,
                chatCompletionSource: openai.chat_completion_sources.OPENROUTER,
            },
        );

        expect(extractedReasoning).toBe('Plain non-streaming reasoning.');
    });

    test('stores chronological reasoning and tool trace segments without duplicating reasoning', () => {
        script.chat.push({
            mes: '',
            gen_started: new Date().toISOString(),
            extra: {},
        });

        const handler = new reasoning.ReasoningHandler();
        handler.updateDom = jest.fn();

        handler.updateReasoning(0, 'Thinking A');
        handler.appendProcessingTrace(
            0,
            '<div class="tool-call-trace">Tool 1</div>',
        );
        handler.updateReasoning(0, 'Thinking B');
        handler.appendProcessingTrace(
            0,
            '<div class="tool-call-trace">Tool 2</div>',
        );
        handler.updateReasoning(0, 'Thinking C', { persist: true });

        expect(script.chat[0].extra.processing_segments).toEqual([
            { type: 'reasoning', content: 'Thinking A' },
            { type: 'trace', content: '<div class="tool-call-trace">Tool 1</div>' },
            { type: 'reasoning', content: 'Thinking B' },
            { type: 'trace', content: '<div class="tool-call-trace">Tool 2</div>' },
            { type: 'reasoning', content: 'Thinking C' },
        ]);
        expect(script.chat[0].extra.reasoning).toBe(
            'Thinking A\n\nThinking B\n\nThinking C',
        );
        expect(script.chat[0].extra.processing_trace).toBe(
            [
                '<div class="tool-call-trace">Tool 1</div>',
                '<div class="tool-call-trace">Tool 2</div>',
            ].join('\n\n'),
        );
    });

    test('getJoinedReasoning joins only reasoning segments and ignores traces', () => {
        const extra = {
            processing_segments: [
                { type: 'reasoning', content: 'Thinking A' },
                { type: 'trace', content: '<div class="tool-call-trace">Tool 1</div>' },
                { type: 'reasoning', content: 'Thinking B' },
                { type: 'trace', content: '<div class="tool-call-trace">Tool 2</div>' },
            ],
        };

        /** @type {any} */
        const ReasoningHandler = reasoning.ReasoningHandler;

        expect(ReasoningHandler.getJoinedReasoning(extra)).toBe(
            'Thinking A\n\nThinking B',
        );
    });

    test('upsertReasoningSegment replaces trailing reasoning and appends after trace', () => {
        const extra = { processing_segments: [] };
        /** @type {any} */
        const ReasoningHandler = reasoning.ReasoningHandler;

        ReasoningHandler.upsertReasoningSegment(extra, 'Thinking A');
        ReasoningHandler.upsertReasoningSegment(extra, 'Thinking A updated');
        ReasoningHandler.appendTraceSegment(
            extra,
            '<div class="tool-call-trace">Tool</div>',
        );
        ReasoningHandler.upsertReasoningSegment(extra, 'Thinking B');

        expect(extra.processing_segments).toEqual([
            { type: 'reasoning', content: 'Thinking A updated' },
            { type: 'trace', content: '<div class="tool-call-trace">Tool</div>' },
            { type: 'reasoning', content: 'Thinking B' },
        ]);
    });

    test('appendTraceSegment always appends trace segments', () => {
        const extra = {
            processing_segments: [{ type: 'reasoning', content: 'Thinking A' }],
        };
        /** @type {any} */
        const ReasoningHandler = reasoning.ReasoningHandler;

        ReasoningHandler.appendTraceSegment(
            extra,
            '<div class="tool-call-trace">Tool 1</div>',
        );
        ReasoningHandler.appendTraceSegment(
            extra,
            '<div class="tool-call-trace">Tool 2</div>',
        );

        expect(extra.processing_segments).toEqual([
            { type: 'reasoning', content: 'Thinking A' },
            { type: 'trace', content: '<div class="tool-call-trace">Tool 1</div>' },
            { type: 'trace', content: '<div class="tool-call-trace">Tool 2</div>' },
        ]);
    });

    test('replaces segment-backed reasoning with manual reasoning and clears trace state', () => {
        const extra = {
            processing_segments: [
                { type: 'reasoning', content: 'Old A' },
                { type: 'trace', content: '<div class="tool-call-trace">Tool</div>' },
                { type: 'reasoning', content: 'Old B' },
            ],
            processing_trace: '<div class="tool-call-trace">Tool</div>',
            isProcessingMessage: true,
            _movedReasoning: true,
        };

        /** @type {any} */
        const ReasoningHandler = reasoning.ReasoningHandler;
        ReasoningHandler.setReasoningSegments(extra, 'Edited reasoning');

        expect(extra.processing_segments).toEqual([
            { type: 'reasoning', content: 'Edited reasoning' },
        ]);
        expect(extra.processing_trace).toBeUndefined();
        expect(extra.isProcessingMessage).toBeUndefined();
        expect(extra._movedReasoning).toBeUndefined();

        ReasoningHandler.setReasoningSegments(extra, '');

        expect(extra.processing_segments).toBeUndefined();
    });

    test('renders hidden segment-backed reasoning and traces chronologically', () => {
        script.chat.push({
            mes: '',
            gen_started: new Date().toISOString(),
            extra: {
                reasoning_duration: 1,
                processing_segments: [
                    { type: 'reasoning', content: 'Hidden A' },
                    { type: 'trace', content: '<div class="tool-call-trace">Tool</div>' },
                    { type: 'reasoning', content: 'Hidden B' },
                ],
            },
        });

        let renderedContent = null;
        const reasoningContent = {
            replaceChildren: jest.fn((value) => {
                renderedContent = value;
            }),
        };
        const reasoningDetails = { open: true };
        const reasoningHeader = { textContent: '', title: '' };
        const addButton = { title: '' };
        const messageDom = {
            classList: { toggle: jest.fn() },
            getAttribute: () => '0',
            querySelector: jest.fn((selector) => {
                if (selector === '.mes_reasoning_details') return reasoningDetails;
                if (selector === '.mes_reasoning') return reasoningContent;
                if (selector === '.mes_reasoning_header_title') return reasoningHeader;
                if (selector === '.mes_edit_add_reasoning') return addButton;
                return null;
            }),
        };
        const originalDocument = global.document;
        global.document = {
            querySelector: jest.fn(() => messageDom),
            createRange: () => ({
                createContextualFragment: (value) => value,
            }),
        };

        try {
            const handler = new reasoning.ReasoningHandler();
            handler.initHandleMessage(0);
        } finally {
            global.document = originalDocument;
        }

        expect(renderedContent).toBe(
            'Hidden A\n\n<div class="tool-call-trace">Tool</div>\n\nHidden B',
        );
        expect(renderedContent).not.toBe(
            'Hidden A\n\nHidden B\n\n<div class="tool-call-trace">Tool</div>',
        );
    });
});
