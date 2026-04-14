import { getRequestHeaders } from '../../../script.js';
import { getPreviewString, saveTtsProviderSettings } from './index.js';

const OPENROUTER_TTS_VOICES = [
    { name: 'Alloy', voice_id: 'alloy', lang: 'en-US' },
    { name: 'Ash', voice_id: 'ash', lang: 'en-US' },
    { name: 'Ballad', voice_id: 'ballad', lang: 'en-US' },
    { name: 'Coral', voice_id: 'coral', lang: 'en-US' },
    { name: 'Echo', voice_id: 'echo', lang: 'en-US' },
    { name: 'Fable', voice_id: 'fable', lang: 'en-US' },
    { name: 'Onyx', voice_id: 'onyx', lang: 'en-US' },
    { name: 'Nova', voice_id: 'nova', lang: 'en-US' },
    { name: 'Sage', voice_id: 'sage', lang: 'en-US' },
    { name: 'Shimmer', voice_id: 'shimmer', lang: 'en-US' },
    { name: 'Verse', voice_id: 'verse', lang: 'en-US' },
];

export { OpenRouterTtsProvider };

class OpenRouterTtsProvider {
    static providerName = 'OpenRouter';

    settings;
    voices = [];
    separator = ' . ';
    audioElement = document.createElement('audio');

    defaultSettings = {
        voiceMap: {},
        model: 'openai/gpt-4o-mini-audio-preview',
        format: 'mp3',
    };

    get settingsHtml() {
        return `
        <div class="tts_openrouter_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>OpenRouter Audio Settings</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="tts_openrouter_model">Model:</label>
                    <select id="tts_openrouter_model" class="text_pole">
                        <option value="">Loading models...</option>
                    </select>
                    <label for="tts_openrouter_format">Audio Format:</label>
                    <select id="tts_openrouter_format" class="text_pole">
                        <option value="mp3">MP3</option>
                        <option value="wav">WAV</option>
                        <option value="opus">Opus</option>
                        <option value="flac">FLAC</option>
                    </select>
                    <small><i>Uses your OpenRouter API key from Chat Completion settings.</i></small>
                </div>
            </div>
        </div>`;
    }

    async loadSettings(settings) {
        if (Object.keys(settings).length == 0) {
            console.info('Using default TTS Provider settings');
        }

        this.settings = { ...this.defaultSettings };

        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            } else {
                throw `Invalid setting passed to TTS Provider: ${key}`;
            }
        }

        $('#tts_openrouter_format').val(this.settings.format);
        $('#tts_openrouter_format').on('change', () => this.onSettingsChange());

        await this.#loadModels();
        await this.checkReady();

        console.debug('OpenRouter TTS: Settings loaded');
    }

    onSettingsChange() {
        this.settings.model = String($('#tts_openrouter_model').find(':selected').val() || this.defaultSettings.model);
        this.settings.format = String($('#tts_openrouter_format').find(':selected').val() || this.defaultSettings.format);
        saveTtsProviderSettings();
    }

    async #loadModels() {
        const select = $('#tts_openrouter_model');

        try {
            const response = await fetch('/api/openrouter/models/audio', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ type: 'tts' }),
            });

            if (!response.ok) {
                throw new Error(await response.text());
            }

            const models = await response.json();
            select.empty();

            if (Array.isArray(models) && models.length > 0) {
                for (const model of models) {
                    const option = document.createElement('option');
                    option.value = model.value;
                    option.text = model.text;
                    option.selected = model.value === this.settings.model;
                    select.append(option);
                }

                if (!models.some(model => model.value === this.settings.model)) {
                    this.settings.model = String(models[0].value || this.defaultSettings.model);
                    select.val(this.settings.model);
                }
            } else {
                const option = document.createElement('option');
                option.value = this.settings.model;
                option.text = this.settings.model;
                option.selected = true;
                select.append(option);
            }
        } catch (error) {
            console.error('Failed to load OpenRouter audio models', error);
            select.empty().append(new Option(this.settings.model, this.settings.model, true, true));
        }

        select.off('change').on('change', () => this.onSettingsChange());
    }

    async checkReady() {
        this.voices = await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        await this.#loadModels();
        await this.checkReady();
    }

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }

        const voice = this.voices.find(voice => voice.name === voiceName || voice.voice_id === voiceName);

        if (!voice) {
            throw `TTS Voice name ${voiceName} not found`;
        }

        return voice;
    }

    async generateTts(text, voiceId) {
        const response = await fetch('/api/openrouter/generate-voice', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: text,
                voice: voiceId,
                model: this.settings.model,
                format: this.settings.format,
            }),
        });

        if (!response.ok) {
            toastr.error(response.statusText, 'TTS Generation Failed');
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return response;
    }

    async fetchTtsVoiceObjects() {
        this.voices = OPENROUTER_TTS_VOICES.map(voice => ({ ...voice }));
        return this.voices;
    }

    async previewTtsVoice(voiceId) {
        this.audioElement.pause();
        this.audioElement.currentTime = 0;

        const voice = await this.getVoice(voiceId);
        const response = await this.generateTts(getPreviewString(voice.lang || 'en-US'), voice.voice_id);
        const audio = await response.blob();
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }
}
