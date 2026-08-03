'use strict';

/**
 * Unit tests for `WizardState` — the stateful wizard container with
 * sessionStorage persistence and subscribe/notify.
 *
 * The module is pure (no external imports), so it is imported directly. A
 * Map-backed `sessionStorage` mock is installed for persistence round-trip
 * tests and removed again for the "storage unavailable" cases.
 */

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    jest,
    test,
} from '@jest/globals';

import { WizardState, STORAGE_KEY } from '../../public/scripts/bulk-combine/wizard/WizardState.js';

// ---------------------------------------------------------------------------
// sessionStorage mock
// ---------------------------------------------------------------------------

/** @type {Map<string, string>} */
let store;
/** @type {typeof globalThis.sessionStorage | undefined} */
let originalSessionStorage;

beforeAll(() => {
    originalSessionStorage = globalThis.sessionStorage;
});

afterAll(() => {
    if (originalSessionStorage === undefined) {
        delete globalThis.sessionStorage;
    } else {
        globalThis.sessionStorage = originalSessionStorage;
    }
});

beforeEach(() => {
    store = new Map();
    globalThis.sessionStorage = {
        getItem: (key) => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => {
            store.set(key, String(value));
        },
        removeItem: (key) => {
            store.delete(key);
        },
        clear: () => {
            store.clear();
        },
    };
});

afterEach(() => {
    store = undefined;
});

// ---------------------------------------------------------------------------
// Constants / exports
// ---------------------------------------------------------------------------

describe('exports', () => {
    test('STORAGE_KEY is the documented session key', () => {
        expect(STORAGE_KEY).toBe('bulkCombineWizardState');
    });

    test('WizardState is a constructable class', () => {
        expect(typeof WizardState).toBe('function');
        expect(() => new WizardState()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// Constructor + defaults
// ---------------------------------------------------------------------------

describe('constructor / default state', () => {
    test('starts on stage 1 with empty character selection', () => {
        const ws = new WizardState();
        expect(ws.stage).toBe(1);
        expect(ws.state.selectedCharacterIds).toEqual([]);
    });

    test('config matches the documented default shape', () => {
        const ws = new WizardState();
        expect(ws.config).toEqual({
            groupName: '',
            prompt: null,
            concurrency: 10,
            selectedOptionalFields: ['personality'],
            createLorebook: true,
            dynamicLorebook: false,
            summaryFallbackTags: ['summary'],
            minify: false,
            minifySingleLine: false,
            cropStrategy: 'attention',
            cropPadding: 15,
            layout: 'voronoi',
            gap: 2,
            maxCols: 0,
            minCols: 0,
            colsMaxBound: 0,
            gridAlign: 'center',
            gridVAlign: 'center',
            gridDirection: 'row',
            cellFit: 'cover',
            aspectRatio: '9:16',
            customRatio: null,
            postMergeEnabled: true,
            postMergePrompt: null,
            postProcessMode: 'replace',
            inferredSchema: null,
        });
    });

    test('assigns a random voronoi seed in the valid range', () => {
        const ws = new WizardState();
        const seed = ws.state.voronoiSeed;
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(2147483647);
    });

    test('top-level state defaults to empty generation outputs', () => {
        const ws = new WizardState();
        expect(ws.state.characterOutputs).toEqual([]);
        expect(ws.state.mergedXml).toBe('');
        expect(ws.state.postProcessResult).toBeNull();
        expect(ws.state.createdArtifacts).toBeNull();
        expect(ws.state.avatarOffsets).toEqual([]);
        expect(ws.state.avatarUrl).toBeNull();
        expect(ws.state.rerunConfig).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// stage getter / setter (clamping)
// ---------------------------------------------------------------------------

describe('stage getter/setter', () => {
    test('clamps below the minimum to 1', () => {
        const ws = new WizardState();
        ws.stage = 0;
        expect(ws.stage).toBe(1);
        ws.stage = -5;
        expect(ws.stage).toBe(1);
    });

    test('clamps above the maximum to 5', () => {
        const ws = new WizardState();
        ws.stage = 6;
        expect(ws.stage).toBe(5);
        ws.stage = 99;
        expect(ws.stage).toBe(5);
    });

    test('rounds fractional stages to the nearest integer', () => {
        const ws = new WizardState();
        ws.stage = 2.7;
        expect(ws.stage).toBe(3);
        ws.stage = 2.4;
        expect(ws.stage).toBe(2);
    });

    test('coerces numeric strings', () => {
        const ws = new WizardState();
        ws.stage = '4';
        expect(ws.stage).toBe(4);
    });

    test('falls back to 1 for NaN / non-finite / null / undefined', () => {
        const ws = new WizardState();
        ws.stage = NaN;
        expect(ws.stage).toBe(1);
        ws.stage = Infinity;
        expect(ws.stage).toBe(1);
        ws.stage = null;
        expect(ws.stage).toBe(1);
        ws.stage = undefined;
        expect(ws.stage).toBe(1);
        ws.stage = 'not a number';
        expect(ws.stage).toBe(1);
    });

    test('notifies subscribers on change', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        ws.stage = 3;
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].stage).toBe(3);
    });
});

// ---------------------------------------------------------------------------
// init()
// ---------------------------------------------------------------------------

describe('init()', () => {
    test('sets selected character ids and resets to defaults', () => {
        const ws = new WizardState();
        ws.init([1, 2, 3]);

        expect(ws.state.selectedCharacterIds).toEqual([1, 2, 3]);
        expect(ws.stage).toBe(1);
        expect(ws.config.concurrency).toBe(10); // default
    });

    test('returns to stage 1 on a fresh init even after advancing', () => {
        const ws = new WizardState();
        ws.stage = 4;
        ws.init([0]);
        expect(ws.stage).toBe(1);
    });

    test('coerces numeric strings and rejects invalid ids', () => {
        const ws = new WizardState();
        ws.init([1, '2', 'x', 3.5, -1, null, undefined, {}]);
        expect(ws.state.selectedCharacterIds).toEqual([1, 2]);
    });

    test('handles null / undefined / non-array input as an empty list', () => {
        const ws = new WizardState();
        ws.init(null);
        expect(ws.state.selectedCharacterIds).toEqual([]);
        ws.init(undefined);
        expect(ws.state.selectedCharacterIds).toEqual([]);
        ws.init('not-an-array');
        expect(ws.state.selectedCharacterIds).toEqual([]);
    });

    test('stores the rerunConfig and notifies subscribers', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        const rerun = { groupName: 'G' };
        ws.init([0], rerun);

        // The `state` getter returns a deep clone, so compare by value.
        expect(ws.state.rerunConfig).toEqual(rerun);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('applies groupName override from rerunConfig', () => {
        const ws = new WizardState();
        ws.init([0], { groupName: 'Re-run Group' });
        expect(ws.config.groupName).toBe('Re-run Group');
    });

    test('does not override groupName when rerunConfig.groupName is null', () => {
        const ws = new WizardState();
        ws.init([0], { groupName: null });
        expect(ws.config.groupName).toBe('');
    });

    test('merges stored rerun config while keeping only known keys', () => {
        const ws = new WizardState();
        ws.init([0], {
            groupName: 'Stored',
            rerunMeta: {
                config: {
                    concurrency: 5,
                    layout: 'grid',
                    unknownKey: 'dropped',
                    avatarOffsets: [{ x: 1 }],
                    voronoiSeed: 42,
                },
            },
        });

        expect(ws.config.concurrency).toBe(5);
        expect(ws.config.layout).toBe('grid');
        expect(ws.config).not.toHaveProperty('unknownKey');
        expect(ws.state.avatarOffsets).toEqual([{ x: 1 }]);
        expect(ws.state.voronoiSeed).toBe(42);
        expect(ws.config.groupName).toBe('Stored');
    });

    test('falls back to a random seed when stored seed is invalid', () => {
        const ws = new WizardState();
        ws.init([0], {
            rerunMeta: { config: { voronoiSeed: 'not-a-number' } },
        });
        const seed = ws.state.voronoiSeed;
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(2147483647);
    });
});

// ---------------------------------------------------------------------------
// update()
// ---------------------------------------------------------------------------

describe('update()', () => {
    test('shallow-merges scalar config values', () => {
        const ws = new WizardState();
        ws.update({ concurrency: 3, layout: 'grid' });
        expect(ws.config.concurrency).toBe(3);
        expect(ws.config.layout).toBe('grid');
        // Untouched defaults remain.
        expect(ws.config.cropStrategy).toBe('attention');
    });

    test('deep-merges nested plain objects', () => {
        const ws = new WizardState();
        ws.update({ inferredSchema: { a: 1 } });
        ws.update({ inferredSchema: { b: 2 } });
        expect(ws.config.inferredSchema).toEqual({ a: 1, b: 2 });
    });

    test('replaces arrays wholesale rather than merging', () => {
        const ws = new WizardState();
        ws.update({ summaryFallbackTags: ['comment', 'keys'] });
        expect(ws.config.summaryFallbackTags).toEqual(['comment', 'keys']);
    });

    test('no-ops on null / undefined / non-object / array', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        const before = ws.config.concurrency;

        ws.update(null);
        ws.update(undefined);
        ws.update('not-an-object');
        ws.update(['array']);
        ws.update(42);

        expect(ws.config.concurrency).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    test('notifies subscribers exactly once per valid update', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        ws.update({ concurrency: 1 });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});

// ---------------------------------------------------------------------------
// updateField()
// ---------------------------------------------------------------------------

describe('updateField()', () => {
    test('sets a top-level state field verbatim', () => {
        const ws = new WizardState();
        ws.updateField('mergedXml', '<character/>');
        expect(ws.state.mergedXml).toBe('<character/>');
    });

    test('clamps the stage field', () => {
        const ws = new WizardState();
        ws.updateField('stage', 9);
        expect(ws.stage).toBe(5);
        ws.updateField('stage', 0);
        expect(ws.stage).toBe(1);
    });

    test('overwrites arrays and objects on the top level', () => {
        const ws = new WizardState();
        ws.updateField('selectedCharacterIds', [4, 5]);
        expect(ws.state.selectedCharacterIds).toEqual([4, 5]);
        ws.updateField('avatarOffsets', [{ x: 0 }]);
        expect(ws.state.avatarOffsets).toEqual([{ x: 0 }]);
    });

    test('no-ops on empty or non-string keys without notifying', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        const before = ws.state.mergedXml;

        ws.updateField('', 'x');
        ws.updateField(/** @type {any} */ (123), 'x');
        ws.updateField(null, 'x');

        expect(ws.state.mergedXml).toBe(before);
        expect(listener).not.toHaveBeenCalled();
    });

    test('notifies subscribers on a valid update', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        ws.updateField('avatarUrl', 'data:image/png;base64,abc');
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].avatarUrl).toBe(
            'data:image/png;base64,abc',
        );
    });
});

// ---------------------------------------------------------------------------
// persist() / restore()
// ---------------------------------------------------------------------------

describe('persist() / restore()', () => {
    test('round-trips state through sessionStorage', () => {
        const ws = new WizardState();
        ws.init([1, 2]);
        ws.update({ concurrency: 5, layout: 'grid' });
        ws.updateField('mergedXml', '<character/>');
        ws.stage = 3;
        ws.persist();

        const restored = new WizardState();
        expect(restored.restore()).toBe(true);
        expect(restored.stage).toBe(3);
        expect(restored.state.selectedCharacterIds).toEqual([1, 2]);
        expect(restored.config.concurrency).toBe(5);
        expect(restored.config.layout).toBe('grid');
        expect(restored.state.mergedXml).toBe('<character/>');
    });

    test('persist writes JSON under STORAGE_KEY', () => {
        const ws = new WizardState();
        ws.init([7]);
        ws.persist();
        const raw = store.get(STORAGE_KEY);
        expect(raw).toBeTruthy();
        expect(JSON.parse(String(raw)).selectedCharacterIds).toEqual([7]);
    });

    test('restore returns false when nothing is persisted', () => {
        const ws = new WizardState();
        expect(ws.restore()).toBe(false);
    });

    test('restore returns false for corrupt JSON', () => {
        store.set(STORAGE_KEY, '{not valid json');
        const ws = new WizardState();
        expect(ws.restore()).toBe(false);
    });

    test('restore returns false for a non-object payload', () => {
        store.set(STORAGE_KEY, JSON.stringify([1, 2, 3]));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify('string'));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify(null));
        expect(new WizardState().restore()).toBe(false);
    });

    test('restore returns false when stage is out of range or non-integer', () => {
        const base = {
            stage: 1,
            selectedCharacterIds: [],
            config: {},
            voronoiSeed: 0,
        };
        store.set(STORAGE_KEY, JSON.stringify({ ...base, stage: 99 }));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify({ ...base, stage: 0 }));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify({ ...base, stage: 1.5 }));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify({ ...base, stage: 'two' }));
        expect(new WizardState().restore()).toBe(false);
    });

    test('restore returns false when structural fields are wrong', () => {
        const base = {
            stage: 1,
            selectedCharacterIds: [],
            config: {},
            voronoiSeed: 0,
        };
        store.set(
            STORAGE_KEY,
            JSON.stringify({ ...base, selectedCharacterIds: 'nope' }),
        );
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify({ ...base, config: [] }));
        expect(new WizardState().restore()).toBe(false);
        store.set(STORAGE_KEY, JSON.stringify({ ...base, voronoiSeed: 'x' }));
        expect(new WizardState().restore()).toBe(false);
    });

    test('restore normalizes coerced values back into clean types', () => {
        store.set(
            STORAGE_KEY,
            JSON.stringify({
                stage: 3,
                selectedCharacterIds: ['1', '2'],
                config: { concurrency: 5, prompt: 'hi' },
                voronoiSeed: '7',
                mergedXml: '<c/>',
                characterOutputs: [{ ok: true }],
                avatarUrl: 'avatar.png',
            }),
        );

        const ws = new WizardState();
        expect(ws.restore()).toBe(true);
        expect(ws.stage).toBe(3);
        expect(ws.state.selectedCharacterIds).toEqual([1, 2]);
        expect(ws.config.concurrency).toBe(5);
        expect(ws.config.prompt).toBe('hi');
        expect(ws.state.voronoiSeed).toBe(7);
        expect(ws.state.mergedXml).toBe('<c/>');
        expect(ws.state.characterOutputs).toEqual([{ ok: true }]);
        expect(ws.state.avatarUrl).toBe('avatar.png');
    });

    test('restore keeps only known config keys and fills defaults', () => {
        store.set(
            STORAGE_KEY,
            JSON.stringify({
                stage: 2,
                selectedCharacterIds: [],
                config: { concurrency: 8, bogusKey: 'ignored' },
                voronoiSeed: 3,
            }),
        );

        const ws = new WizardState();
        expect(ws.restore()).toBe(true);
        expect(ws.config.concurrency).toBe(8);
        expect(ws.config).not.toHaveProperty('bogusKey');
        // Defaults are back-filled.
        expect(ws.config.layout).toBe('voronoi');
        expect(ws.config.cropStrategy).toBe('attention');
    });

    test('restore notifies subscribers on success', () => {
        store.set(
            STORAGE_KEY,
            JSON.stringify({
                stage: 2,
                selectedCharacterIds: [],
                config: {},
                voronoiSeed: 1,
            }),
        );
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        expect(ws.restore()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].stage).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// clear()
// ---------------------------------------------------------------------------

describe('clear()', () => {
    test('resets state to defaults and removes the persisted entry', () => {
        const ws = new WizardState();
        ws.init([1, 2]);
        ws.update({ concurrency: 5 });
        ws.stage = 4;
        ws.persist();
        expect(store.has(STORAGE_KEY)).toBe(true);

        ws.clear();

        expect(ws.stage).toBe(1);
        expect(ws.state.selectedCharacterIds).toEqual([]);
        expect(ws.config.concurrency).toBe(10);
        expect(store.has(STORAGE_KEY)).toBe(false);
    });

    test('assigns a fresh random voronoi seed', () => {
        const ws = new WizardState();
        ws.init([0]);
        ws.clear();
        const seed = ws.state.voronoiSeed;
        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThan(2147483647);
    });

    test('notifies subscribers', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        ws.subscribe(listener);
        ws.clear();
        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0].stage).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// subscribe() / notify()
// ---------------------------------------------------------------------------

describe('subscribe() / notify()', () => {
    test('subscriber receives a deeply-frozen snapshot on notify', () => {
        const ws = new WizardState();
        /** @type {object[]} */
        const snapshots = [];
        ws.subscribe((snapshot) => snapshots.push(snapshot));
        ws.update({ concurrency: 2 });

        expect(snapshots).toHaveLength(1);
        const snap = snapshots[0];
        expect(Object.isFrozen(snap)).toBe(true);
        expect(Object.isFrozen(snap.config)).toBe(true);
    });

    test('unsubscribe stops further notifications', () => {
        const ws = new WizardState();
        const listener = jest.fn();
        const unsubscribe = ws.subscribe(listener);
        ws.update({ concurrency: 1 });
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        ws.update({ concurrency: 2 });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    test('multiple subscribers are all notified', () => {
        const ws = new WizardState();
        const a = jest.fn();
        const b = jest.fn();
        ws.subscribe(a);
        ws.subscribe(b);
        ws.update({ concurrency: 1 });
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    test('a throwing listener does not break the others', () => {
        const ws = new WizardState();
        const good = jest.fn();
        ws.subscribe(() => {
            throw new Error('boom');
        });
        ws.subscribe(good);
        expect(() => ws.update({ concurrency: 1 })).not.toThrow();
        expect(good).toHaveBeenCalledTimes(1);
    });

    test('subscribe with a non-function returns a no-op unsubscribe', () => {
        const ws = new WizardState();
        const unsubscribe = ws.subscribe(/** @type {any} */ (null));
        expect(typeof unsubscribe).toBe('function');
        expect(() => unsubscribe()).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// state getter (frozen snapshot)
// ---------------------------------------------------------------------------

describe('state getter', () => {
    test('returns an independent deep copy', () => {
        const ws = new WizardState();
        const snap1 = ws.state;
        ws.update({ concurrency: 9 });
        const snap2 = ws.state;
        // snap1 is unaffected by the later update.
        expect(snap1.config.concurrency).toBe(10);
        expect(snap2.config.concurrency).toBe(9);
    });

    test('snapshot mutations never affect internal state', () => {
        const ws = new WizardState();
        const snap = ws.state;
        // Attempt mutation of a frozen property (no-op in non-strict, throw in
        // strict mode — either way internal state is protected).
        expect(Object.isFrozen(snap.config)).toBe(true);
        ws.update({ concurrency: 5 });
        expect(ws.config.concurrency).toBe(5);
        expect(snap.config.concurrency).toBe(10);
    });
});

// ---------------------------------------------------------------------------
// Storage-unavailable guard (no sessionStorage at all)
// ---------------------------------------------------------------------------

describe('storage unavailable guard', () => {
    beforeEach(() => {
        delete globalThis.sessionStorage;
    });

    test('persist does not throw when sessionStorage is undefined', () => {
        const ws = new WizardState();
        ws.init([1]);
        expect(() => ws.persist()).not.toThrow();
    });

    test('restore returns false when sessionStorage is undefined', () => {
        const ws = new WizardState();
        expect(ws.restore()).toBe(false);
    });

    test('clear does not throw when sessionStorage is undefined', () => {
        const ws = new WizardState();
        expect(() => ws.clear()).not.toThrow();
    });
});
