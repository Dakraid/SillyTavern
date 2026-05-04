import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';

import { OPENROUTER_KEYS } from '../src/constants.js';
import { addOpenRouterUserIdentifier } from '../src/endpoints/openrouter-user.js';
import { setConfigFilePath } from '../src/util.js';

const envKey = 'SILLYTAVERN_USERIDENTIFIER';
const originalUserIdentifier = process.env[envKey];
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readSource(relativePath) {
    return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

describe('OpenRouter user identifier propagation', () => {
    beforeAll(() => {
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sillytavern-openrouter-user-'));
        const configPath = path.join(configDir, 'config.yaml');
        fs.writeFileSync(configPath, '{}\n');
        setConfigFilePath(configPath);
    });

    afterEach(() => {
        if (originalUserIdentifier === undefined) {
            delete process.env[envKey];
        } else {
            process.env[envKey] = originalUserIdentifier;
        }
    });

    test('adds configured userIdentifier to an outgoing OpenRouter body', () => {
        process.env[envKey] = 'stable-user-123';
        const body = { model: 'openrouter/model' };

        const result = addOpenRouterUserIdentifier(body);

        expect(result).toBe(body);
        expect(body).toEqual({ model: 'openrouter/model', user: 'stable-user-123' });
    });

    test('does not add user when userIdentifier is not configured', () => {
        delete process.env[envKey];
        const body = { model: 'openrouter/model' };

        addOpenRouterUserIdentifier(body);

        expect(body).toEqual({ model: 'openrouter/model' });
    });

    test('does not add user when userIdentifier is empty', () => {
        process.env[envKey] = '';
        const body = { model: 'openrouter/model' };

        addOpenRouterUserIdentifier(body);

        expect(body).toEqual({ model: 'openrouter/model' });
    });

    test('legacy text OpenRouter filtering still drops client-supplied user before helper adds configured user', () => {
        expect(OPENROUTER_KEYS).not.toContain('user');

        const source = readSource('src/endpoints/backends/text-completions.js');
        const filterIndex = source.indexOf('request.body = _.pickBy(request.body, (_, key) => OPENROUTER_KEYS.includes(key));');
        const helperIndex = source.indexOf('addOpenRouterUserIdentifier(request.body);', filterIndex);
        const stringifyIndex = source.indexOf('args.body = JSON.stringify(request.body);', helperIndex);

        expect(filterIndex).toBeGreaterThan(-1);
        expect(helperIndex).toBeGreaterThan(filterIndex);
        expect(stringifyIndex).toBeGreaterThan(helperIndex);
    });

    test('scoped OpenRouter chat-completions call sites apply the configured userIdentifier to serialized bodies', () => {
        const chatCompletionsSource = readSource('src/endpoints/backends/chat-completions.js');
        const openAiSource = readSource('src/endpoints/openai.js');
        const openRouterSource = readSource('src/endpoints/openrouter.js');

        expect(chatCompletionsSource).toContain("import { addOpenRouterUserIdentifier } from '../openrouter-user.js';");
        expect(chatCompletionsSource).toContain('addOpenRouterUserIdentifier(bodyParams);');
        expect(openAiSource).toContain("import { addOpenRouterUserIdentifier } from './openrouter-user.js';");
        expect(openAiSource).toContain('addOpenRouterUserIdentifier(body);');
        expect(openAiSource).not.toContain('request.body.user =');

        const helperCalls = openRouterSource.match(/addOpenRouterUserIdentifier\(\{/g) ?? [];
        expect(helperCalls).toHaveLength(3);
        expect(openRouterSource).toContain('body: JSON.stringify(body)');
    });
});
