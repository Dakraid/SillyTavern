const HEARTBEAT_INTERVAL_MS = 15_000;

export function createTaskEventBus({ heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
    const clientsByTask = new Map();
    const heartbeats = new Map();

    function unsubscribe(taskId, response) {
        const heartbeat = heartbeats.get(response);
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeats.delete(response);
        }
        const clients = clientsByTask.get(taskId);
        if (!clients) return;
        clients.delete(response);
        if (clients.size === 0) clientsByTask.delete(taskId);
    }

    function write(taskId, response, message) {
        if (response.writableEnded) {
            unsubscribe(taskId, response);
            return;
        }
        try {
            response.write(message);
            response.flush?.();
        } catch {
            unsubscribe(taskId, response);
        }
    }

    function emit(taskId, event) {
        const clients = clientsByTask.get(taskId);
        if (!clients) return;
        const message = `data: ${JSON.stringify(event)}\n\n`;
        for (const response of [...clients]) write(taskId, response, message);
    }

    function subscribe(taskId, response) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        response.flushHeaders?.();

        const clients = clientsByTask.get(taskId) || new Set();
        clients.add(response);
        clientsByTask.set(taskId, clients);
        write(taskId, response, ': connected\n\n');

        if (clients.has(response)) {
            const heartbeat = setInterval(() => write(taskId, response, ': heartbeat\n\n'), heartbeatIntervalMs);
            heartbeat.unref?.();
            heartbeats.set(response, heartbeat);
        }
        return () => unsubscribe(taskId, response);
    }

    return { emit, subscribe, unsubscribe };
}
