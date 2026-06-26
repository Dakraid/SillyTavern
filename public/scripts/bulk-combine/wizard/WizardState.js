'use strict';

/**
 * @file Stateful wizard state with sessionStorage persistence.
 *
 * Single source of truth for the wizard lifecycle: stage, selected characters,
 * config, generation outputs, merged XML, post-merge results, artifacts, and
 * avatar settings. Persists to sessionStorage (recovers from accidental popup
 * close) and exposes subscribe/notify for reactive UI updates.
 *
 * No DOM access: pure state management. sessionStorage access is guarded so
 * the module also loads in non-browser contexts (tests).
 */

/**
 * sessionStorage key used to persist the wizard state.
 *
 * @type {string}
 */
export const STORAGE_KEY = 'bulkCombineWizardState';

const STAGE_MIN = 1;
const STAGE_MAX = 5;
const SEED_MAX = 2147483647;

/**
 * Produce a fresh default config object. Deterministic on purpose so tests
 * can assert exact shapes; randomness is injected separately where needed.
 *
 * @returns {object} Default config object.
 */
function createDefaultConfig() {
    return {
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
    };
}

/**
 * Produce a fresh default top-level state object. `voronoiSeed` is left at 0
 * here; the constructor/init replaces it with a random value.
 *
 * @returns {object} Default state object.
 */
function createDefaultState() {
    return {
        stage: 1,
        selectedCharacterIds: [],
        config: createDefaultConfig(),
        characterOutputs: [],
        mergedXml: '',
        postProcessResult: null,
        createdArtifacts: null,
        avatarOffsets: [],
        avatarUrl: null,
        voronoiSeed: 0,
        rerunConfig: null,
    };
}

/**
 * Generate a random positive 31-bit seed (matches the legacy wizard range).
 *
 * @returns {number} Random seed in [0, 2147483646].
 */
function randomSeed() {
    return Math.floor(Math.random() * SEED_MAX);
}

/**
 * Deep-clone a JSON-serializable value via the same JSON round-trip used for
 * persistence. Safe here because wizard state never contains non-JSON values.
 *
 * @param {unknown} value Value to clone.
 * @returns {unknown} Deep clone.
 */
function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * Recursively freeze a value for read-only snapshots.
 *
 * @param {unknown} value Value to freeze.
 * @returns {unknown} The same value, now deeply frozen.
 */
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

/**
 * Recursively merge `source` into `target`, returning a new object. Plain
 * objects merge recursively; arrays and primitives (incl. `null`) replace
 * wholesale.
 *
 * @param {object} target Base object.
 * @param {object} source Patch object.
 * @returns {object} Merged object.
 */
function deepMerge(target, source) {
    const out = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (
            value && typeof value === 'object' && !Array.isArray(value) &&
            target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
        ) {
            out[key] = deepMerge(target[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

/**
 * Coerce an arbitrary input into a list of valid character ids. Accepts
 * finite non-negative integer numbers and numeric strings; rejects
 * null/undefined/objects/NaN/empty strings. The explicit type guard before
 * coercion avoids the `Number(null) === 0` / `Number('') === 0` traps.
 *
 * @param {unknown} arr Input to coerce.
 * @returns {number[]} Clean list of numeric ids.
 */
function coerceIdList(arr) {
    if (!Array.isArray(arr)) {
        return [];
    }
    const ids = [];
    for (const raw of arr) {
        let n;
        if (typeof raw === 'number') {
            n = raw;
        } else if (typeof raw === 'string' && raw.trim() !== '') {
            n = Number(raw);
        } else {
            continue;
        }
        if (Number.isFinite(n) && n >= 0 && Number.isInteger(n)) {
            ids.push(n);
        }
    }
    return ids;
}

/**
 * Clamp a stage number to the valid integer 1-5 range. Non-finite or NaN
 * inputs fall back to {@link STAGE_MIN}.
 *
 * @param {unknown} value Stage candidate.
 * @returns {number} Clamped integer stage.
 */
function clampStage(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return STAGE_MIN;
    }
    return Math.max(STAGE_MIN, Math.min(STAGE_MAX, Math.round(n)));
}

/**
 * Validate that a deserialized payload has the minimum structural shape of a
 * wizard state. Checks structural types only — {@link normalizeState} coerces
 * and clamps values.
 *
 * @param {unknown} obj Deserialized payload.
 * @returns {boolean} True when the shape is acceptable.
 */
function isValidStateShape(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
        return false;
    }
    const stage = obj.stage;
    if (typeof stage !== 'number' || !Number.isFinite(stage) || Math.floor(stage) !== stage) {
        return false;
    }
    if (stage < STAGE_MIN || stage > STAGE_MAX) {
        return false;
    }
    if (!Array.isArray(obj.selectedCharacterIds)) {
        return false;
    }
    const config = obj.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return false;
    }
    if (!Number.isFinite(Number(obj.voronoiSeed))) {
        return false;
    }
    return true;
}

/**
 * Normalize a validated payload into a clean state object: keep only known
 * config keys, coerce ids to finite numbers, and default missing optional
 * top-level fields.
 *
 * @param {object} parsed Validated payload.
 * @returns {object} Normalized state.
 */
function normalizeState(parsed) {
    const configDefaults = createDefaultConfig();
    const incomingConfig = parsed.config && typeof parsed.config === 'object' && !Array.isArray(parsed.config)
        ? parsed.config
        : {};
    const config = { ...configDefaults };
    for (const key of Object.keys(configDefaults)) {
        if (Object.prototype.hasOwnProperty.call(incomingConfig, key)) {
            config[key] = incomingConfig[key];
        }
    }
    const ids = coerceIdList(parsed.selectedCharacterIds);
    return {
        stage: clampStage(parsed.stage),
        selectedCharacterIds: ids,
        config,
        characterOutputs: Array.isArray(parsed.characterOutputs) ? parsed.characterOutputs : [],
        mergedXml: typeof parsed.mergedXml === 'string' ? parsed.mergedXml : '',
        postProcessResult: parsed.postProcessResult ?? null,
        createdArtifacts: parsed.createdArtifacts ?? null,
        avatarOffsets: Array.isArray(parsed.avatarOffsets) ? parsed.avatarOffsets : [],
        avatarUrl: parsed.avatarUrl ?? null,
        voronoiSeed: Number.isFinite(Number(parsed.voronoiSeed)) ? Number(parsed.voronoiSeed) : 0,
        rerunConfig: parsed.rerunConfig ?? null,
    };
}

/**
 * Get the sessionStorage handle, or `null` when storage is unavailable
 * (non-browser env, private mode, disabled storage). Centralizes the guard
 * so persist/restore/clear share one safe-access point.
 *
 * @returns {Storage|null} sessionStorage handle or null.
 */
function getStorage() {
    try {
        return typeof sessionStorage === 'undefined' ? null : sessionStorage;
    } catch {
        // Private mode / disabled storage — treat as absent.
        return null;
    }
}

/**
 * Wizard state container with sessionStorage persistence and subscribe/notify.
 */
export class WizardState {
    /**
     * Create a fresh, empty wizard state. Call {@link WizardState#init} to
     * populate it for a run.
     */
    constructor() {
        this._state = createDefaultState();
        this._state.voronoiSeed = randomSeed();
        this._listeners = new Set();
    }

    /**
     * Initialize state for a new wizard run.
     *
     * @param {number[]} selectedCharacterIds Characters selected in the bulk overlay.
     * @param {object} [rerunConfig] Optional re-run configuration
     *   (`{ rerunMeta: { config }, groupName, rerunAvatar }`).
     * @returns {void}
     */
    init(selectedCharacterIds, rerunConfig) {
        const ids = coerceIdList(selectedCharacterIds);

        const state = createDefaultState();
        state.selectedCharacterIds = ids;
        state.rerunConfig = rerunConfig ?? null;

        const stored = rerunConfig?.rerunMeta?.config;
        if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
            // Legacy metadata stores avatarOffsets/voronoiSeed flat inside config;
            // hoist them to top-level state and keep only known config keys.
            state.avatarOffsets = Array.isArray(stored.avatarOffsets) ? stored.avatarOffsets : [];
            state.voronoiSeed = Number.isFinite(Number(stored.voronoiSeed))
                ? Number(stored.voronoiSeed)
                : randomSeed();

            const configDefaults = createDefaultConfig();
            const config = { ...configDefaults };
            for (const key of Object.keys(configDefaults)) {
                if (Object.prototype.hasOwnProperty.call(stored, key)) {
                    config[key] = stored[key];
                }
            }
            state.config = config;
        } else {
            state.voronoiSeed = randomSeed();
        }

        // Top-level rerunConfig.groupName always wins over stored/defaults:
        // legacy cards store it here, and re-runs pass the live card name.
        if (rerunConfig && rerunConfig.groupName != null) {
            state.config.groupName = String(rerunConfig.groupName);
        }

        // Re-run: optionally start at a specific stage.
        if (rerunConfig && Number.isFinite(Number(rerunConfig.startStage))) {
            state.stage = clampStage(Number(rerunConfig.startStage));
        }

        this._state = state;
        this.notify();
    }

    /**
     * Deep-merge a partial config patch into `this.config`.
     *
     * @param {object} config Partial config object to apply.
     * @returns {void}
     */
    update(config) {
        if (!config || typeof config !== 'object' || Array.isArray(config)) {
            return;
        }
        this._state.config = deepMerge(this._state.config, config);
        this.notify();
    }

    /**
     * Set a single top-level state field. `stage` is clamped to 1-5; other
     * keys are assigned verbatim.
     *
     * @param {string} key Top-level state key.
     * @param {unknown} value Value to assign.
     * @returns {void}
     */
    updateField(key, value) {
        if (typeof key !== 'string' || key.length === 0) {
            return;
        }
        if (key === 'stage') {
            this._state.stage = clampStage(value);
        } else {
            this._state[key] = value;
        }
        this.notify();
    }

    /**
     * Serialize the current state to sessionStorage as JSON.
     *
     * @returns {void}
     */
    persist() {
        const storage = getStorage();
        if (storage) {
            try {
                storage.setItem(STORAGE_KEY, JSON.stringify(this._state));
            } catch {
                // Quota exceeded — in-memory state is unaffected.
            }
        }
    }

    /**
     * Restore previously persisted state, if present and structurally valid.
     *
     * @returns {boolean} `true` when valid state was restored.
     */
    restore() {
        const storage = getStorage();
        if (!storage) {
            return false;
        }
        try {
            const raw = storage.getItem(STORAGE_KEY);
            if (!raw) {
                return false;
            }
            const parsed = JSON.parse(raw);
            if (!isValidStateShape(parsed)) {
                return false;
            }
            this._state = normalizeState(parsed);
            this.notify();
            return true;
        } catch {
            // Corrupt JSON, non-object payload, or storage read error.
            return false;
        }
    }

    /**
     * Clear all state and remove the persisted entry.
     *
     * @returns {void}
     */
    clear() {
        this._state = createDefaultState();
        this._state.voronoiSeed = randomSeed();
        const storage = getStorage();
        if (storage) {
            try {
                storage.removeItem(STORAGE_KEY);
            } catch {
                // Disabled storage — nothing to remove.
            }
        }
        this.notify();
    }

    /**
     * Register a subscriber invoked on every {@link WizardState#notify}. The
     * listener receives a deeply-frozen snapshot of the state.
     *
     * @param {(state: object) => void} callback Listener receiving a frozen snapshot.
     * @returns {() => void} Unsubscribe function.
     */
    subscribe(callback) {
        if (typeof callback !== 'function') {
            return () => {};
        }
        this._listeners.add(callback);
        return () => {
            this._listeners.delete(callback);
        };
    }

    /**
     * Notify all registered subscribers of a state change.
     *
     * @returns {void}
     */
    notify() {
        const snapshot = this.state;
        for (const listener of this._listeners) {
            try {
                listener(snapshot);
            } catch {
                // A listener throwing must not break the remaining listeners.
            }
        }
    }

    /**
     * Current wizard stage (1-5).
     *
     * @type {number}
     */
    get stage() {
        return this._state.stage;
    }

    /**
     * @param {number} value Next stage index (clamped to 1-5).
     */
    set stage(value) {
        this._state.stage = clampStage(value);
        this.notify();
    }

    /**
     * Live config reference. Mutate via {@link WizardState#update} so that
     * subscribers are notified.
     *
     * @returns {object} Config object.
     */
    get config() {
        return this._state.config;
    }

    /**
     * Deeply-frozen read-only snapshot of the full state.
     *
     * @returns {object} Frozen state snapshot.
     */
    get state() {
        return deepFreeze(deepClone(this._state));
    }
}
