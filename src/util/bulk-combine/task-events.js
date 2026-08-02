export function createTaskEventBus() {
    const clientsByTask = new Map();

    function unsubscribe(taskId, response) {
        const clients = clientsByTask.get(taskId);
        if (!clients) return;
        clients.delete(response);
        if (clients.size === 0) clientsByTask.delete(taskId);
    }

    function emit(taskId, event) {
        const clients = clientsByTask.get(taskId);
        if (!clients) return;
        const message = `data: ${JSON.stringify(event)}\n\n`;
        for (const response of clients) {
            try {
                response.write(message);
            } catch {
                clients.delete(response);
            }
        }
        if (clients.size === 0) clientsByTask.delete(taskId);
    }

    function subscribe(taskId, response) {
        response.setHeader('Content-Type', 'text/event-stream');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
        const clients = clientsByTask.get(taskId) || new Set();
        clients.add(response);
        clientsByTask.set(taskId, clients);
        return () => unsubscribe(taskId, response);
    }

    return { emit, subscribe, unsubscribe };
}
