import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../extensions.js';
import { saveSettingsDebounced } from '../../../script.js';
import { world_names } from '../../world-info.js';
import { EXTENSION_KEY, CHAT_METADATA_SCHEMA_PRESET_KEY } from './metadata.js';

const MODULE_NAME = 'ztracker';
const READ_ONLY_SCHEMA_PRESETS = new Set(['default']);
const TOOL_NAMES = [
    'update_tracker',
    'recreate_tracker_field',
    'cleanup_tracker',
    'edit_tracker',
];

const DEFAULT_SCHEMA_VALUE = Object.freeze({
    type: 'object',
    properties: {
        summary: {
            type: 'string',
            description: 'Brief scene/state summary.',
        },
    },
    required: ['summary'],
    additionalProperties: true,
});

const DEFAULT_SCHEMA_HTML =
    '<div class="mes_ztracker"><strong>Tracker:</strong> {{data.summary}}</div>';

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    version: '0.1.0',
    formatVersion: 'F_1.0',
    connectionSource: 'active',
    connectionProfileId: '',
    autoMode: 'none',
    schemaPreset: 'default',
    schemaPresets: {
        default: {
            name: 'Default',
            value: DEFAULT_SCHEMA_VALUE,
            html: DEFAULT_SCHEMA_HTML,
        },
    },
    worldInfoPolicy: 'include_all',
    allowlistWorldInfo: [],
    includeLastXZTrackerMessages: 1,
    generateContextStrategy: 'messages',
    generateContextMessageCount: 20,
    generateContextTrackerCount: 2,
    embedZTrackerSnapshotHeader: 'Tracker:',
    embedZTrackerSnapshotTransformPreset: 'default',
    embedZTrackerSnapshotTransformPresets: {
        default: {
            name: 'Default (JSON)',
            input: 'pretty_json',
            pattern: '',
            flags: 'g',
            replacement: '',
            codeFenceLang: 'json',
            wrapInCodeFence: true,
        },
        minimal: {
            name: 'Minimal (top-level properties)',
            input: 'top_level_lines',
            pattern: '^[\\t ]*\\"([^\\"]+)\\"[\\t ]*:[\\t ]*(.*?)(?:,)?[\\t ]*$',
            flags: 'gm',
            replacement: '$1: $2',
            codeFenceLang: 'text',
            wrapInCodeFence: false,
        },
        toon: {
            name: 'TOON (compact)',
            input: 'toon',
            pattern: '',
            flags: 'g',
            replacement: '',
            codeFenceLang: 'toon',
            wrapInCodeFence: true,
        },
    },
});

let initialized = false;
let activeSchemaKey = 'default';

function clone(value) {
    return structuredClone(value);
}

function getSettings() {
    extension_settings[EXTENSION_KEY] ??= {};
    const settings = extension_settings[EXTENSION_KEY];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = clone(value);
        }
    }
    settings.schemaPresets ??= clone(DEFAULT_SETTINGS.schemaPresets);
    if (!Object.keys(settings.schemaPresets).length) {
        settings.schemaPresets = clone(DEFAULT_SETTINGS.schemaPresets);
    }
    if (
        !settings.schemaPreset ||
        !settings.schemaPresets[settings.schemaPreset]
    ) {
        settings.schemaPreset = Object.keys(settings.schemaPresets)[0] || 'default';
    }
    settings.allowlistWorldInfo ??= [];
    settings.embedZTrackerSnapshotTransformPresets ??= clone(
        DEFAULT_SETTINGS.embedZTrackerSnapshotTransformPresets,
    );
    activeSchemaKey = settings.schemaPreset;
    return settings;
}

/**
 * @param {string} id
 * @returns {any}
 */
function byId(id) {
    return document.getElementById(id);
}

function getChatMetadata(createIfMissing = false) {
    const context = getContext();
    const chatMetadata = context?.chatMetadata ?? context?.chat_metadata;
    if (!chatMetadata || typeof chatMetadata !== 'object') {
        return undefined;
    }
    if (!chatMetadata[EXTENSION_KEY] && createIfMissing) {
        chatMetadata[EXTENSION_KEY] = {};
    }
    return chatMetadata[EXTENSION_KEY];
}

function getCurrentChatSchemaKey(settings) {
    const metadata = getChatMetadata(false);
    const key = metadata?.[CHAT_METADATA_SCHEMA_PRESET_KEY];
    return typeof key === 'string' && settings.schemaPresets[key]
        ? key
        : settings.schemaPreset;
}

function clampPositiveInteger(value, fallback) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : fallback;
}

function saveSettings() {
    saveSettingsDebounced();
    renderDiagnostics();
}

function saveChatSchemaKey(schemaKey) {
    const metadata = getChatMetadata(true);
    if (!metadata) {
        return;
    }
    metadata[CHAT_METADATA_SCHEMA_PRESET_KEY] = schemaKey;
    saveMetadataDebounced();
}

function setOptionList(select, options, selectedValue) {
    if (!select) {
        return;
    }
    select.textContent = '';
    for (const option of options) {
        const element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        element.selected = option.value === selectedValue;
        select.append(element);
    }
}

function renderConnectionProfiles(settings) {
    const profiles = extension_settings.connectionManager?.profiles ?? [];
    setOptionList(
        byId('ztracker_profile_id'),
        [
            { value: '', label: 'None' },
            ...profiles.map((profile) => ({
                value: profile.id,
                label: profile.name || profile.id,
            })),
        ],
        settings.connectionProfileId ?? '',
    );
    byId('ztracker_profile_row')?.classList.toggle(
        'displayNone',
        settings.connectionSource !== 'saved',
    );
}

function renderWorldInfoAllowlist(settings) {
    const names = Array.isArray(world_names) ? world_names : [];
    const selected = new Set(settings.allowlistWorldInfo ?? []);
    const select = byId('ztracker_world_info_allowlist');
    setOptionList(
        select,
        names.map((name) => ({ value: name, label: name })),
        '',
    );
    if (select) {
        for (const option of select.options) {
            option.selected = selected.has(option.value);
        }
    }
    byId('ztracker_world_info_allowlist_row')?.classList.toggle(
        'displayNone',
        settings.worldInfoPolicy !== 'allowlist',
    );
}

function renderSchemaSelectors(settings) {
    const options = Object.entries(settings.schemaPresets).map(
        ([key, preset]) => ({
            value: key,
            label: preset.name || key,
        }),
    );
    setOptionList(byId('ztracker_schema_preset'), options, activeSchemaKey);
    setOptionList(
        byId('ztracker_chat_schema_preset'),
        options,
        getCurrentChatSchemaKey(settings),
    );
}

function renderSchemaEditor(settings) {
    const preset =
        settings.schemaPresets[activeSchemaKey] ??
        settings.schemaPresets[settings.schemaPreset];
    if (!preset) {
        return;
    }
    byId('ztracker_schema_name').value = preset.name ?? activeSchemaKey;
    byId('ztracker_schema_json').value = JSON.stringify(
        preset.value ?? {},
        null,
        4,
    );
    byId('ztracker_schema_html').value = preset.html ?? '';
    validateSchemaDrafts();
}

function renderSettings() {
    const settings = getSettings();
    byId('ztracker_enabled').checked = !!settings.enabled;
    byId('ztracker_auto_mode').value = settings.autoMode ?? 'none';
    byId('ztracker_connection_source').value =
        settings.connectionSource ?? 'active';
    byId('ztracker_world_info_policy').value =
        settings.worldInfoPolicy ?? 'include_all';
    byId('ztracker_embed_header').value =
        settings.embedZTrackerSnapshotHeader ?? '';
    byId('ztracker_embed_format').value =
        settings.embedZTrackerSnapshotTransformPreset ?? 'default';
    byId('ztracker_generate_context_strategy').value =
        settings.generateContextStrategy === 'trackers' ? 'trackers' : 'messages';
    byId('ztracker_generate_context_message_count').value =
        clampPositiveInteger(settings.generateContextMessageCount, 20);
    byId('ztracker_generate_context_tracker_count').value =
        clampPositiveInteger(settings.generateContextTrackerCount, 2);
    renderConnectionProfiles(settings);
    renderWorldInfoAllowlist(settings);
    renderSchemaSelectors(settings);
    renderSchemaEditor(settings);
    renderDiagnostics();
}

function validateSchemaDrafts() {
    const schemaStatus = byId('ztracker_schema_json_status');
    const htmlStatus = byId('ztracker_schema_html_status');
    const saveButton = byId('ztracker_schema_save');
    let schemaValid = false;
    try {
        const value = JSON.parse(byId('ztracker_schema_json').value || '{}');
        schemaValid = !!value && typeof value === 'object' && !Array.isArray(value);
        schemaStatus.textContent = schemaValid
            ? 'Valid JSON schema draft.'
            : 'Schema must be a JSON object.';
        schemaStatus.classList.toggle('redWarning', !schemaValid);
    } catch (error) {
        schemaStatus.textContent = `Invalid JSON: ${error.message}`;
        schemaStatus.classList.add('redWarning');
    }

    const html = byId('ztracker_schema_html').value;
    const htmlValid = html.trim().length > 0;
    htmlStatus.textContent = htmlValid
        ? 'Template draft ready.'
        : 'Template cannot be empty.';
    htmlStatus.classList.toggle('redWarning', !htmlValid);
    saveButton.disabled = !(schemaValid && htmlValid);
}

function saveActiveSchemaPreset() {
    const settings = getSettings();
    const schemaText = byId('ztracker_schema_json').value;
    const html = byId('ztracker_schema_html').value;
    const name = byId('ztracker_schema_name').value.trim() || activeSchemaKey;
    const value = JSON.parse(schemaText);
    settings.schemaPresets[activeSchemaKey] = { name, value, html };
    if (!settings.schemaPresets[settings.schemaPreset]) {
        settings.schemaPreset = activeSchemaKey;
    }
    saveSettings();
    renderSchemaSelectors(settings);
    validateSchemaDrafts();
}

function makeSchemaKey(name, settings) {
    const base =
        (name || 'preset')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'preset';
    let key = base;
    let suffix = 2;
    while (settings.schemaPresets[key]) {
        key = `${base}_${suffix}`;
        suffix += 1;
    }
    return key;
}

async function promptText(title, message, defaultValue = '') {
    const popup = getContext()?.Popup;
    if (popup?.show?.input) {
        return popup.show.input(title, message, defaultValue);
    }
    return window.prompt(`${title}\n\n${message}`, defaultValue);
}

async function confirmAction(title, message) {
    const popup = getContext()?.Popup;
    if (popup?.show?.confirm) {
        return popup.show.confirm(title, message);
    }
    return window.confirm(`${title}\n\n${message}`);
}

async function addSchemaPreset() {
    const settings = getSettings();
    const name = (
        await promptText('Create schema preset', 'Preset name:', 'New Preset')
    )?.trim();
    if (!name) {
        return;
    }
    const key = makeSchemaKey(name, settings);
    const source =
        settings.schemaPresets[activeSchemaKey] ??
        DEFAULT_SETTINGS.schemaPresets.default;
    settings.schemaPresets[key] = {
        name,
        value: clone(source.value),
        html: source.html,
    };
    settings.schemaPreset = key;
    activeSchemaKey = key;
    saveSettings();
    renderSettings();
}

async function renameSchemaPreset() {
    if (READ_ONLY_SCHEMA_PRESETS.has(activeSchemaKey)) {
        return;
    }
    const settings = getSettings();
    const current = settings.schemaPresets[activeSchemaKey];
    if (!current) {
        return;
    }
    const name = (
        await promptText(
            'Rename schema preset',
            'Preset name:',
            current.name || activeSchemaKey,
        )
    )?.trim();
    if (!name) {
        return;
    }
    current.name = name;
    saveSettings();
    renderSchemaSelectors(settings);
    renderSchemaEditor(settings);
}

async function deleteSchemaPreset() {
    if (READ_ONLY_SCHEMA_PRESETS.has(activeSchemaKey)) {
        return;
    }
    const settings = getSettings();
    if (!settings.schemaPresets[activeSchemaKey]) {
        return;
    }
    const confirmed = await confirmAction(
        'Delete schema preset',
        `Delete "${settings.schemaPresets[activeSchemaKey].name || activeSchemaKey}"?`,
    );
    if (!confirmed) {
        return;
    }
    delete settings.schemaPresets[activeSchemaKey];
    if (settings.schemaPreset === activeSchemaKey) {
        settings.schemaPreset = Object.keys(settings.schemaPresets)[0] || 'default';
    }
    activeSchemaKey = settings.schemaPreset;
    saveSettings();
    renderSettings();
}

function restoreDefaultSchema() {
    const settings = getSettings();
    settings.schemaPresets.default = clone(
        DEFAULT_SETTINGS.schemaPresets.default,
    );
    settings.schemaPreset = 'default';
    activeSchemaKey = 'default';
    saveSettings();
    renderSettings();
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderDiagnostics() {
    const diagnostics = byId('ztracker_diagnostics');
    if (!diagnostics) {
        return;
    }
    const settings = getSettings();
    const status = globalThis.zTrackerToolStatus ?? {};
    const toolLines = TOOL_NAMES.map((toolName) => {
        const toolStatus = status[toolName];
        let displayStatus;
        if (toolStatus === 'ok' || toolStatus === 'registered') {
            displayStatus = '<span class="success">✓ registered</span>';
        } else if (toolStatus === 'error') {
            displayStatus = '<span class="error">✗ error</span>';
        } else {
            displayStatus = '<span class="warning">? unknown</span>';
        }
        return `- ${escapeHtml(toolName)}: ${displayStatus}`;
    });
    const lines = [
        `Enabled: ${settings.enabled ? 'yes' : 'no'}`,
        `Active schema: ${escapeHtml(settings.schemaPreset)}`,
        `Current chat schema: ${escapeHtml(getCurrentChatSchemaKey(settings))}`,
        'Tools registered:',
        ...toolLines,
        `Last error: ${escapeHtml(globalThis.zTrackerLastError ?? 'none')}`,
    ];
    diagnostics.innerHTML = lines.join('<br>');
}

function bindEvents() {
    byId('ztracker_enabled').addEventListener('change', (event) => {
        getSettings().enabled = event.target.checked;
        saveSettings();
    });
    byId('ztracker_auto_mode').addEventListener('change', (event) => {
        getSettings().autoMode = event.target.value;
        saveSettings();
    });
    byId('ztracker_connection_source').addEventListener('change', (event) => {
        const settings = getSettings();
        settings.connectionSource = event.target.value;
        saveSettings();
        renderConnectionProfiles(settings);
    });
    byId('ztracker_profile_id').addEventListener('change', (event) => {
        getSettings().connectionProfileId = event.target.value;
        saveSettings();
    });
    byId('ztracker_world_info_policy').addEventListener('change', (event) => {
        const settings = getSettings();
        settings.worldInfoPolicy = event.target.value;
        saveSettings();
        renderWorldInfoAllowlist(settings);
    });
    byId('ztracker_world_info_allowlist').addEventListener('change', (event) => {
        getSettings().allowlistWorldInfo = Array.from(
            event.target.selectedOptions,
        ).map((option) => option.value);
        saveSettings();
    });
    byId('ztracker_generate_context_strategy').addEventListener('change', (event) => {
        getSettings().generateContextStrategy =
            event.target.value === 'trackers' ? 'trackers' : 'messages';
        saveSettings();
    });
    byId('ztracker_generate_context_message_count').addEventListener('input', (event) => {
        getSettings().generateContextMessageCount = clampPositiveInteger(
            event.target.value,
            20,
        );
        saveSettings();
    });
    byId('ztracker_generate_context_tracker_count').addEventListener('input', (event) => {
        getSettings().generateContextTrackerCount = clampPositiveInteger(
            event.target.value,
            2,
        );
        saveSettings();
    });
    byId('ztracker_schema_preset').addEventListener('change', (event) => {
        const settings = getSettings();
        activeSchemaKey = event.target.value;
        settings.schemaPreset = activeSchemaKey;
        saveSettings();
        renderSchemaEditor(settings);
        renderSchemaSelectors(settings);
    });
    byId('ztracker_chat_schema_preset').addEventListener('change', (event) => {
        saveChatSchemaKey(event.target.value);
        renderDiagnostics();
    });
    byId('ztracker_schema_json').addEventListener('input', validateSchemaDrafts);
    byId('ztracker_schema_html').addEventListener('input', validateSchemaDrafts);
    byId('ztracker_schema_name').addEventListener('input', validateSchemaDrafts);
    byId('ztracker_schema_save').addEventListener(
        'click',
        saveActiveSchemaPreset,
    );
    byId('ztracker_schema_restore').addEventListener(
        'click',
        restoreDefaultSchema,
    );
    byId('ztracker_schema_add').addEventListener('click', addSchemaPreset);
    byId('ztracker_schema_rename').addEventListener('click', renameSchemaPreset);
    byId('ztracker_schema_delete').addEventListener('click', deleteSchemaPreset);
    byId('ztracker_embed_header').addEventListener('input', (event) => {
        getSettings().embedZTrackerSnapshotHeader = event.target.value;
        saveSettings();
    });
    byId('ztracker_embed_format').addEventListener('change', (event) => {
        getSettings().embedZTrackerSnapshotTransformPreset = event.target.value;
        saveSettings();
    });
}

export async function initZTrackerSettings() {
    if (initialized) {
        renderSettings();
        return;
    }
    const container = document.getElementById('extensions_settings');
    if (!container) {
        console.warn(
            'zTracker: #extensions_settings not found; settings UI was not mounted.',
        );
        return;
    }
    getSettings();
    const html = await renderExtensionTemplateAsync(MODULE_NAME, 'settings');
    $(container).append(html);
    bindEvents();
    renderSettings();
    initialized = true;
}

export async function init() {
    await initZTrackerSettings();
}

export function getZTrackerSettings() {
    return getSettings();
}
