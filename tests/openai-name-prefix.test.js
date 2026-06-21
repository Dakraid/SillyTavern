import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
);

const readSource = (relativePath) =>
    fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');

describe('OpenAI message name prefixing', () => {
    test('guards name prefixes against missing synthetic message names', () => {
        const source = readSource('public/scripts/openai.js');

        expect(source).toContain(
            'typeof chat[j].name === \'string\' && chat[j].name.trim().length > 0',
        );
        expect(source).toContain(
            'const messageName = hasValidName ? chat[j].name.trim() : \'\';',
        );
        expect(source).toContain(
            'selected_group && hasValidName && messageName !== name1',
        );
        expect(source).toContain(
            'hasValidName &&\n\t\t\t\t\tchat[j].extra?.type !== system_message_types.NARRATOR',
        );
        expect(source).not.toContain('`${chat[j].name}: ${content}`');
    });
});
