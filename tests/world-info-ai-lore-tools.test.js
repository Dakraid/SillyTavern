import {
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

const chatMetadata = {};
const chat = [];
const eventSource = {
    emit: jest.fn(async () => {}),
    on: jest.fn(),
};
const saveMetadata = jest.fn(async () => {});

const chain = {
    val: jest.fn(() => chain),
    prop: jest.fn(() => chain),
    empty: jest.fn(() => chain),
    append: jest.fn(() => chain),
    trigger: jest.fn(() => chain),
    on: jest.fn(() => chain),
    off: jest.fn(() => chain),
    closest: jest.fn(() => chain),
    toggle: jest.fn(() => chain),
    toggleClass: jest.fn(() => chain),
    find: jest.fn(() => chain),
    data: jest.fn(() => undefined),
    attr: jest.fn(() => chain),
    removeAttr: jest.fn(() => chain),
    text: jest.fn(() => chain),
    html: jest.fn(() => chain),
    show: jest.fn(() => chain),
    hide: jest.fn(() => chain),
    is: jest.fn(() => false),
};

global.$ = jest.fn(() => chain);
global.toastr = global.toastr ?? {
    info: jest.fn(),
    warning: jest.fn(),
    error: jest.fn(),
    clear: jest.fn(),
};

jest.unstable_mockModule('../public/lib.js', () => ({
    DOMPurify: { sanitize: (value) => value },
    Fuse: class Fuse {
        constructor() {}
        search() {
            return [];
        }
    },
}));

jest.unstable_mockModule('../public/script.js', () => ({
    addOneMessage: jest.fn(),
    amount_gen: 0,
    characters: [],
    chat,
    chat_metadata: chatMetadata,
    create_save: jest.fn(),
    createOrEditCharacter: jest.fn(),
    eventSource,
    event_types: {
        WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
        WORLD_INFO_ACTIVATED: 'world_info_activated',
    },
    extension_prompt_roles: {},
    getCurrentChatId: () => 'chat-id',
    getExtensionPromptByName: jest.fn(),
    getGeneratingApi: () => 'openai',
    getGeneratingModel: () => 'test-model',
    getOneCharacter: jest.fn(),
    getRequestHeaders: () => ({}),
    main_api: 'openai',
    max_context: 4096,
    menu_type: {},
    name1: 'User',
    saveCharacterDebounced: jest.fn(),
    saveChatConditional: jest.fn(),
    saveMetadata,
    saveSettings: jest.fn(),
    select_selected_character: jest.fn(),
    substituteParams: (value) => value,
    system_avatar: 'img/ai4.png',
    systemUserName: 'System',
    this_chid: null,
}));

jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    PAGINATION_TEMPLATE: '',
    addLongPressEvent: jest.fn(),
    cancelDebounce: jest.fn(),
    checkOverwriteExistingData: jest.fn(),
    clearInfoBlock: jest.fn(),
    debounce: (fn) => fn,
    download: jest.fn(),
    dynamicSelect2DataViaAjax: jest.fn(),
    equalsIgnoreCaseAndAccents: (a, b) =>
        String(a).toLowerCase() === String(b).toLowerCase(),
    escapeHtml: (value) => String(value),
    escapeRegex: (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    extractDataFromPng: jest.fn(),
    findChar: jest.fn(),
    flashHighlight: jest.fn(),
    getCharaFilename: jest.fn(),
    getFileBuffer: jest.fn(),
    getSanitizedFilename: (value) => String(value),
    getSelect2OptionId: jest.fn(),
    getSortableDelay: () => 0,
    getStringHash: (value) => String(value).length,
    getUniqueName: (name) => name,
    highlightRegex: jest.fn(),
    initScrollHeight: jest.fn(),
    isFalseBoolean: (value) => value === false || value === 'false',
    isTrueBoolean: (value) => value === true || value === 'true',
    logSlashCommandWarn: jest.fn(),
    navigation_option: { none: 'none' },
    normalizeArray: (value) =>
        Array.isArray(value) ? value : [value].filter(Boolean),
    onlyUnique: (value, index, array) => array.indexOf(value) === index,
    parseJsonFile: jest.fn(),
    parseStringArray: (value) =>
        Array.isArray(value) ? value : String(value).split(','),
    resetScrollHeight: jest.fn(),
    select2ChoiceClickSubscribe: jest.fn(),
    select2ModifyOptions: jest.fn(),
    setInfoBlock: jest.fn(),
    setValueByPath: jest.fn(),
    uuidv4: () => 'uuid',
    waitUntilCondition: jest.fn(async () => true),
}));

jest.unstable_mockModule('../public/scripts/extensions.js', () => ({
    extension_settings: {},
    getContext: () => ({ chat }),
}));
jest.unstable_mockModule('../public/scripts/authors-note.js', () => ({
    NOTE_MODULE_NAME: 'authors-note',
    metadata_keys: {},
    shouldWIAddPrompt: () => false,
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    isMobile: () => false,
}));
jest.unstable_mockModule('../public/scripts/filters.js', () => ({
    FILTER_TYPES: { WORLD_INFO_SEARCH: 'world_info_search' },
    FilterHelper: class FilterHelper {
        constructor() {}
        setFilterData() {}
        getFilters() {
            return {};
        }
    },
}));
jest.unstable_mockModule('../public/scripts/tokenizers.js', () => ({
    getTokenCountAsync: async () => 0,
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    power_user: {},
}));
jest.unstable_mockModule('../public/scripts/action-loader.js', () => ({
    ActionLoaderToastMode: {},
    hideActionLoader: jest.fn(),
    showActionLoader: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    getTagKeyForEntity: () => '',
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({
    GENERATION_TYPE_TRIGGERS: {},
    debounce_timeout: { relaxed: 0 },
}));
jest.unstable_mockModule('../public/scripts/openai.js', () => ({
    chat_completion_sources: {},
    custom_prompt_post_processing_types: {},
    getChatCompletionModel: () => 'test-model',
    model_list: [],
    oai_settings: { function_calling: true },
}));
jest.unstable_mockModule('../public/scripts/textgen-settings.js', () => ({
    textgenerationwebui_settings: {},
}));
jest.unstable_mockModule(
    '../public/scripts/extensions/regex/engine.js',
    () => ({
        getRegexedString: (value) => value,
        regex_placement: {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandParser.js',
    () => ({
        SlashCommandParser: { addCommandObject: jest.fn() },
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommand.js',
    () => ({
        SlashCommand: { fromProps: (props) => props },
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandArgument.js',
    () => ({
        ARGUMENT_TYPE: {},
        SlashCommandArgument: { fromProps: (props) => props },
        SlashCommandNamedArgument: { fromProps: (props) => props },
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandEnumValue.js',
    () => ({
        SlashCommandEnumValue: class SlashCommandEnumValue {},
        enumTypes: {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandCommonEnumsProvider.js',
    () => ({
        commonEnumProviders: {},
        enumIcons: {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandClosure.js',
    () => ({
        SlashCommandClosure: class SlashCommandClosure {},
    }),
);
jest.unstable_mockModule(
    '../public/scripts/slash-commands/SlashCommandReturnHelper.js',
    () => ({
        slashCommandReturnHelper: { doReturn: (value) => value },
    }),
);
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: {},
    Popup: { show: { input: jest.fn() } },
    callGenericPopup: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/templates.js', () => ({
    renderTemplateAsync: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({
    t: (strings, ...values) => String.raw({ raw: strings }, ...values),
}));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({
    accountStorage: { getItem: jest.fn(), setItem: jest.fn() },
}));
jest.unstable_mockModule('../public/scripts/personas.js', () => ({
    getOrCreatePersonaDescriptor: jest.fn(),
    setPersonaDescription: jest.fn(),
    user_avatar: 'user.png',
}));

/** @type {typeof import('../public/scripts/tool-calling.js').ToolManager} */
let ToolManager;
/** @type {typeof import('../public/scripts/world-info.js')} */
let WorldInfo;

function toolNames() {
    return ToolManager.tools.map((tool) => tool.toFunctionOpenAI().function.name);
}

async function invoke(name, args) {
    const result = await ToolManager.invokeFunctionTool(
        name,
        JSON.stringify(args),
    );
    expect(result).not.toBeInstanceOf(Error);
    return JSON.parse(result);
}

beforeAll(async () => {
    ({ ToolManager } = await import('../public/scripts/tool-calling.js'));
    WorldInfo = await import('../public/scripts/world-info.js');
    WorldInfo.__registerAIManagedLoreToolsForTesting();
});

beforeEach(() => {
    chat.length = 3;
    chatMetadata.aiManagedLore = {};
    eventSource.emit.mockClear();
    saveMetadata.mockClear();
    WorldInfo.worldInfoCache.clear();
    WorldInfo.worldInfoCache.set('Book', {
        aiManagedEnabled: true,
        aiManagedDirectAccess: false,
        entries: {
            1: {
                uid: 1,
                aiFunctionName: 'dragon',
                aiDescription: 'Dragon lore',
                aiAutoUnload: 4,
                content: 'Dragon content',
                comment: 'Dragon Entry',
            },
            2: {
                uid: 2,
                aiFunctionName: 'castle',
                aiDescription: 'Castle lore',
                content: 'Castle content',
                comment: 'Castle Entry',
            },
        },
    });
});

describe('AI-managed lorebook tools', () => {
    test('list_lore_entries includes loaded state and remainingTurns', async () => {
        chatMetadata.aiManagedLore['Book::1'] = { loadedAt: 1, autoUnload: 3 };

        const list = await invoke('list_lore_entries', {});

        expect(list).toEqual([
            expect.objectContaining({
                name: 'Book::dragon',
                lorebook: 'Book',
                uid: 1,
                loaded: true,
                remainingTurns: 3,
            }),
            expect.objectContaining({
                name: 'Book::castle',
                lorebook: 'Book',
                uid: 2,
                loaded: false,
                remainingTurns: 0,
            }),
        ]);
    });

    test('load_lore_entries accepts arrays and reports per-name partial success', async () => {
        const result = await invoke('load_lore_entries', {
            names: ['Book::dragon', 'Book::missing'],
        });

        expect(result.results).toEqual([
            { name: 'Book::dragon', success: true },
            {
                name: 'Book::missing',
                success: false,
                error: 'Lore entry not found or ambiguous: Book::missing',
            },
        ]);
        expect(chatMetadata.aiManagedLore['Book::1']).toEqual({
            loadedAt: 3,
            autoUnload: 4,
        });
        expect(eventSource.emit).toHaveBeenCalledWith('worldinfo_force_activate', [
            expect.objectContaining({ uid: 1, world: 'Book' }),
        ]);
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });

    test('unload_lore_entries accepts arrays and reports per-name partial success', async () => {
        chatMetadata.aiManagedLore['Book::1'] = { loadedAt: 1, autoUnload: 3 };

        const result = await invoke('unload_lore_entries', {
            names: ['Book::dragon', 'Book::missing'],
        });

        expect(result.results).toEqual([
            { name: 'Book::dragon', success: true },
            {
                name: 'Book::missing',
                success: false,
                error: 'Lore entry not found or ambiguous: Book::missing',
            },
        ]);
        expect(chatMetadata.aiManagedLore).not.toHaveProperty('Book::1');
        expect(saveMetadata).toHaveBeenCalledTimes(1);
    });

    test('direct access tool names disambiguate duplicate slugs and built-in collisions', () => {
        WorldInfo.worldInfoCache.clear();
        WorldInfo.worldInfoCache.set('Book', {
            aiManagedEnabled: true,
            aiManagedDirectAccess: true,
            entries: {
                1: { uid: 1, aiFunctionName: 'same name', content: 'one' },
                2: { uid: 2, aiFunctionName: 'same-name', content: 'two' },
            },
        });
        WorldInfo.worldInfoCache.set('', {
            aiManagedEnabled: true,
            aiManagedDirectAccess: true,
            entries: {
                3: {
                    uid: 3,
                    aiFunctionName: 'loaded_lore_entries',
                    content: 'built-in collision',
                },
            },
        });

        const consoleWarnSpy = jest
            .spyOn(console, 'warn')
            .mockImplementation(() => {});
        try {
            WorldInfo.refreshDirectAccessTools();
            expect(consoleWarnSpy).toHaveBeenCalledWith(
                '[WI] Direct-access lorebook tool names were disambiguated to avoid collisions:',
                [
                    'get_book_same_name → get_book_same_name__2',
                    'set_active_book_same_name → set_active_book_same_name__2',
                    'get_loaded_lore_entries → get_loaded_lore_entries__3',
                ],
            );
            const namesAfterFirstRefresh = toolNames().sort();
            expect(namesAfterFirstRefresh).toEqual(
                expect.arrayContaining([
                    'get_book_same_name',
                    'get_book_same_name__2',
                    'set_active_book_same_name',
                    'set_active_book_same_name__2',
                    'get_loaded_lore_entries__3',
                ]),
            );

            WorldInfo.refreshDirectAccessTools();
            expect(toolNames().sort()).toEqual(namesAfterFirstRefresh);
        } finally {
            consoleWarnSpy.mockRestore();
        }
    });
});
