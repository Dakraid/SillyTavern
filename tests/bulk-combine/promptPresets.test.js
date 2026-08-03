'use strict';

/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

/**
 * Unit tests for
 * `public/scripts/bulk-combine/services/promptPresets.js`.
 *
 * `script.js` (`saveSettingsDebounced`) and `power-user.js` (`power_user`)
 * are mocked; the store is a plain mutable object reset before each test.
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

/** @type {object} Mutable fixture backing the mocked `power_user` export. */
const mockPowerUser = {};
/** @type {object} Mutable fixture backing the mocked `saveSettingsDebounced` export. */
const mockSaveSettingsDebounced = jest.fn();

jest.unstable_mockModule('../../public/script.js', () => ({
    saveSettingsDebounced: mockSaveSettingsDebounced,
}));

jest.unstable_mockModule('../../public/scripts/power-user.js', () => ({
    power_user: mockPowerUser,
}));

const STORE_KEY = 'bulk_combine_task_prompt_presets';
const MIGRATED_KEY = 'bulk_combine_task_prompt_presets_migrated';
const LEGACY_COMBINE_KEY = 'group_card_combine_prompt_presets';
const LEGACY_POST_MERGE_KEY = 'group_card_post_merge_prompt_presets';

let deletePromptPreset;
let findPromptPresetIndex;
let getPromptPresets;
let migrateLegacyPromptPresets;
let savePromptPreset;

beforeAll(async () => {
    ({
        deletePromptPreset,
        findPromptPresetIndex,
        getPromptPresets,
        migrateLegacyPromptPresets,
        savePromptPreset,
    } = await import('../../public/scripts/bulk-combine/services/promptPresets.js'));
});

beforeEach(() => {
    for (const key of Object.keys(mockPowerUser)) {
        delete mockPowerUser[key];
    }
    mockSaveSettingsDebounced.mockClear();
    delete global.toastr;
});

afterEach(() => {
    delete global.toastr;
});

/**
 * Seeds the new store directly (bypassing migration) with preset lists.
 *
 * @param {object} fields Field → preset list map.
 * @returns {void}
 */
function seedStore(fields) {
    mockPowerUser[STORE_KEY] = { main: [], secondPass: [], summary: [], post: [], ...fields };
    mockPowerUser[MIGRATED_KEY] = true;
}

describe('promptPresets store shape', () => {
    test('lazily creates the canonical store shape on first access', () => {
        expect(mockPowerUser[STORE_KEY]).toBeUndefined();

        expect(getPromptPresets('main')).toEqual([]);
        expect(mockPowerUser[STORE_KEY]).toEqual({ main: [], secondPass: [], summary: [], post: [] });
        // First access ran the (no-op) migration and persisted it.
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('preserves already-persisted entries when ensuring the store', () => {
        mockPowerUser[STORE_KEY] = { main: [{ name: 'Kept', prompt: 'K' }] };

        expect(getPromptPresets('main')).toEqual([{ name: 'Kept', prompt: 'K' }]);
        expect(mockPowerUser[STORE_KEY].main).toEqual([{ name: 'Kept', prompt: 'K' }]);
        expect(mockPowerUser[STORE_KEY].secondPass).toEqual([]);
    });

    test('recovers from a malformed store value', () => {
        mockPowerUser[STORE_KEY] = ['not', 'a', 'record'];
        expect(getPromptPresets('main')).toEqual([]);

        mockPowerUser[STORE_KEY] = null;
        expect(getPromptPresets('post')).toEqual([]);

        mockPowerUser[STORE_KEY] = { main: 'broken' };
        expect(getPromptPresets('main')).toEqual([]);
    });
});

describe('savePromptPreset / findPromptPresetIndex', () => {
    beforeEach(() => {
        seedStore({});
    });

    test('saves a new preset and finds it case-insensitively', async () => {
        const saved = await savePromptPreset('main', '  Dark Fantasy  ', 'Combine darkly.');

        expect(saved).toEqual({ name: 'Dark Fantasy', prompt: 'Combine darkly.' });
        expect(getPromptPresets('main')).toEqual([{ name: 'Dark Fantasy', prompt: 'Combine darkly.' }]);
        expect(findPromptPresetIndex('main', 'dark fantasy')).toBe(0);
        expect(findPromptPresetIndex('main', 'DARK FANTASY')).toBe(0);
        expect(findPromptPresetIndex('main', 'missing')).toBe(-1);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('stores presets per field without cross-contamination', async () => {
        await savePromptPreset('main', 'Shared Name', 'Main prompt.');
        await savePromptPreset('post', 'Shared Name', 'Post prompt.');

        expect(getPromptPresets('main')).toEqual([{ name: 'Shared Name', prompt: 'Main prompt.' }]);
        expect(getPromptPresets('post')).toEqual([{ name: 'Shared Name', prompt: 'Post prompt.' }]);
        expect(getPromptPresets('secondPass')).toEqual([]);
        expect(findPromptPresetIndex('post', 'shared name')).toBe(0);
    });

    test('coerces non-string prompt input and rejects empty names with a warning', async () => {
        const toaster = { warning: jest.fn() };

        expect(await savePromptPreset('main', '', 'x', { toaster })).toBe(null);
        expect(await savePromptPreset('main', '   ', 'x', { toaster })).toBe(null);
        expect(await savePromptPreset('main', null, 'x', { toaster })).toBe(null);
        expect(toaster.warning).toHaveBeenCalledTimes(3);
        expect(getPromptPresets('main')).toEqual([]);

        const saved = await savePromptPreset('main', 'Coerced', null);
        expect(saved).toEqual({ name: 'Coerced', prompt: '' });
        expect(await savePromptPreset('main', 'Numbered', 42)).toEqual({ name: 'Numbered', prompt: '42' });
    });

    test('overwrites by name when confirmOverwrite approves', async () => {
        await savePromptPreset('main', 'Preset', 'Original.');
        const confirmOverwrite = jest.fn(async () => true);

        const saved = await savePromptPreset('main', 'preset', 'Updated.', { confirmOverwrite });

        expect(saved).toEqual({ name: 'preset', prompt: 'Updated.' });
        expect(confirmOverwrite).toHaveBeenCalledWith('preset');
        expect(getPromptPresets('main')).toEqual([{ name: 'preset', prompt: 'Updated.' }]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(2);
    });

    test('keeps the original when confirmOverwrite rejects', async () => {
        await savePromptPreset('main', 'Preset', 'Original.');
        const confirmOverwrite = jest.fn(async () => false);

        const saved = await savePromptPreset('main', 'Preset', 'Updated.', { confirmOverwrite });

        expect(saved).toBe(null);
        expect(getPromptPresets('main')).toEqual([{ name: 'Preset', prompt: 'Original.' }]);
        // Only the initial save persisted.
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('overwrites by name without a confirmOverwrite (plain store semantics)', async () => {
        await savePromptPreset('main', 'Preset', 'Original.');
        const saved = await savePromptPreset('main', 'PRESET', 'Updated.');

        expect(saved).toEqual({ name: 'PRESET', prompt: 'Updated.' });
        expect(getPromptPresets('main')).toEqual([{ name: 'PRESET', prompt: 'Updated.' }]);
    });
});

describe('deletePromptPreset', () => {
    beforeEach(() => {
        seedStore({ main: [{ name: 'A', prompt: 'a' }, { name: 'B', prompt: 'b' }] });
    });

    test('deletes by index and persists', () => {
        expect(deletePromptPreset('main', 0)).toBe(true);
        expect(getPromptPresets('main')).toEqual([{ name: 'B', prompt: 'b' }]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('rejects invalid indices without persisting', () => {
        for (const index of [-1, 2, 1.5, NaN, Infinity, '0', null]) {
            expect(deletePromptPreset('main', index)).toBe(false);
        }
        expect(getPromptPresets('main')).toEqual([{ name: 'A', prompt: 'a' }, { name: 'B', prompt: 'b' }]);
        expect(mockSaveSettingsDebounced).not.toHaveBeenCalled();
    });
});

describe('migrateLegacyPromptPresets', () => {
    test('maps combine → main and post-merge → post; secondPass/summary stay empty', () => {
        mockPowerUser[LEGACY_COMBINE_KEY] = [
            { name: 'Combine A', prompt: 'CA' },
            { name: 'Combine B', prompt: 'CB' },
        ];
        mockPowerUser[LEGACY_POST_MERGE_KEY] = [{ name: 'Merge A', prompt: 'MA' }];

        expect(migrateLegacyPromptPresets()).toBe(true);

        expect(getPromptPresets('main')).toEqual([
            { name: 'Combine A', prompt: 'CA' },
            { name: 'Combine B', prompt: 'CB' },
        ]);
        expect(getPromptPresets('post')).toEqual([{ name: 'Merge A', prompt: 'MA' }]);
        expect(getPromptPresets('secondPass')).toEqual([]);
        expect(getPromptPresets('summary')).toEqual([]);
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
    });

    test('deletes the legacy keys after a successful copy', () => {
        mockPowerUser[LEGACY_COMBINE_KEY] = [{ name: 'A', prompt: 'a' }];
        mockPowerUser[LEGACY_POST_MERGE_KEY] = [{ name: 'B', prompt: 'b' }];

        migrateLegacyPromptPresets();

        expect(mockPowerUser[LEGACY_COMBINE_KEY]).toBeUndefined();
        expect(mockPowerUser[LEGACY_POST_MERGE_KEY]).toBeUndefined();
        expect(Object.hasOwn(mockPowerUser, LEGACY_COMBINE_KEY)).toBe(false);
        expect(Object.hasOwn(mockPowerUser, LEGACY_POST_MERGE_KEY)).toBe(false);
    });

    test('is idempotent: a second run is a no-op even if the legacy keys reappear', () => {
        mockPowerUser[LEGACY_COMBINE_KEY] = [{ name: 'A', prompt: 'a' }];
        expect(migrateLegacyPromptPresets()).toBe(true);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);

        // Legacy key re-created (e.g. from defaults) after the migration.
        mockPowerUser[LEGACY_COMBINE_KEY] = [{ name: 'Late', prompt: 'l' }];
        expect(migrateLegacyPromptPresets()).toBe(false);

        expect(getPromptPresets('main')).toEqual([{ name: 'A', prompt: 'a' }]);
        expect(mockSaveSettingsDebounced).toHaveBeenCalledTimes(1);
        // The flag guards the merge; the re-appeared legacy key is left unread.
        expect(mockPowerUser[LEGACY_COMBINE_KEY]).toEqual([{ name: 'Late', prompt: 'l' }]);
    });

    test('does not clobber existing new-store entries on name collision', () => {
        seedStore({
            main: [{ name: 'combine a', prompt: 'NEW — kept' }],
            post: [{ name: 'Existing Post', prompt: 'EP' }],
        });
        // Clear the flag so the migration runs once over the seeded store.
        delete mockPowerUser[MIGRATED_KEY];
        mockPowerUser[LEGACY_COMBINE_KEY] = [
            { name: 'Combine A', prompt: 'LEGACY — dropped' },
            { name: 'Fresh', prompt: 'F' },
        ];
        mockPowerUser[LEGACY_POST_MERGE_KEY] = [{ name: 'Existing Post', prompt: 'LEGACY — dropped' }];

        expect(migrateLegacyPromptPresets()).toBe(true);

        expect(getPromptPresets('main')).toEqual([
            { name: 'combine a', prompt: 'NEW — kept' },
            { name: 'Fresh', prompt: 'F' },
        ]);
        expect(getPromptPresets('post')).toEqual([{ name: 'Existing Post', prompt: 'EP' }]);
    });

    test('handles missing or malformed legacy data defensively', () => {
        // No legacy keys at all.
        expect(migrateLegacyPromptPresets()).toBe(true);
        expect(getPromptPresets('main')).toEqual([]);
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
    });

    test('skips malformed legacy entries', () => {
        mockPowerUser[LEGACY_COMBINE_KEY] = 'not-an-array';
        mockPowerUser[LEGACY_POST_MERGE_KEY] = [
            null,
            'string-entry',
            { prompt: 'nameless' },
            { name: '   ', prompt: 'blank name' },
            { name: 'Valid', prompt: null },
        ];

        migrateLegacyPromptPresets();

        expect(getPromptPresets('main')).toEqual([]);
        expect(getPromptPresets('post')).toEqual([{ name: 'Valid', prompt: '' }]);
    });

    test('runs lazily on the first preset read without an explicit call', async () => {
        mockPowerUser[LEGACY_COMBINE_KEY] = [{ name: 'Lazy', prompt: 'L' }];

        // No explicit migrateLegacyPromptPresets() — the read triggers it.
        expect(getPromptPresets('main')).toEqual([{ name: 'Lazy', prompt: 'L' }]);
        expect(mockPowerUser[MIGRATED_KEY]).toBe(true);
        expect(mockPowerUser[LEGACY_COMBINE_KEY]).toBeUndefined();

        // …and on the first write, too.
        mockPowerUser[LEGACY_POST_MERGE_KEY] = [{ name: 'Lazy Post', prompt: 'LP' }];
        mockPowerUser[STORE_KEY] = { main: [] };
        delete mockPowerUser[MIGRATED_KEY];
        await savePromptPreset('post', 'Other', 'O');
        expect(getPromptPresets('post')).toEqual([
            { name: 'Lazy Post', prompt: 'LP' },
            { name: 'Other', prompt: 'O' },
        ]);
    });
});
