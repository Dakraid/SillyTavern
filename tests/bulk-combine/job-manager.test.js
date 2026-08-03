/* eslint-disable playwright/prefer-web-first-assertions -- Jest/jsdom suite; no Playwright matchers. */
import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { withRetries } from '../../src/util/job-manager.js';

afterEach(() => {
    jest.useRealTimers();
});

describe('job manager retries', () => {
    test('does not retry a permanent 4xx response', async () => {
        const error = Object.assign(new Error('bad request'), { status: 400 });
        const task = jest.fn(async () => {
            throw error;
        });

        await expect(withRetries(task, undefined, 3)).rejects.toBe(error);
        expect(task).toHaveBeenCalledTimes(1);
    });

    test('still retries a transient server error', async () => {
        jest.useFakeTimers();
        const error = Object.assign(new Error('unavailable'), { status: 503 });
        const task = jest.fn()
            .mockRejectedValueOnce(error)
            .mockResolvedValueOnce('ok');

        const result = withRetries(task, undefined, 3);
        await jest.advanceTimersByTimeAsync(1000);

        await expect(result).resolves.toBe('ok');
        expect(task).toHaveBeenCalledTimes(2);
    });
});
