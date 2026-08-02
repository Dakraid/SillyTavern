import { describe, expect, jest, test } from '@jest/globals';

import { createTaskEventBus } from '../../src/util/bulk-combine/task-events.js';

function client(write = jest.fn()) {
    return {
        headers: {},
        setHeader(name, value) {
            this.headers[name] = value;
        },
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
        eventBus.subscribe('task-a', second);

        eventBus.emit('task-a', { type: 'progress', completed: 1 });
        unsubscribeFirst();
        eventBus.emit('task-a', { type: 'progress', completed: 2 });

        expect(first.headers['Content-Type']).toBe('text/event-stream');
        expect(first.write).toHaveBeenCalledTimes(1);
        expect(second.write).toHaveBeenNthCalledWith(1, 'data: {"type":"progress","completed":1}\n\n');
        expect(second.write).toHaveBeenNthCalledWith(2, 'data: {"type":"progress","completed":2}\n\n');
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
        expect(healthy.write).toHaveBeenCalledTimes(2);
    });
});
