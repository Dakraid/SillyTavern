import { describe, expect, jest, test } from '@jest/globals';

import { createTaskEventBus } from '../../src/util/bulk-combine/task-events.js';

function client(write = jest.fn()) {
    return {
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
        flushHeaders: jest.fn(),
        flush: jest.fn(),
        write,
    };
}

describe('Bulk Combine task event bus', () => {
    test('drops events when no clients are subscribed', () => {
        const eventBus = createTaskEventBus();

        expect(() => eventBus.emit('task-a', { type: 'progress' })).not.toThrow();
    });

    test('fans events out to every subscriber and supports unsubscribe', () => {
        const eventBus = createTaskEventBus();
        const first = client();
        const second = client();
        const unsubscribeFirst = eventBus.subscribe('task-a', first);
        const unsubscribeSecond = eventBus.subscribe('task-a', second);

        eventBus.emit('task-a', { type: 'progress', completed: 1 });
        unsubscribeFirst();
        eventBus.emit('task-a', { type: 'progress', completed: 2 });

        expect(first.headers['Content-Type']).toBe('text/event-stream');
        expect(first.flushHeaders).toHaveBeenCalledTimes(1);
        expect(first.write).toHaveBeenNthCalledWith(1, ': connected\n\n');
        expect(first.write).toHaveBeenNthCalledWith(2, 'data: {"type":"progress","completed":1}\n\n');
        expect(first.write).toHaveBeenCalledTimes(2);
        expect(second.write).toHaveBeenNthCalledWith(2, 'data: {"type":"progress","completed":1}\n\n');
        expect(second.write).toHaveBeenNthCalledWith(3, 'data: {"type":"progress","completed":2}\n\n');
        expect(second.flush).toHaveBeenCalledTimes(3);
        unsubscribeSecond();
    });

    test('drops a throwing client without breaking healthy subscribers', () => {
        const eventBus = createTaskEventBus();
        const throwingWrite = jest.fn(() => {
            throw new Error('closed');
        });
        const closed = client(throwingWrite);
        const healthy = client();
        eventBus.subscribe('task-a', closed);
        eventBus.subscribe('task-a', healthy);

        eventBus.emit('task-a', { type: 'first' });
        eventBus.emit('task-a', { type: 'second' });

        expect(throwingWrite).toHaveBeenCalledTimes(1);
        expect(healthy.write).toHaveBeenCalledTimes(3);
    });

    test('flushes heartbeat comments and stops them after unsubscribe', async () => {
        jest.useFakeTimers();
        const eventBus = createTaskEventBus({ heartbeatIntervalMs: 1000 });
        const response = client();
        const unsubscribe = eventBus.subscribe('task-a', response);

        await jest.advanceTimersByTimeAsync(2000);
        expect(response.write).toHaveBeenNthCalledWith(2, ': heartbeat\n\n');
        expect(response.write).toHaveBeenNthCalledWith(3, ': heartbeat\n\n');
        expect(response.flush).toHaveBeenCalledTimes(3);

        unsubscribe();
        await jest.advanceTimersByTimeAsync(1000);
        expect(response.write).toHaveBeenCalledTimes(3);
        jest.useRealTimers();
    });

    test('reaps a client when a heartbeat write detects a broken connection', async () => {
        jest.useFakeTimers();
        const write = jest.fn()
            .mockImplementationOnce(() => undefined)
            .mockImplementationOnce(() => {
                throw new Error('closed');
            });
        const eventBus = createTaskEventBus({ heartbeatIntervalMs: 1000 });
        const response = client(write);
        eventBus.subscribe('task-a', response);

        await jest.advanceTimersByTimeAsync(1000);
        eventBus.emit('task-a', { type: 'after-close' });

        expect(write).toHaveBeenCalledTimes(2);
        jest.useRealTimers();
    });
});
