/**
 * zTracker cleanup target and pending-redaction helpers.
 *
 * Pending redactions are stored on message.extra.zTracker.pendingRedactions.
 */

const EXTENSION_KEY = 'zTracker';
const PENDING_REDACTIONS_KEY = 'pendingRedactions';
/** @type {1} */
const PENDING_REDACTIONS_VERSION = 1;

/**
 * @typedef {{kind: 'part', partKey: string}} CleanupPartTarget
 */

/**
 * @typedef {{kind: 'arrayItem', partKey: string, index: number}} CleanupArrayItemTarget
 */

/**
 * @typedef {{kind: 'arrayItemById', partKey: string, idKey: string, idValue: string}} CleanupArrayItemByIdTarget
 */

/**
 * @typedef {{kind: 'arrayItemField', partKey: string, idKey: string, idValue: string, fieldKey: string}} CleanupArrayItemFieldTarget
 */

/**
 * @typedef {{kind: 'field', partKey: string, fieldKey: string}} CleanupFieldTarget
 */

/**
 * @typedef {CleanupPartTarget|CleanupArrayItemTarget|CleanupArrayItemByIdTarget|CleanupArrayItemFieldTarget|CleanupFieldTarget} CleanupTarget
 */

/**
 * @typedef {{version: 1, targets: CleanupTarget[], schemaPresetKey: string}} PendingRedactions
 */

/**
 * Checks if a value is a non-array object.
 * @param {unknown} value Value to check.
 * @returns {value is Record<string, any>} True for plain object-like values.
 */
function isRecord(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Normalizes a non-empty string.
 * @param {unknown} value Value to normalize.
 * @returns {string|undefined} Trimmed string or undefined.
 */
function normalizeString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Normalizes a cleanup target to the native discriminated union.
 * Legacy zTracker target kinds are accepted for migration safety.
 * @param {unknown} target Candidate target.
 * @returns {CleanupTarget|undefined} Normalized target.
 */
function normalizeCleanupTarget(target) {
    if (!isRecord(target)) {
        return undefined;
    }

    const partKey = normalizeString(target.partKey);
    if (!partKey) {
        return undefined;
    }

    switch (target.kind) {
        case 'part':
            return { kind: 'part', partKey };

        case 'field': {
            const fieldKey = normalizeString(target.fieldKey);
            return fieldKey ? { kind: 'field', partKey, fieldKey } : undefined;
        }

        case 'arrayItem':
        case 'array-item': {
            if (Number.isInteger(target.index)) {
                return { kind: 'arrayItem', partKey, index: target.index };
            }

            const idKey = normalizeString(target.idKey);
            const idValue = normalizeString(target.idValue);
            return idKey && idValue
                ? { kind: 'arrayItemById', partKey, idKey, idValue }
                : undefined;
        }

        case 'arrayItemById': {
            const idKey = normalizeString(target.idKey);
            const idValue = normalizeString(target.idValue);
            return idKey && idValue
                ? { kind: 'arrayItemById', partKey, idKey, idValue }
                : undefined;
        }

        case 'arrayItemField':
        case 'array-item-field': {
            const fieldKey = normalizeString(target.fieldKey);
            if (!fieldKey) {
                return undefined;
            }

            const idKey = normalizeString(target.idKey);
            const idValue = normalizeString(target.idValue);
            if (idKey && idValue) {
                return { kind: 'arrayItemField', partKey, idKey, idValue, fieldKey };
            }

            return undefined;
        }

        default:
            return undefined;
    }
}

/**
 * Compares two cleanup targets for identity.
 * @param {CleanupTarget} left First target.
 * @param {CleanupTarget} right Second target.
 * @returns {boolean} True when targets address the same cleanup location.
 */
function isSameCleanupTarget(left, right) {
    if (left.kind !== right.kind || left.partKey !== right.partKey) {
        return false;
    }

    switch (left.kind) {
        case 'part':
            return true;
        case 'field':
            return (
                left.fieldKey === /** @type {CleanupFieldTarget} */ (right).fieldKey
            );
        case 'arrayItem':
            return left.index === /** @type {CleanupArrayItemTarget} */ (right).index;
        case 'arrayItemById': {
            const rightTarget = /** @type {CleanupArrayItemByIdTarget} */ (right);
            return (
                left.idKey === rightTarget.idKey && left.idValue === rightTarget.idValue
            );
        }
        case 'arrayItemField': {
            const rightTarget = /** @type {CleanupArrayItemFieldTarget} */ (right);
            return (
                left.idKey === rightTarget.idKey &&
                left.idValue === rightTarget.idValue &&
                left.fieldKey === rightTarget.fieldKey
            );
        }
        default:
            return false;
    }
}

/**
 * Checks if ancestor target makes child target redundant.
 * @param {CleanupTarget} ancestor Potential ancestor target.
 * @param {CleanupTarget} child Potential child target.
 * @returns {boolean} True when child is covered by ancestor.
 */
function isCleanupAncestor(ancestor, child) {
    if (ancestor.kind === 'part') {
        return ancestor.partKey === child.partKey;
    }

    if (ancestor.kind === 'arrayItemById' && child.kind === 'arrayItemField') {
        return (
            ancestor.partKey === child.partKey &&
            ancestor.idKey === child.idKey &&
            ancestor.idValue === child.idValue
        );
    }

    return false;
}

/**
 * Normalizes cleanup target list, removing duplicates and descendant targets.
 * @param {unknown[]} targets Cleanup target candidates.
 * @returns {CleanupTarget[]} Normalized cleanup targets.
 */
function normalizeCleanupTargets(targets) {
    if (!Array.isArray(targets)) {
        return [];
    }

    const normalized = [];
    for (const candidate of targets) {
        const target = normalizeCleanupTarget(candidate);
        if (!target) {
            continue;
        }
        if (normalized.some((existing) => isSameCleanupTarget(existing, target))) {
            continue;
        }
        if (normalized.some((existing) => isCleanupAncestor(existing, target))) {
            continue;
        }

        const filtered = normalized.filter(
            (existing) => !isCleanupAncestor(target, existing),
        );
        filtered.push(target);
        normalized.length = 0;
        normalized.push(...filtered);
    }

    return normalized;
}

/**
 * Ensures message.extra.zTracker exists.
 * @param {Record<string, any>} message Chat message object.
 * @returns {Record<string, any>} zTracker extension data object.
 */
function ensureZTrackerExtra(message) {
    if (!isRecord(message)) {
        throw new Error('Message is required');
    }

    message.extra = isRecord(message.extra) ? message.extra : {};
    message.extra[EXTENSION_KEY] = isRecord(message.extra[EXTENSION_KEY])
        ? message.extra[EXTENSION_KEY]
        : {};
    return message.extra[EXTENSION_KEY];
}

/**
 * Marks cleanup targets as pending redactions for later re-creation.
 * @param {Record<string, any>} message Chat message object to mutate.
 * @param {string} schemaPresetKey Schema preset key tied to the redactions.
 * @param {CleanupTarget[]} targets Cleanup targets.
 * @returns {PendingRedactions|undefined} Stored pending-redactions payload, or undefined when no targets remain.
 */
export function addPendingRedactions(message, schemaPresetKey, targets) {
    const normalizedTargets = normalizeCleanupTargets(targets);
    if (normalizedTargets.length === 0) {
        return undefined;
    }

    const normalizedSchemaPresetKey = normalizeString(schemaPresetKey);
    if (!normalizedSchemaPresetKey) {
        throw new Error('Schema preset key is required');
    }

    const extensionData = ensureZTrackerExtra(message);
    const pendingRedactions = {
        version: PENDING_REDACTIONS_VERSION,
        targets: normalizedTargets,
        schemaPresetKey: normalizedSchemaPresetKey,
    };
    extensionData[PENDING_REDACTIONS_KEY] = pendingRedactions;
    return pendingRedactions;
}

/**
 * Clears pending redactions from a message.
 * @param {Record<string, any>} message Chat message object to mutate.
 * @returns {void}
 */
export function clearPendingRedactions(message) {
    if (!isRecord(message?.extra?.[EXTENSION_KEY])) {
        return;
    }

    delete message.extra[EXTENSION_KEY][PENDING_REDACTIONS_KEY];
}

/**
 * Reads pending redactions from a message.
 * @param {Record<string, any>} message Chat message object.
 * @returns {PendingRedactions|undefined} Pending-redactions payload, if valid.
 */
export function getPendingRedactions(message) {
    const pendingRedactions =
        message?.extra?.[EXTENSION_KEY]?.[PENDING_REDACTIONS_KEY];
    if (!isRecord(pendingRedactions)) {
        return undefined;
    }

    const targets = normalizeCleanupTargets(pendingRedactions.targets);
    const schemaPresetKey = normalizeString(pendingRedactions.schemaPresetKey);
    if (targets.length === 0 || !schemaPresetKey) {
        return undefined;
    }

    return {
        version: PENDING_REDACTIONS_VERSION,
        targets,
        schemaPresetKey,
    };
}
