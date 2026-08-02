import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../..',
);

const readSource = (relativePath) =>
    fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

describe('legacy group-card HTTP contracts', () => {
    test('keeps create, regeneration, event, status, and cancel routes', () => {
        const source = readSource('src/endpoints/characters.js');

        expect(source).toContain('router.post(\'/group-card-job\'');
        expect(source).toContain('router.post(\'/group-card-job/regen\'');
        expect(source).toContain('router.get(\'/group-card-job/:id/events\'');
        expect(source).toContain('router.get(\'/group-card-job/:id\'');
        expect(source).toContain('router.post(\'/group-card-job/:id/cancel\'');
        expect(source).toContain('groupCardJobManager.createJob(config)');
        expect(source).toContain('groupCardJobManager.createRegenJob(config)');
        expect(source).toContain('groupCardJobManager.addSseClient(');
        expect(source).toContain('groupCardJobManager.serializeJob(job)');
        expect(source).toContain('groupCardJobManager.cancelJob(');
    });
});

describe('Chat Completion dispatch contract', () => {
    test('keeps the generate route and provider-specific dispatch cases', () => {
        const source = readSource(
            'src/endpoints/backends/chat-completions.js',
        );

        expect(source).toContain('router.post(\'/generate\'');
        for (const providerHandler of [
            'sendClaudeRequest',
            'sendAI21Request',
            'sendMakerSuiteRequest',
            'sendMistralAIRequest',
            'sendCohereRequest',
            'sendDeepSeekRequest',
            'sendAimlapiRequest',
            'sendXaiRequest',
            'sendChutesRequest',
            'sendMinimaxRequest',
            'sendElectronHubRequest',
            'sendAzureOpenAIRequest',
        ]) {
            expect(source).toContain(`return await ${providerHandler}(request, response);`);
        }
        expect(source).toContain('request.body.chat_completion_source');
        expect(source).toContain('readSecret(');
        expect(source).toContain('forwardFetchResponse(generateResponse, response)');
    });
});

describe('group-card rerun metadata contract', () => {
    test('keeps v1 source references, config, and run timestamps on created cards', () => {
        const stageSource = readSource(
            'public/scripts/bulk-combine/wizard/Stage5Avatar.js',
        );
        const creatorSource = readSource(
            'public/scripts/bulk-combine/services/CardCreator.js',
        );

        expect(stageSource).toContain('version: 1');
        expect(stageSource).toContain('sourceCharacterNames:');
        expect(stageSource).toContain('sourceCharacterAvatars:');
        expect(stageSource).toContain('createdAt: existingMeta?.createdAt');
        expect(stageSource).toContain('runCount: Number(existingMeta?.runCount ?? 0) + 1');
        expect(creatorSource).toContain('[GROUP_CARD_WIZARD_METADATA_KEY]: wizardMeta');
        expect(creatorSource).toContain('[group_card_wizard]');
    });

    test('keeps full rerun and quick-regeneration entry points', () => {
        const source = readSource('public/scripts/bulk-combine/index.js');

        expect(source).toContain('export async function runRegenWizardForCard');
        expect(source).toContain('export async function quickRegenGroupCard');
        expect(source).toContain('\'/api/characters/group-card-backup\'');
        expect(source).toContain('\'/api/characters/merge-attributes\'');
    });
});
