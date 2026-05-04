import { getConfigValue } from '../util.js';

/**
 * Adds the configured stable OpenRouter user identifier to an outgoing request body.
 * @template {Record<string, any>} T
 * @param {T} body Outgoing OpenRouter request body
 * @returns {T} The same request body for call-site convenience
 */
export function addOpenRouterUserIdentifier(body) {
    const userIdentifier = getConfigValue('userIdentifier');
    if (userIdentifier) {
        body.user = userIdentifier;
    }

    return body;
}
