import { jest } from '@jest/globals';

import {
    applyPromptBulkOperation,
    calculatePromptOrderRenumber,
    cleanupPersistedPromptWrapperMessage,
    cleanupPersistedPromptWrapperSlot,
    createPromptBulkUpdates,
    ensureChatPromptWrapperSettings,
    getChatPromptWrapperOverrideMap,
    getChatPromptWrapperSettings,
    getPromptWrapperDisplayParts,
    getPromptWrapperRole,
    normalizePromptWrapperTag,
    resolvePromptWrapperState,
    resolvePromptWrapperTag,
    stripPromptWrapperTags,
    wrapPromptWrapperContent,
    wrapPromptWrapperText,
} from '../public/scripts/prompt-wrappers.js';

const mockDirectorCharacters = [];
const mockDirectorChat = [];
const mockDirectorEventSource = { on: jest.fn(), once: jest.fn(), emit: jest.fn(async () => {}) };
const mockDirectorConnectionService = {
    validateProfile: jest.fn(() => ({ selected: 'openai', source: {} })),
    sendRequest: jest.fn(),
};
const mockExtensionSettings = {
    connectionManager: { profiles: [{ id: 'profile-1', name: 'Profile 1' }] },
    disabledExtensions: [],
};
const mockSetExtensionPrompt = jest.fn();
const noop = jest.fn();

function createJQueryStub() {
    const chain = {
        length: 0,
        addClass: jest.fn(() => chain),
        append: jest.fn(() => chain),
        attr: jest.fn((...args) => args.length > 1 ? chain : ''),
        children: jest.fn(() => chain),
        clone: jest.fn(() => chain),
        closest: jest.fn(() => chain),
        css: jest.fn((...args) => args.length > 1 ? chain : ''),
        data: jest.fn((...args) => args.length > 1 ? chain : ''),
        each: jest.fn(() => chain),
        empty: jest.fn(() => chain),
        find: jest.fn(() => chain),
        hide: jest.fn(() => chain),
        off: jest.fn(() => chain),
        on: jest.fn(() => chain),
        pagination: jest.fn(() => chain),
        parent: jest.fn(() => chain),
        prop: jest.fn((...args) => args.length > 1 ? chain : false),
        remove: jest.fn(() => chain),
        removeClass: jest.fn(() => chain),
        show: jest.fn(() => chain),
        text: jest.fn(() => chain),
        toggle: jest.fn(() => chain),
        toggleClass: jest.fn(() => chain),
        trigger: jest.fn(() => chain),
        val: jest.fn((...args) => args.length ? chain : ''),
    };
    return chain;
}

global.document = {};
global.CSS = { supports: jest.fn(() => true) };
global.$ = global.jQuery = (value) => {
    if (typeof value === 'function') {
        value();
    }
    return createJQueryStub();
};
global.toastr = { error: noop, success: noop, warning: noop };

jest.unstable_mockModule('../public/lib.js', () => ({ Fuse: jest.fn() }));
jest.unstable_mockModule('../public/scripts/utils.js', () => ({
    PAGINATION_TEMPLATE: '',
    createThumbnail: noop,
    debounce: (fn, delay = 0) => {
        let timeout;
        return function (...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn.apply(this, args), Number(delay) || 0);
        };
    },
    delay: () => Promise.resolve(),
    extractAllWords: value => String(value ?? '').split(/\s+/).filter(Boolean),
    getBase64Async: noop,
    initScrollHeight: noop,
    isDataURL: () => false,
    localizePagination: noop,
    onlyUnique: (value, index, array) => array.indexOf(value) === index,
    paginationDropdownChangeHandler: noop,
    renderPaginationDropdown: noop,
    resetScrollHeight: noop,
    saveBase64AsFile: noop,
    shuffle: array => array,
    uuidv4: () => 'uuid',
    waitUntilCondition: () => Promise.resolve(),
}));
jest.unstable_mockModule('../public/scripts/RossAscends-mods.js', () => ({
    RA_CountCharTokens: () => 0,
    dragElement: noop,
    favsToHotswap: [],
    getMessageTimeStamp: () => '',
    humanizedDateTime: () => '',
}));
jest.unstable_mockModule('../public/scripts/power-user.js', () => ({
    loadMovingUIState: noop,
    power_user: {},
    sortEntitiesList: value => value,
}));
jest.unstable_mockModule('../public/scripts/constants.js', () => ({ debounce_timeout: { quick: 1 } }));
jest.unstable_mockModule('../public/script.js', () => ({
    Generate: noop,
    activateSendButtons: noop,
    addOneMessage: noop,
    animation_duration: 0,
    baseChatReplace: noop,
    cancelTtsPlay: noop,
    characters: mockDirectorCharacters,
    chat: mockDirectorChat,
    chatElement: {},
    chat_metadata: {},
    clearChat: noop,
    createLazyFields: noop,
    deactivateSendButtons: noop,
    default_avatar: '',
    deleteLastMessage: noop,
    depth_prompt_depth_default: 4,
    depth_prompt_role_default: 0,
    displayPastChats: noop,
    ensureMessageMediaIsArray: noop,
    eventSource: mockDirectorEventSource,
    event_types: { MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPE_DELETED: 'message_swipe_deleted', MESSAGE_UPDATED: 'message_updated', GENERATION_STOPPED: 'generation_stopped' },
    extension_prompt_roles: { SYSTEM: 0, USER: 1, ASSISTANT: 2 },
    extension_prompt_types: { NONE: -1, IN_PROMPT: 0, IN_CHAT: 1, BEFORE_PROMPT: 2 },
    getBiasStrings: () => '',
    getCharacters: () => mockDirectorCharacters,
    getCurrentChatId: () => 'chat-id',
    getCurrentVersion: () => 'test',
    getExtensionPromptRoleByName: () => 0,
    getRequestHeaders: () => ({}),
    getThumbnailUrl: value => value,
    hideSwipeButtons: noop,
    isChatSaving: false,
    is_send_press: false,
    loadItemizedPrompts: noop,
    menu_type: {},
    online_status: '',
    printMessages: noop,
    resetChatState: noop,
    saveChatConditional: noop,
    selectRightMenuWithAnimation: noop,
    select_rm_info: {},
    select_selected_character: noop,
    sendMessageAsUser: noop,
    sendSystemMessage: noop,
    setCharacterId: noop,
    setCharacterName: noop,
    setCharacterSettingsOverrides: noop,
    setEditedMessageId: noop,
    setExternalAbortController: noop,
    setExtensionPrompt: mockSetExtensionPrompt,
    setMenuType: noop,
    setSendButtonState: noop,
    shouldAutoContinue: () => false,
    showIntegrityDiffPopup: noop,
    showSwipeButtons: noop,
    substituteParams: value => value,
    syncActiveChatPromptWrapperSettings: () => ({ changed: false }),
    system_avatar: '',
    system_message_types: {},
    talkativeness_default: 0,
    unshallowCharacter: noop,
    updateChatMetadata: noop,
}));
jest.unstable_mockModule('../public/scripts/tags.js', () => ({
    applyTagsOnCharacterSelect: noop,
    applyTagsOnGroupSelect: noop,
    createTagMapFromList: () => new Map(),
    printTagFilters: noop,
    printTagList: noop,
    tag_filter_type: {},
    tag_map: {},
}));
jest.unstable_mockModule('../public/scripts/filters.js', () => ({
    FILTER_TYPES: {},
    FilterHelper: jest.fn(() => ({ applyFilters: value => value, clearFuzzySearchCaches: jest.fn() })),
}));
jest.unstable_mockModule('../public/scripts/chats.js', () => ({ isExternalMediaAllowed: () => true }));
jest.unstable_mockModule('../public/scripts/popup.js', () => ({
    POPUP_RESULT: {},
    POPUP_TYPE: {},
    Popup: jest.fn(),
    callGenericPopup: noop,
}));
jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ extension_settings: mockExtensionSettings }));
jest.unstable_mockModule('../public/scripts/extensions/shared.js', () => ({ ConnectionManagerRequestService: mockDirectorConnectionService }));
jest.unstable_mockModule('../public/scripts/i18n.js', () => ({ t: strings => Array.isArray(strings) ? strings.join('') : String(strings) }));
jest.unstable_mockModule('../public/scripts/util/AccountStorage.js', () => ({ accountStorage: { getItem: jest.fn(() => null), setItem: jest.fn() } }));
jest.unstable_mockModule('../public/scripts/request-compression.js', () => ({ compressRequest: value => value }));

const directorModulePromise = import('../public/scripts/group-chats.js');
let directorHelpers;

beforeAll(async () => {
    directorHelpers = await directorModulePromise;
});

describe('prompt wrappers', () => {
    test('escapes unsafe angle brackets but preserves spaces and symbols', () => {
        expect(normalizePromptWrapperTag('Dr. Bob!')).toBe('Dr. Bob!');
        expect(normalizePromptWrapperTag('A<B>C')).toBe('A&lt;B&gt;C');
        expect(normalizePromptWrapperTag('   ')).toBe('Unknown');
    });

    test('ephemerally wraps content once for prompt payloads', () => {
        const state = resolvePromptWrapperState({ enabled: true, tag: 'Alice' });
        expect(wrapPromptWrapperContent('<Alice>Hello</Alice></Alice>', state)).toBe('<Alice>Hello</Alice>');
        expect(wrapPromptWrapperContent('Hello', { enabled: false, tag: 'Alice' })).toBe('Hello');
    });

    test('builds display-only tag parts without wrapping content', () => {
        expect(getPromptWrapperDisplayParts({ enabled: false, tag: 'Alice' })).toBeNull();
        expect(getPromptWrapperDisplayParts({ enabled: true, tag: 'A<B>' })).toEqual({
            enabled: true,
            tag: 'A&lt;B&gt;',
            opening: '<A&lt;B&gt;>',
            closing: '</A&lt;B&gt;>',
        });
    });

    test('resolves only user and assistant message roles', () => {
        expect(getPromptWrapperRole({ is_user: true, extra: {} })).toBe('user');
        expect(getPromptWrapperRole({ is_user: false, is_system: false, extra: {} })).toBe('assistant');
        expect(getPromptWrapperRole({ is_user: false, is_system: true, extra: {} })).toBeNull();
        expect(getPromptWrapperRole({ is_user: false, extra: { isSmallSys: true } })).toBeNull();
        expect(getPromptWrapperRole({ is_user: false, extra: { type: 'narrator' } })).toBeNull();
    });

    test('cleanup only removes legacy metadata-managed wrappers', () => {
        const cleaned = cleanupPersistedPromptWrapperSlot('<Alice>changed</Alice>', {
            prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: 'exact <content>', version: 1 },
            keep: true,
        });
        expect(cleaned).toEqual({ text: 'exact <content>', extra: { keep: true }, changed: true });

        const untouched = cleanupPersistedPromptWrapperSlot('<Alice>literal</Alice>', { keep: true });
        expect(untouched).toEqual({ text: '<Alice>literal</Alice>', extra: { keep: true }, changed: false });
    });

    test('legacy same outer tags can still be normalized by pure helpers', () => {
        const wrapped = wrapPromptWrapperText('<Alice><Alice>Hello</Alice></Alice></Alice>', 'Alice');
        expect(wrapped.mes).toBe('<Alice>Hello</Alice>');
        expect(wrapped.base_mes).toBe('Hello');
        expect(stripPromptWrapperTags('<Kris><Kris>Hi</Kris></Kris></Kris>', 'Kris')).toBe('Hi');
    });

    test('cleans metadata-managed legacy wrappers from messages and swipes', () => {
        const message = {
            mes: '<Alice>Answer ends with </xml></Alice>',
            extra: {
                prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: 'Answer ends with </xml>', version: 1 },
                keep: true,
            },
            swipes: ['<Alice>First</Alice>', '<Bob>Second</Bob>', '<Alice>Literal</Alice>'],
            swipe_info: [
                { extra: { prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: 'First', version: 1 }, keepSwipe: 1 } },
                { extra: { prompt_wrapper: { role: 'assistant', tag: 'Bob', base_mes: 'Second', version: 1 } } },
                { extra: { keepUnwrapped: true } },
            ],
        };

        expect(cleanupPersistedPromptWrapperMessage(message)).toBe(3);
        expect(message).toEqual({
            mes: 'Answer ends with </xml>',
            extra: { keep: true },
            swipes: ['First', 'Second', '<Alice>Literal</Alice>'],
            swipe_info: [
                { extra: { keepSwipe: 1 } },
                { extra: {} },
                { extra: { keepUnwrapped: true } },
            ],
        });
    });

    test('cleans legacy wrappers while preserving legitimate XML and code from base text', () => {
        const baseMes = '<note>literal</note>\n```xml\n<a/>\n```\nanswer ends with </Example>';
        const message = {
            mes: `<Alice>${baseMes}</Alice>`,
            extra: { prompt_wrapper: { role: 'assistant', tag: 'Alice', base_mes: baseMes, version: 1 } },
        };

        expect(cleanupPersistedPromptWrapperMessage(message)).toBe(1);
        expect(message.mes).toBe(baseMes);
        expect(message.extra).toEqual({});
    });

    test('preserves unmetadataed XML-like message and swipe text exactly', () => {
        const message = {
            mes: '<Alice>literal</Alice>',
            extra: { keep: true },
            swipes: ['answer</Example>', '<note>literal</note>'],
            swipe_info: [{ extra: {} }, { extra: { keep: true } }],
        };

        expect(cleanupPersistedPromptWrapperMessage(message)).toBe(0);
        expect(message).toEqual({
            mes: '<Alice>literal</Alice>',
            extra: { keep: true },
            swipes: ['answer</Example>', '<note>literal</note>'],
            swipe_info: [{ extra: {} }, { extra: { keep: true } }],
        });
    });

    test('message cleanup returns zero for invalid message-like values', () => {
        expect(cleanupPersistedPromptWrapperMessage(null)).toBe(0);
        expect(cleanupPersistedPromptWrapperMessage(undefined)).toBe(0);
        expect(cleanupPersistedPromptWrapperMessage('text')).toBe(0);
        expect(cleanupPersistedPromptWrapperMessage([])).toBe(0);
    });
});

describe('chat prompt wrapper settings', () => {
    test('reports changed when missing chat metadata is seeded from legacy globals', () => {
        const chatMetadata = {};
        const result = ensureChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: false, chara: { avatar: 'Alice' } } });

        expect(result).toEqual({ settings: { assistant: true, user: false }, changed: true });
        expect(chatMetadata.prompt_wrappers).toBe(result.settings);
        expect(result.settings.chara).toBeUndefined();
    });

    test('reports unchanged for existing valid chat prompt wrapper booleans', () => {
        const settings = { assistant: false, user: true };
        const chatMetadata = { prompt_wrappers: settings };
        const result = ensureChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: false } });

        expect(result).toEqual({ settings: { assistant: false, user: true }, changed: false });
        expect(result.settings).toBe(settings);
    });

    test('reports changed when malformed prompt wrapper settings are normalized', () => {
        const chatMetadata = { prompt_wrappers: { assistant: 'yes', user: undefined, chara: { leaked: true } } };
        const result = ensureChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: false, user: true } });

        expect(result).toEqual({ settings: { assistant: false, user: true }, changed: true });
        expect(chatMetadata.prompt_wrappers).toBe(result.settings);
        expect(result.settings.chara).toBeUndefined();
    });

    test('returns fallback without throwing for invalid chat metadata', () => {
        expect(ensureChatPromptWrapperSettings(null, { wrappers: { assistant: true, user: true } })).toEqual({
            settings: { assistant: true, user: true },
            changed: false,
        });
        expect(ensureChatPromptWrapperSettings([], { wrappers: { assistant: true, user: false } })).toEqual({
            settings: { assistant: true, user: false },
            changed: false,
        });
    });

    test('normalizes active group chat override maps', () => {
        const chatMetadata = { prompt_wrapper_overrides: { 'alice.png': ' Ally ', 'bob.png': '', empty: null } };
        expect(getChatPromptWrapperOverrideMap(chatMetadata)).toEqual({ 'alice.png': 'Ally' });
        expect(getChatPromptWrapperOverrideMap(null)).toEqual({});
    });

    test('resolves assistant tags with group override precedence', () => {
        expect(resolvePromptWrapperTag({
            avatar: 'alice.png',
            groupOverrides: { 'alice.png': 'Group Alice' },
            individualOverrides: { 'alice.png': 'Solo Alice' },
            messageName: 'Message Alice',
            characterName: 'Character Alice',
        })).toBe('Group Alice');

        expect(resolvePromptWrapperTag({
            avatar: 'alice.png',
            groupOverrides: {},
            individualOverrides: { 'alice.png': 'Solo Alice' },
            messageName: 'Message Alice',
        })).toBe('Solo Alice');
    });

    test('seeds missing chat metadata from legacy globals without chara overrides', () => {
        const chatMetadata = {};
        const settings = getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: false, chara: { avatar: 'Alice' } } });

        expect(settings).toEqual({ assistant: true, user: false });
        expect(chatMetadata.prompt_wrappers).toBe(settings);
        expect(settings.chara).toBeUndefined();
    });

    test('preserves existing booleans and fills missing values from legacy globals', () => {
        const chatMetadata = { prompt_wrappers: { assistant: false, chara: { leaked: true } } };
        const settings = getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: true, user: true } });

        expect(settings).toEqual({ assistant: false, user: true });
    });

    test('normalizes malformed chat metadata', () => {
        const chatMetadata = { prompt_wrappers: 'bad' };
        expect(getChatPromptWrapperSettings(chatMetadata, { wrappers: { assistant: false, user: true } })).toEqual({ assistant: false, user: true });
        expect(chatMetadata.prompt_wrappers).toEqual({ assistant: false, user: true });
        expect(getChatPromptWrapperSettings(null, { wrappers: { assistant: true, user: true } })).toEqual({ assistant: true, user: true });
    });
});

describe('prompt manager bulk operations', () => {
    test('supports all approved renumber directions', () => {
        expect(calculatePromptOrderRenumber(4, 10, 'first-inc')).toEqual([10, 11, 12, 13]);
        expect(calculatePromptOrderRenumber(4, 10, 'first-dec')).toEqual([10, 9, 8, 7]);
        expect(calculatePromptOrderRenumber(4, 10, 'last-inc')).toEqual([13, 12, 11, 10]);
        expect(calculatePromptOrderRenumber(4, 10, 'last-dec')).toEqual([7, 8, 9, 10]);
    });

    test('rejects negative, decimal, or resulting negative order values', () => {
        expect(() => calculatePromptOrderRenumber(1, -1, 'first-inc')).toThrow();
        expect(() => calculatePromptOrderRenumber(1, 1.5, 'first-inc')).toThrow();
        expect(() => calculatePromptOrderRenumber(4, 0, 'first-dec')).toThrow();
    });

    test('builds identifier-keyed updates so PromptManager can update stored prompts from stale visible targets', () => {
        const visibleCopies = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];
        const storedPrompts = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];

        const updates = createPromptBulkUpdates(visibleCopies, { operation: 'position-inchat', value: 0, mode: 'first-inc' });
        updates.forEach(update => Object.assign(storedPrompts.find(prompt => prompt.identifier === update.identifier), update));

        expect(visibleCopies.map(prompt => prompt.injection_position)).toEqual([0, 0]);
        expect(storedPrompts.map(prompt => prompt.injection_position)).toEqual([1, 1]);
    });

    test('position-inchat writes render-safe depth and order defaults', () => {
        const prompts = [
            { identifier: 'a', injection_position: 0 },
            { identifier: 'b', injection_position: 0, injection_depth: 0, injection_order: 7 },
        ];

        expect(createPromptBulkUpdates(prompts, { operation: 'position-inchat', value: 0, mode: 'first-inc' }, { relative: 0, inChat: 1, defaultDepth: 4, defaultOrder: 100 })).toEqual([
            { identifier: 'a', injection_position: 1, injection_depth: 4, injection_order: 100 },
            { identifier: 'b', injection_position: 1, injection_depth: 0, injection_order: 7 },
        ]);
    });

    test('mutates visible prompt targets for position, depth, and order operations', () => {
        const prompts = [
            { identifier: 'a', injection_position: 0, injection_depth: 1, injection_order: 10 },
            { identifier: 'b', injection_position: 0, injection_depth: 2, injection_order: 20 },
        ];

        applyPromptBulkOperation(prompts, { operation: 'position-inchat', value: 0, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_position)).toEqual([1, 1]);

        applyPromptBulkOperation(prompts, { operation: 'depth', value: 0, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_depth)).toEqual([0, 0]);

        applyPromptBulkOperation(prompts, { operation: 'order', value: 7, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_order)).toEqual([7, 7]);

        applyPromptBulkOperation(prompts, { operation: 'renumber', value: 3, mode: 'first-inc' });
        expect(prompts.map(prompt => prompt.injection_order)).toEqual([3, 4]);
    });
});

describe('director prompt formatter and filters', () => {
    beforeEach(() => {
        mockDirectorCharacters.length = 0;
        mockDirectorChat.length = 0;
        directorHelpers.groups.splice(0, directorHelpers.groups.length);
        mockDirectorConnectionService.validateProfile.mockClear();
        mockDirectorConnectionService.sendRequest.mockReset();
        mockSetExtensionPrompt.mockReset();
        global.fetch = jest.fn(async url => {
            if (url === '/api/chats/group/get') {
                return { ok: true, json: async () => [{ chat_metadata: { tainted: true, integrity: 'test' } }] };
            }
            return { ok: true, json: async () => ({}) };
        });
    });

    test('formats fenced parser-safe directions and neutralizes injected delimiters and thinking tags', () => {
        mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice <thinker>' });
        const group = {
            members: ['alice.png'],
            director: {
                lastDirections: {
                    summary: 'Advance {{DIRECTOR_START}} quietly',
                    journal: 'Never expose <thinking>hidden</thinking>, <think>private</think>, {{ director_start }}, or {{DIRECTOR_END}}.',
                    queue: ['alice.png'],
                    appliedActions: [{ applied: true, action: { action: 'mute', memberId: 'bob.png' } }],
                },
            },
        };

        const prompt = directorHelpers.formatDirectorDirectionsForPrompt(group);

        expect(prompt.startsWith('{{DIRECTOR_START}}\n')).toBe(true);
        expect(prompt.endsWith('\n{{DIRECTOR_END}}')).toBe(true);
        expect(prompt.match(/\{\{DIRECTOR_START\}\}/g)).toHaveLength(1);
        expect(prompt.match(/\{\{DIRECTOR_END\}\}/g)).toHaveLength(1);
        expect(prompt).toContain('｛｛DIRECTOR_START｝｝ quietly');
        expect(prompt).toContain('｛｛DIRECTOR_START｝｝, or ｛｛DIRECTOR_END｝｝');
        expect(prompt).toContain('＜thinking＞hidden＜/thinking＞');
        expect(prompt).toContain('＜think＞private＜/think＞');
        expect(prompt).not.toContain('<thinking>');
        expect(prompt).not.toContain('<think>');
        expect(prompt).toContain('Alice ＜thinker＞ (alice.png)');
    });

    test('returns empty prompt when directions are absent or contain no content', () => {
        expect(directorHelpers.formatDirectorDirectionsForPrompt({ director: null })).toBe('');
        expect(directorHelpers.formatDirectorDirectionsForPrompt({ director: { lastDirections: { summary: ' ', journal: '', queue: [], appliedActions: [] } } })).toBe('');
    });

    test('refresh uses stable Director prompt key, avoids visible system in-chat injection, and clears stale prompts', async () => {
        const group = {
            id: 'director-prompt-group',
            name: 'Director Prompt Group',
            chat_id: 'director-prompt-chat',
            activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
            members: ['alice.png'],
            disabled_members: [],
            director: {
                enabled: true,
                settings: {
                    promptPlacement: { type: 'in_chat', role: 'system', depth: 3 },
                },
                lastDirections: { summary: 'Stay quiet', journal: '', queue: [], appliedActions: [] },
            },
        };
        directorHelpers.groups.push(group);
        mockSetExtensionPrompt.mockClear();
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        await directorHelpers.openGroupById(group.id);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
        mockSetExtensionPrompt.mockClear();

        expect(directorHelpers.refreshDirectorPromptInjectionForGroup(group)).toBe(true);
        expect(mockSetExtensionPrompt).toHaveBeenLastCalledWith(
            'group_director_directions',
            expect.stringContaining('{{DIRECTOR_START}}'),
            2,
            0,
            false,
            0,
        );

        group.director.lastDirections = null;
        expect(directorHelpers.refreshDirectorPromptInjectionForGroup(group)).toBe(false);
        expect(mockSetExtensionPrompt).toHaveBeenLastCalledWith('group_director_directions', '', -1, 0, false, 0);

        group.director.lastDirections = { summary: 'Back', journal: '', queue: [], appliedActions: [] };
        group.activation_strategy = directorHelpers.group_activation_strategy.NATURAL;
        expect(directorHelpers.refreshDirectorPromptInjectionForGroup(group)).toBe(false);
        expect(mockSetExtensionPrompt).toHaveBeenLastCalledWith('group_director_directions', '', -1, 0, false, 0);
    });

    test('normalizes queue member ids and filters stale group members', () => {
        expect(directorHelpers.normalizeDirectorMemberIdList([' alice ', 'bob', 'alice', '', 3, 'ghost'], new Set(['alice', 'bob']))).toEqual(['alice', 'bob']);
        expect(directorHelpers.normalizeDirectorMemberIdList('alice', new Set(['alice']))).toEqual([]);
        expect(directorHelpers.filterDirectorQueueForMembers(['alice', 'ghost', ' bob ', 'alice'], { members: ['alice', 'bob'] })).toEqual(['alice', 'bob']);
        expect(directorHelpers.filterDirectorQueueForMembers(null, { members: ['alice'] })).toEqual([]);
        expect(directorHelpers.filterDirectorControlledDisabledMembers(['ghost', 'alice', ' alice '], { members: ['alice'] })).toEqual(['alice']);
    });

    test('builds inspector save disabled members without stale Director mutes', () => {
        const group = {
            members: ['alice.png', 'bob.png', 'manual.png'],
            disabled_members: ['stale.png', 'alice.png', 'manual.png'],
        };

        expect(directorHelpers.buildDirectorDisabledMembersForInspectorSave(
            group,
            ['stale.png', 'alice.png'],
            ['bob.png', 'ghost.png'],
        )).toEqual(['manual.png', 'bob.png']);
    });

    test('applies structured Inspector edits through normalized Director state', () => {
        const group = {
            members: ['alice.png', 'bob.png', 'manual.png'],
            disabled_members: ['alice.png', 'manual.png'],
            director: {
                settings: { lookbackDepth: '4' },
                journal: 'old',
                queue: ['alice.png'],
                controlledDisabledMembers: ['alice.png'],
                decisionHistory: [{ timestamp: 'd0' }, { timestamp: 'd1' }],
                decisions: [],
                stateHistory: [{ timestamp: 's0' }, { timestamp: 's1' }],
                lastDirections: { summary: 'old', queue: ['alice.png'] },
            },
        };

        const directorData = directorHelpers.applyDirectorInspectorStateToGroup(group, {
            settings: { lookbackDepth: '2', promptPlacement: { type: 'relative', role: 'system', depth: 1, order: 100 } },
            journal: 'next journal',
            queue: [' bob.png ', 'ghost.png', 'alice.png', 'bob.png', ''],
            controlledDisabledMembers: ['bob.png', 'ghost.png'],
            decisionRemovalIndexes: new Set([0]),
            stateRemovalIndexes: new Set([1]),
        });

        expect(directorData).toBe(group.director);
        expect(directorData.journal).toBe('next journal');
        expect(directorData.queue).toEqual(['bob.png', 'alice.png']);
        expect(directorData.controlledDisabledMembers).toEqual(['bob.png']);
        expect(directorData.decisionHistory).toEqual([{ timestamp: 'd1' }]);
        expect(directorData.decisions).toBe(directorData.decisionHistory);
        expect(directorData.stateHistory).toEqual([{ timestamp: 's0' }]);
        expect(directorData.lastDirections.queue).toEqual(['bob.png', 'alice.png']);
        expect(group.disabled_members).toEqual(['manual.png', 'bob.png']);
    });


    test('filters invalid history records and clears unsafe numeric history when requested', () => {
        const valid = { timestamp: 'keep', messageRefs: [0, 'external-id'] };
        const missingMessage = { timestamp: 'drop-missing', messageRefs: [2] };
        const blankRef = { timestamp: 'drop-blank', messageRef: '   ' };
        const negativeRef = { timestamp: 'drop-negative', messageRef: -1 };
        const nullMessage = { timestamp: 'drop-null-message', messageRef: 2 };
        const unsupportedRef = { timestamp: 'drop-object-ref', messageRef: { id: 'bad' } };
        const chatMessages = [{ mes: 'first' }, { mes: 'second' }, null];

        expect(directorHelpers.filterDirectorHistoryByMessageRefs([valid, missingMessage, blankRef, negativeRef, nullMessage, unsupportedRef, null], chatMessages)).toEqual([valid]);
        expect(directorHelpers.filterDirectorHistoryByMessageRefs([valid], chatMessages, { clearUnsafeNumericRefs: true })).toEqual([]);
        expect(directorHelpers.filterDirectorHistoryByMessageRefs([valid, blankRef], null)).toEqual([valid, blankRef]);
    });

    test('clears decision-derived state when any history uses unsafe numeric refs', () => {
        const group = {
            members: ['alice.png', 'bob.png'],
            director: {
                queue: ['alice.png', 'ghost.png'],
                controlledDisabledMembers: ['bob.png', 'ghost.png'],
                decisionHistory: [{ timestamp: 'decision-1', parsed: { summary: 'old' } }],
                stateHistory: [{ timestamp: 'state-1', messageRefs: [0], state: { queue: ['alice.png'] } }],
                lastDirections: { summary: 'old', queue: ['alice.png'] },
            },
        };

        const changed = directorHelpers.filterDirectorStateForGroup(group, {
            chatMessages: [{ mes: 'after delete' }],
            clearUnsafeNumericRefs: true,
        });

        expect(changed).toBe(true);
        expect(group.director.queue).toEqual(['alice.png']);
        expect(group.director.controlledDisabledMembers).toEqual(['bob.png']);
        expect(group.director.decisionHistory).toEqual([]);
        expect(group.director.decisions).toBe(group.director.decisionHistory);
        expect(group.director.stateHistory).toEqual([]);
        expect(group.director.lastDirections).toBeNull();
    });

    test('recomputes selected Director state after chat mutation and runs Director once', async () => {
        mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice', first_mes: '' });
        mockDirectorChat.push({ mes: 'current' });
        const group = {
            id: 'director-recompute-group',
            name: 'Director Recompute Group',
            chat_id: 'director-recompute-chat',
            activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
            members: ['alice.png'],
            disabled_members: ['ghost.png'],
            director: {
                enabled: true,
                settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                queue: ['ghost.png', 'alice.png'],
                controlledDisabledMembers: ['ghost.png'],
                journal: 'old',
                decisionHistory: [{ timestamp: 'decision-1', messageRefs: [0], parsed: { summary: 'old' } }],
                stateHistory: [{ timestamp: 'state-1', messageRefs: [0], state: { queue: ['ghost.png'] } }],
                lastDirections: { summary: 'old', queue: ['ghost.png'] },
            },
        };
        directorHelpers.groups.push(group);
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        await directorHelpers.openGroupById(group.id);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();

        mockDirectorConnectionService.sendRequest.mockResolvedValueOnce({ content: JSON.stringify({ journal: 'fresh', queue: ['alice.png'], actions: [], summary: 'fresh' }) });
        global.fetch.mockClear();

        await expect(directorHelpers.recomputeDirectorStateAfterChatMutation()).resolves.toBe(true);

        expect(group.director.queue).toEqual(['alice.png']);
        expect(group.director.controlledDisabledMembers).toEqual([]);
        expect(group.disabled_members).toEqual([]);
        expect(group.director.decisionHistory).toHaveLength(1);
        expect(group.director.decisionHistory[0].parsed.summary).toBe('fresh');
        expect(group.director.stateHistory).toHaveLength(1);
        expect(group.director.lastDirections.summary).toBe('fresh');
        expect(mockDirectorConnectionService.sendRequest).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledWith('/api/groups/edit', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(group),
        }));
    });

    test('registers delete and swipe mutation listeners and debounces rapid events', async () => {
        mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice', first_mes: '' });
        mockDirectorChat.push({ mes: 'current' });
        const group = {
            id: 'director-listener-group',
            name: 'Director Listener Group',
            chat_id: 'director-listener-chat',
            activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
            members: ['alice.png'],
            disabled_members: [],
            director: {
                enabled: true,
                settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                queue: [],
                controlledDisabledMembers: [],
                journal: '',
                decisionHistory: [],
                stateHistory: [],
            },
        };
        directorHelpers.groups.push(group);
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        await directorHelpers.openGroupById(group.id);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();

        const deletedRegistration = mockDirectorEventSource.on.mock.calls.find(([eventType]) => eventType === 'message_deleted');
        const swipeDeletedRegistration = mockDirectorEventSource.on.mock.calls.find(([eventType]) => eventType === 'message_swipe_deleted');
        expect(deletedRegistration).toBeDefined();
        expect(swipeDeletedRegistration).toBeDefined();
        expect(typeof deletedRegistration[1]).toBe('function');
        expect(swipeDeletedRegistration[1]).toBe(deletedRegistration[1]);

        mockDirectorConnectionService.sendRequest.mockResolvedValue({ content: JSON.stringify({ journal: 'fresh', queue: ['alice.png'], actions: [], summary: 'fresh' }) });
        global.fetch.mockClear();
        jest.useFakeTimers();

        try {
            deletedRegistration[1]();
            swipeDeletedRegistration[1]();
            deletedRegistration[1]();

            await jest.advanceTimersByTimeAsync(249);
            expect(mockDirectorConnectionService.sendRequest).not.toHaveBeenCalled();

            await jest.advanceTimersByTimeAsync(1);
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();

            expect(mockDirectorConnectionService.sendRequest).toHaveBeenCalledTimes(1);
            expect(group.director.queue).toEqual(['alice.png']);
        } finally {
            jest.useRealTimers();
        }
    });

    test('orders recompute as save, prompt refresh, then optional Director run', async () => {
        mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice', first_mes: '' });
        mockDirectorChat.push({ mes: 'current' });
        const group = {
            id: 'director-order-group',
            name: 'Director Order Group',
            chat_id: 'director-order-chat',
            activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
            members: ['alice.png'],
            disabled_members: ['ghost.png'],
            director: {
                enabled: true,
                settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                queue: ['ghost.png'],
                controlledDisabledMembers: ['ghost.png'],
                journal: 'old',
                decisionHistory: [{ timestamp: 'decision-1', messageRefs: [0], parsed: { summary: 'old' } }],
                stateHistory: [{ timestamp: 'state-1', messageRefs: [0], state: { queue: ['ghost.png'] } }],
                lastDirections: { summary: 'old', queue: ['ghost.png'] },
            },
        };
        directorHelpers.groups.push(group);
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        await directorHelpers.openGroupById(group.id);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();

        const order = [];
        global.fetch = jest.fn(async url => {
            if (url === '/api/groups/edit') {
                order.push(`save:${group.director.queue.join(',') || '(empty)'}`);
            }
            return { ok: true, json: async () => ({}) };
        });
        mockSetExtensionPrompt.mockImplementation((_key, prompt) => {
            order.push(prompt ? 'prompt:set' : 'prompt:clear');
        });
        mockDirectorConnectionService.sendRequest.mockImplementationOnce(() => {
            order.push('director:run');
            return Promise.resolve({ content: JSON.stringify({ journal: 'fresh', queue: ['alice.png'], actions: [], summary: 'fresh' }) });
        });

        await expect(directorHelpers.recomputeDirectorStateAfterChatMutation()).resolves.toBe(true);

        expect(order.slice(0, 3)).toEqual(['save:(empty)', 'prompt:clear', 'director:run']);
        expect(group.director.queue).toEqual(['alice.png']);
        expect(group.director.lastDirections.queue).toEqual(['alice.png']);
        mockSetExtensionPrompt.mockReset();
    });

    test('manual Inspector edit mutates local state without starting a Director run', () => {
        const group = {
            members: ['alice.png'],
            disabled_members: [],
            director: {
                settings: { connectionProfileId: 'profile-1' },
                queue: [],
                controlledDisabledMembers: [],
                journal: '',
                decisionHistory: [],
                stateHistory: [],
            },
        };

        const directorData = directorHelpers.applyDirectorInspectorStateToGroup(group, {
            settings: { connectionProfileId: 'profile-1' },
            journal: 'manual edit',
            queue: ['alice.png'],
            controlledDisabledMembers: [],
        });

        expect(directorData.journal).toBe('manual edit');
        expect(directorData.queue).toEqual(['alice.png']);
        expect(mockDirectorConnectionService.sendRequest).not.toHaveBeenCalled();
    });

    test('queues one recompute after a chat mutation during an active Director run', async () => {
        mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice', first_mes: '' });
        const group = {
            id: 'director-group',
            name: 'Director Group',
            chat_id: 'director-chat',
            activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
            members: ['alice.png'],
            disabled_members: [],
            director: {
                enabled: true,
                settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                queue: [],
                controlledDisabledMembers: [],
                journal: '',
                decisionHistory: [],
                stateHistory: [],
            },
        };
        directorHelpers.groups.push(group);
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
        const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
        await directorHelpers.openGroupById(group.id);
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();

        let resolveFirst;
        let inFlight = 0;
        let maxInFlight = 0;
        const firstResponse = new Promise(resolve => {
            resolveFirst = resolve;
        });
        mockDirectorConnectionService.sendRequest
            .mockImplementationOnce(() => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                return firstResponse.finally(() => {
                    inFlight -= 1;
                });
            })
            .mockImplementationOnce(() => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                inFlight -= 1;
                return Promise.resolve({ content: JSON.stringify({ journal: 'second', queue: ['alice.png'], actions: [], summary: 'second' }) });
            });

        const runPromise = directorHelpers.runDirector(group);
        await Promise.resolve();
        expect(mockDirectorConnectionService.sendRequest).toHaveBeenCalledTimes(1);

        await expect(directorHelpers.recomputeDirectorStateAfterChatMutation()).resolves.toBe(false);
        await expect(directorHelpers.recomputeDirectorStateAfterChatMutation()).resolves.toBe(false);
        resolveFirst({ content: JSON.stringify({ journal: 'first', queue: ['alice.png'], actions: [], summary: 'first' }) });
        await expect(runPromise).resolves.toBe(true);

        expect(mockDirectorConnectionService.sendRequest).toHaveBeenCalledTimes(2);
        expect(group.director.journal).toBe('second');
        expect(maxInFlight).toBe(1);
    });

    test('shows Director status through run lifecycle and ignores stale hide timers', async () => {
        jest.useFakeTimers();

        const originalDollar = global.$;
        const statusState = { text: '', classes: new Set() };
        const statusElement = {
            length: 1,
            addClass: jest.fn(name => {
                String(name).split(/\s+/).filter(Boolean).forEach(value => statusState.classes.add(value));
                return statusElement;
            }),
            removeClass: jest.fn(name => {
                String(name).split(/\s+/).filter(Boolean).forEach(value => statusState.classes.delete(value));
                return statusElement;
            }),
            text: jest.fn(function (value) {
                if (arguments.length === 0) {
                    return statusState.text;
                }
                statusState.text = String(value ?? '');
                return statusElement;
            }),
        };
        global.$ = global.jQuery = value => value === '#director_status' ? statusElement : originalDollar(value);

        try {
            mockDirectorCharacters.push({ avatar: 'alice.png', name: 'Alice', first_mes: '' });
            const group = {
                id: 'director-status-group',
                name: 'Director Status Group',
                chat_id: 'director-status-chat',
                activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
                members: ['alice.png'],
                disabled_members: [],
                director: {
                    enabled: true,
                    settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                    queue: [],
                    controlledDisabledMembers: [],
                    journal: '',
                    decisionHistory: [],
                    stateHistory: [],
                },
            };
            directorHelpers.groups.push(group);
            const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
            const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
            await directorHelpers.openGroupById(group.id);
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();

            mockDirectorConnectionService.sendRequest.mockResolvedValueOnce({ content: JSON.stringify({ journal: 'first', queue: ['alice.png'], actions: [], summary: 'first' }) });
            await expect(directorHelpers.runDirector(group)).resolves.toBe(true);
            expect(statusState.text).toBe('Director queue: Alice');
            expect(statusState.classes.has('preview')).toBe(true);

            let resolveSecond;
            mockDirectorConnectionService.sendRequest.mockImplementationOnce(() => new Promise(resolve => {
                resolveSecond = resolve;
            }));
            const secondRun = directorHelpers.runDirector(group);
            await Promise.resolve();
            expect(statusState.text).toBe('Director working…');
            expect(statusState.classes.has('running')).toBe(true);
            await expect(directorHelpers.runDirector(group)).resolves.toBe(false);
            expect(mockDirectorConnectionService.sendRequest).toHaveBeenCalledTimes(2);

            jest.runOnlyPendingTimers();
            expect(statusState.text).toBe('Director working…');

            resolveSecond({ content: JSON.stringify({ journal: 'second', queue: ['alice.png'], actions: [], summary: 'second' }) });
            await expect(secondRun).resolves.toBe(true);
            expect(statusState.text).toBe('Director queue: Alice');

            jest.advanceTimersByTime(4000);
            expect(statusState.text).toBe('');
            expect(statusState.classes.has('preview')).toBe(false);
        } finally {
            global.$ = global.jQuery = originalDollar;
            jest.useRealTimers();
        }
    });

    test('shows failed Director status and hides it after failed run', async () => {
        jest.useFakeTimers();

        const originalDollar = global.$;
        const statusState = { text: '', classes: new Set() };
        const statusElement = {
            length: 1,
            addClass: jest.fn(name => {
                String(name).split(/\s+/).filter(Boolean).forEach(value => statusState.classes.add(value));
                return statusElement;
            }),
            removeClass: jest.fn(name => {
                String(name).split(/\s+/).filter(Boolean).forEach(value => statusState.classes.delete(value));
                return statusElement;
            }),
            text: jest.fn(function (value) {
                if (arguments.length === 0) {
                    return statusState.text;
                }
                statusState.text = String(value ?? '');
                return statusElement;
            }),
        };
        global.$ = global.jQuery = value => value === '#director_status' ? statusElement : originalDollar(value);

        try {
            const group = {
                id: 'director-status-fail-group',
                name: 'Director Status Fail Group',
                chat_id: 'director-status-fail-chat',
                activation_strategy: directorHelpers.group_activation_strategy.DIRECTOR,
                members: ['alice.png'],
                disabled_members: [],
                director: {
                    enabled: true,
                    settings: { connectionProfileId: 'profile-1', lookbackDepth: 1, countUserMessages: true },
                    queue: [],
                    controlledDisabledMembers: [],
                    journal: '',
                    decisionHistory: [],
                    stateHistory: [],
                },
            };
            directorHelpers.groups.push(group);
            const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1);
            const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
            await directorHelpers.openGroupById(group.id);
            setIntervalSpy.mockRestore();
            clearIntervalSpy.mockRestore();

            mockDirectorConnectionService.sendRequest.mockResolvedValueOnce({ content: '' });
            await expect(directorHelpers.runDirector(group)).resolves.toBe(false);
            expect(statusState.text).toBe('Director failed.');
            expect(statusState.classes.has('preview')).toBe(true);

            jest.advanceTimersByTime(4000);
            expect(statusState.text).toBe('');
            expect(statusState.classes.has('preview')).toBe(false);
        } finally {
            global.$ = global.jQuery = originalDollar;
            jest.useRealTimers();
        }
    });
});
