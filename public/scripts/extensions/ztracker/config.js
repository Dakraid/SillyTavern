import { extension_settings } from '../../extensions.js';
import { EXTENSION_KEY } from './metadata.js';

export const AUTO_MODE = Object.freeze({
    NONE: 'none',
    INPUT: 'input',
    OUTPUT: 'output',
    BOTH: 'both',
});

export const WORLD_INFO_POLICY = Object.freeze({
    INCLUDE_ALL: 'include_all',
    EXCLUDE_ALL: 'exclude_all',
    ALLOWLIST: 'allowlist',
});

export const EMBED_SNAPSHOT_FORMAT = Object.freeze({
    PRETTY_JSON: 'pretty_json',
    TOP_LEVEL_LINES: 'top_level_lines',
    TOON: 'toon',
});

export const DEFAULT_EMBED_SNAPSHOT_HEADER = 'Tracker:';
export const DEFAULT_CONNECTION_PROFILE_ID = null;

export const DEFAULT_SCHEMA_VALUE = Object.freeze({
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'SceneTracker',
    description: 'Schema for tracking roleplay scene details',
    type: 'object',
    properties: {
        time: {
            type: 'string',
            description: 'Format: HH:MM:SS; MM/DD/YYYY (Day Name)',
        },
        location: {
            type: 'string',
            description: 'Specific scene location with increasing specificity',
        },
        weather: {
            type: 'string',
            description: 'Current weather conditions and temperature',
        },
        topics: {
            type: 'object',
            properties: {
                primaryTopic: {
                    type: 'string',
                    description: '1-2 word main topic of interaction',
                },
                emotionalTone: {
                    type: 'string',
                    description: 'Dominant emotional tone of scene',
                },
                interactionTheme: {
                    type: 'string',
                    description: 'Type of character interaction',
                },
            },
            required: ['primaryTopic', 'emotionalTone', 'interactionTheme'],
        },
        charactersPresent: {
            type: 'array',
            items: {
                type: 'string',
                description: 'Character names',
            },
            description: 'List of character names present in scene',
        },
        characters: {
            type: 'array',
            'x-ztracker-dependsOn': ['charactersPresent'],
            'x-ztracker-idKey': 'name',
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Character name' },
                    hair: { type: 'string', description: 'Hairstyle and condition' },
                    makeup: {
                        type: 'string',
                        description: 'Makeup description or \'None\'',
                    },
                    outfit: {
                        type: 'string',
                        description: 'Complete outfit including underwear',
                    },
                    stateOfDress: {
                        type: 'string',
                        description: 'How put-together/disheveled character appears',
                    },
                    postureAndInteraction: {
                        type: 'string',
                        description: 'Character\'s physical positioning and interaction',
                    },
                },
                required: [
                    'name',
                    'hair',
                    'makeup',
                    'outfit',
                    'stateOfDress',
                    'postureAndInteraction',
                ],
            },
            description: 'Array of character objects',
        },
    },
    required: [
        'time',
        'location',
        'weather',
        'topics',
        'charactersPresent',
        'characters',
    ],
});

export const DEFAULT_SCHEMA_HTML = `<div class="ztracker_default_mes_template">
    <table>
        <tbody>
            <tr><td>Time:</td><td>{{data.time}}</td></tr>
            <tr><td>Location:</td><td>{{data.location}}</td></tr>
            <tr><td>Weather:</td><td>{{data.weather}}</td></tr>
        </tbody>
    </table>
    <details>
        <summary><span>Tracker Details</span></summary>
        <table>
            <tbody>
                <tr><td>Topics:</td><td>{{data.topics.primaryTopic}}; {{data.topics.emotionalTone}}; {{data.topics.interactionTheme}}</td></tr>
                <tr><td>Present:</td><td>{{join data.charactersPresent ', '}}</td></tr>
            </tbody>
        </table>
        <div class="mes_ztracker_characters">
            {{#each data.characters as |character|}}
            <hr>
            <strong>{{character.name}}:</strong><br>
            <table>
                <tbody>
                    <tr><td>Hair:</td><td>{{character.hair}}</td></tr>
                    <tr><td>Makeup:</td><td>{{character.makeup}}</td></tr>
                    <tr><td>Outfit:</td><td>{{character.outfit}}</td></tr>
                    <tr><td>State:</td><td>{{character.stateOfDress}}</td></tr>
                    <tr><td>Position:</td><td>{{character.postureAndInteraction}}</td></tr>
                </tbody>
            </table>
            {{/each}}
        </div>
    </details>
</div>
<hr>`;

export const defaultSettings = Object.freeze({
    enabled: false,
    autoMode: AUTO_MODE.NONE,
    schemaPreset: 'default',
    schemaPresets: {
        default: {
            name: 'Default',
            value: DEFAULT_SCHEMA_VALUE,
            html: DEFAULT_SCHEMA_HTML,
        },
    },
    connectionProfileId: DEFAULT_CONNECTION_PROFILE_ID,
    worldInfoPolicy: WORLD_INFO_POLICY.INCLUDE_ALL,
    allowlistWorldInfo: [],
    embedSnapshotHeader: DEFAULT_EMBED_SNAPSHOT_HEADER,
    embedSnapshotFormat: EMBED_SNAPSHOT_FORMAT.PRETTY_JSON,
    includeLastXZTrackerMessages: 1,
    embedZTrackerRole: 'user',
    embedZTrackerAsCharacter: false,
});

function clone(value) {
    return structuredClone(value);
}

function normalizeStringArrayLike(value) {
    if (Array.isArray(value)) {
        return value
            .filter((x) => typeof x === 'string' && x.trim())
            .map((x) => x.trim());
    }
    if (typeof value === 'string' && value.trim()) {
        return [value.trim()];
    }
    return undefined;
}

export function repairCorruptedRequiredMetadata(schema) {
    if (!schema || typeof schema !== 'object') return schema;
    if (Array.isArray(schema)) return schema.map(repairCorruptedRequiredMetadata);

    const source = schema;
    const repaired = { ...source };
    const properties =
        source.properties &&
        typeof source.properties === 'object' &&
        !Array.isArray(source.properties)
            ? source.properties
            : undefined;
    const misplacedRequired = normalizeStringArrayLike(properties?.required);
    const currentRequired = normalizeStringArrayLike(source.required);

    if (currentRequired?.length) {
        repaired.required = currentRequired;
    } else if (misplacedRequired?.length) {
        repaired.required = misplacedRequired;
    }

    if (properties) {
        const repairedProperties = {};
        for (const [key, value] of Object.entries(properties)) {
            if (key === 'required' && misplacedRequired?.length) continue;
            repairedProperties[key] = repairCorruptedRequiredMetadata(value);
        }
        repaired.properties = repairedProperties;
    }

    if (source.items !== undefined) {
        repaired.items = repairCorruptedRequiredMetadata(source.items);
    }

    return repaired;
}

function sanitizeIntegerSetting(value, { fallback, min, max }) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const integer = Math.trunc(numeric);
    if (integer < min) return min;
    if (typeof max === 'number' && integer > max) return max;
    return integer;
}

export function migrateLegacyAutoMode(settings) {
    if (settings.autoMode !== 'input') return false;
    settings.autoMode = AUTO_MODE.BOTH;
    return true;
}

export function migrateInvalidNumericSettings(settings) {
    let changed = false;
    const numericDefaults = {
        includeLastXZTrackerMessages: {
            fallback: defaultSettings.includeLastXZTrackerMessages,
            min: 0,
            max: undefined,
        },
    };

    for (const [key, bounds] of Object.entries(numericDefaults)) {
        const next = sanitizeIntegerSetting(settings[key], bounds);
        if (settings[key] !== next) {
            settings[key] = next;
            changed = true;
        }
    }

    return changed;
}

export function migrateCorruptedSchemaPresetRequiredMetadata(settings) {
    let changed = false;
    for (const [key, preset] of Object.entries(settings.schemaPresets ?? {})) {
        if (!preset || typeof preset !== 'object') continue;
        const originalSerialized = JSON.stringify(preset.value);
        const repairedValue = repairCorruptedRequiredMetadata(preset.value);
        if (originalSerialized === JSON.stringify(repairedValue)) continue;
        settings.schemaPresets[key] = { ...preset, value: repairedValue };
        changed = true;
    }
    return changed;
}

export const migrations = Object.freeze([
    migrateLegacyAutoMode,
    migrateInvalidNumericSettings,
    migrateCorruptedSchemaPresetRequiredMetadata,
]);

export function getZTrackerSettings() {
    const saved =
        extension_settings[EXTENSION_KEY] &&
        typeof extension_settings[EXTENSION_KEY] === 'object'
            ? extension_settings[EXTENSION_KEY]
            : {};
    const merged = {
        ...clone(defaultSettings),
        ...clone(saved),
        schemaPresets: {
            ...clone(defaultSettings.schemaPresets),
            ...(saved.schemaPresets ? clone(saved.schemaPresets) : {}),
        },
    };

    let changed = !extension_settings[EXTENSION_KEY];
    for (const migrate of migrations) {
        changed = migrate(merged) || changed;
    }

    if (changed) {
        extension_settings[EXTENSION_KEY] = merged;
    }

    return merged;
}

export function setZTrackerSettings(settings) {
    extension_settings[EXTENSION_KEY] = {
        ...clone(defaultSettings),
        ...clone(settings ?? {}),
    };
    return extension_settings[EXTENSION_KEY];
}

export function getActiveSchemaPreset(settings = getZTrackerSettings()) {
    const key = settings.schemaPreset || 'default';
    return settings.schemaPresets?.[key] ?? settings.schemaPresets?.default;
}
