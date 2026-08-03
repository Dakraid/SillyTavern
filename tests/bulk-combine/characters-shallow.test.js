/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */

import { beforeAll, describe, expect, test } from '@jest/globals';
import { fileURLToPath } from 'node:url';

let toShallow;

beforeAll(async () => {
    const { setConfigFilePath } = await import('../../src/util.js');
    setConfigFilePath(fileURLToPath(new URL('../../config.yaml', import.meta.url)));
    ({ toShallow } = await import('../../src/endpoints/characters.js'));
});

describe('character shallow list shape', () => {
    test('preserves the source bulk combine task id', () => {
        const shallow = toShallow({
            name: 'Group',
            avatar: 'group.png',
            data: {
                extensions: {
                    bulk_combine_task: 'task-13c',
                },
            },
        });

        expect(shallow.data.extensions.bulk_combine_task).toBe('task-13c');
    });
});
