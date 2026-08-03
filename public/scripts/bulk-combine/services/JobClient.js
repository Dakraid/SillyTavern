'use strict';

/**
 * @file Shared JSON request helpers for bulk-combine services.
 */

import { getRequestHeaders } from '../../../script.js';

/**
 * Throws response text when an API request fails.
 *
 * @param {Response} response Fetch response.
 * @param {string} fallbackMessage Fallback failure message.
 * @returns {Promise<void>}
 */
export async function throwIfNotOk(response, fallbackMessage) {
    if (response.ok) {
        return;
    }

    const responseText = await response.text();
    throw new Error(responseText || fallbackMessage);
}

/**
 * Sends an API request and returns the fetch response.
 *
 * @param {string} url API endpoint.
 * @param {object} body JSON request body.
 * @returns {Promise<Response>} Fetch response.
 */
export async function sendJsonRequest(url, body) {
    return fetch(url, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
}
