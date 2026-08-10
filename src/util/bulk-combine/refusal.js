const WINDOW = 300;

export const REFUSAL_PATTERNS = Object.freeze([
    /\bi(?:'m| am) sorry\b/,
    /\bsorry,\s*but\b/,
    /\bi (?:can't|cannot|can’t)\b/,
    /\bi(?:'m| am) unable\b/,
    /\bi(?:'m| am) not able to\b/,
    /\bi refuse\b/,
    /\bi (?:must|have to) decline\b/,
    /\bas an ai\b/,
    /\bagainst my (?:guidelines|programming)\b/,
    /\b(?:cannot|unable to) comply\b/,
    /\b(?:cannot|can't|can’t) fulfill\b/,
]);

/**
 * Detects common model refusal phrases near the start of a completion.
 * @param {unknown} text Completion text.
 * @returns {boolean} Whether the completion begins with refusal-like prose.
 */
export function isRefusal(text) {
    if (typeof text !== 'string') return false;
    const window = text.trim().slice(0, WINDOW).toLowerCase();
    return Boolean(window) && REFUSAL_PATTERNS.some(pattern => pattern.test(window));
}
