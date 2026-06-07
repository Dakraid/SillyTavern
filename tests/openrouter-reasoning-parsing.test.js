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

beforeAll(async () => {
    openai = await import('../public/scripts/openai.js');
    reasoning = await import('../public/scripts/reasoning.js');
});

beforeEach(() => {
    openai.oai_settings.chat_completion_source =
		openai.chat_completion_sources.OPENROUTER;
    openai.oai_settings.show_thoughts = true;
});

function makeState() {
    return { reasoning: '', images: [], signature: '', toolSignatures: {} };
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
});
