/**
 * Reasoning prefill utilities for chat completion requests.
 * Used by both client (openai.js, custom-request.js) and server (chat-completions backend).
 * Isomorphic and dependency-free: no imports, no window/document access.
 * @module reasoning-prefill
 */

const THINK_REGEX = /^\s*<think>(.*?)(<\/think>|$)/s;

/**
 * Request types for which a reasoning prefill may be injected as a new trailing message.
 * The transform of an existing trailing assistant message is deliberately NOT type-gated.
 * @type {readonly string[]}
 */
export const REASONING_PREFILL_INJECT_TYPES = Object.freeze(['normal', 'regenerate', 'swipe']);

/**
 * Checks whether the request uses features that are incompatible with a reasoning prefill.
 * @param {object} generateData Generation payload
 * @returns {boolean} True if the prefill must be skipped
 */
function hasIncompatibleFeatures(generateData) {
    if (generateData.json_schema) {
        return true;
    }

    if (Array.isArray(generateData.tools) && generateData.tools.length > 0) {
        return true;
    }

    const messages = generateData.messages;
    if (Array.isArray(messages)) {
        for (const message of messages) {
            if (message && (message.role === 'tool' || message.tool_calls)) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Transforms the leading <think> block of a trailing assistant message into reasoning_content.
 * @param {object} message Trailing assistant message
 * @returns {boolean} True if the message was transformed
 */
function transformTrailingAssistant(message) {
    if (typeof message?.content !== 'string') {
        return false;
    }

    const match = THINK_REGEX.exec(message.content);
    if (!match) {
        return false;
    }

    const captured = match[1];
    if (message.reasoning_content) {
        message.reasoning_content = captured + '\n' + message.reasoning_content;
    } else {
        message.reasoning_content = captured;
    }
    message.content = message.content.slice(match[0].length);
    message.partial = true;

    return true;
}

/**
 * Applies a reasoning prefill to a generation payload, if eligible.
 * Shared core of the client and server wrappers.
 * @param {object} generateData Generation payload (mutated in place)
 * @param {string} prefill Trimmed reasoning prefill text
 * @param {boolean} allowInject Whether injecting a new trailing assistant message is allowed
 * @returns {boolean} True if the payload was modified
 */
function applyPrefillCore(generateData, prefill, allowInject) {
    if (!prefill) {
        return false;
    }

    if (hasIncompatibleFeatures(generateData)) {
        return false;
    }

    const messages = generateData.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    const lastMessage = messages[messages.length - 1];

    if (lastMessage?.role === 'assistant') {
        if (!transformTrailingAssistant(lastMessage)) {
            return false;
        }
    } else if (allowInject) {
        messages.push({
            role: 'assistant',
            content: '',
            reasoning_content: prefill,
            partial: true,
        });
    } else {
        return false;
    }

    generateData.include_reasoning = true;
    return true;
}

/**
 * Applies the configured reasoning prefill to a client-side generation payload.
 * Seeds the model's reasoning by injecting a trailing partial assistant message carrying
 * reasoning_content, or by transforming an existing trailing assistant message's leading
 * <think> block. Skipped for structured output and tool-using requests; injection is
 * additionally gated to normal/regenerate/swipe request types. Never throws.
 * @param {object} generateData Generation payload (mutated in place)
 * @param {string} type Request type (normal, regenerate, swipe, quiet, impersonate, continue, ...)
 * @param {string} prefill Reasoning prefill text from settings
 * @returns {boolean} True if the payload was modified
 */
export function applyReasoningPrefill(generateData, type, prefill) {
    try {
        if (!generateData || typeof generateData !== 'object') {
            return false;
        }

        const trimmedPrefill = String(prefill ?? '').trim();
        const allowInject = REASONING_PREFILL_INJECT_TYPES.includes(type);
        return applyPrefillCore(generateData, trimmedPrefill, allowInject);
    } catch {
        return false;
    }
}

/**
 * Applies a reasoning prefill to a programmatic (server-side) chat completion body.
 * Same semantics as the client wrapper, minus type gating: injection and transform are
 * always allowed when eligible. The reasoning_prefill key is ALWAYS stripped from the
 * body so it is never forwarded upstream. Never throws.
 * @param {object} body Request body (mutated in place)
 * @returns {boolean} True if the body was modified
 */
export function applyProgrammaticReasoningPrefill(body) {
    try {
        if (!body || typeof body !== 'object') {
            return false;
        }

        const prefill = String(body.reasoning_prefill ?? '').trim();
        delete body.reasoning_prefill;
        return applyPrefillCore(body, prefill, true);
    } catch {
        return false;
    }
}
