/**
 * zTracker schema part helpers.
 *
 * Pure helpers for deriving tracker part metadata and replacing/redacting tracker values.
 * Functions return cloned tracker objects when modifying tracker data.
 */

/**
 * @typedef {Record<string, any>} JsonSchema
 */

/**
 * @typedef {{idKey?: string, fields?: string[], dependsOn?: string[]}} TrackerPartMeta
 */

/**
 * @typedef {{partsOrder: string[], partsMeta: Record<string, TrackerPartMeta>}} SchemaRenderMetadata
 */

/**
 * Returns top-level schema property keys in declared order.
 * @param {JsonSchema} schema JSON schema.
 * @returns {string[]} Top-level property keys.
 */
function getTopLevelSchemaKeys(schema) {
    const props = schema?.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return [];
    }

    return Object.keys(props);
}

/**
 * Normalizes a x-ztracker-dependsOn value.
 * @param {unknown} value Schema annotation value.
 * @returns {string[]} Dependency keys.
 */
function normalizeDependsOn(value) {
    if (typeof value === 'string') {
        return value.trim() ? [value.trim()] : [];
    }

    if (!Array.isArray(value)) {
        return [];
    }

    return value
        .filter((item) => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * Resolves stable top-level generation/render order, honoring x-ztracker-dependsOn.
 * Falls back to declared property order when dependency graph has a cycle.
 * @param {JsonSchema} schema JSON schema.
 * @returns {string[]} Ordered top-level part keys.
 */
function resolveTopLevelPartsOrder(schema) {
    const baseOrder = getTopLevelSchemaKeys(schema);
    if (baseOrder.length <= 1) {
        return baseOrder;
    }

    const props = schema?.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return baseOrder;
    }

    const nodes = new Set(baseOrder);
    const inDegree = new Map(baseOrder.map((key) => [key, 0]));
    const dependents = new Map(baseOrder.map((key) => [key, new Set()]));

    for (const key of baseOrder) {
        const deps = normalizeDependsOn(
            props[key]?.['x-ztracker-dependsOn'],
        ).filter((dep) => nodes.has(dep));
        for (const dep of deps) {
            inDegree.set(key, (inDegree.get(key) ?? 0) + 1);
            dependents.get(dep)?.add(key);
        }
    }

    const rank = new Map(baseOrder.map((key, index) => [key, index]));
    const ready = baseOrder.filter((key) => (inDegree.get(key) ?? 0) === 0);
    ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));

    const ordered = [];
    while (ready.length > 0) {
        const next = ready.shift();
        ordered.push(next);

        for (const dependent of dependents.get(next) ?? []) {
            const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
            inDegree.set(dependent, nextDegree);
            if (nextDegree === 0) {
                ready.push(dependent);
                ready.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
            }
        }
    }

    return ordered.length === baseOrder.length ? ordered : baseOrder;
}

/**
 * Gets the identity key for an object-array tracker part.
 * @param {JsonSchema} arraySchema Array schema or root schema when partKey is supplied.
 * @param {string} [partKey] Optional top-level part key.
 * @returns {string} Identity key, defaulting to name.
 */
export function getArrayItemIdentityKey(arraySchema, partKey = undefined) {
    const partDef =
        typeof partKey === 'string'
            ? arraySchema?.properties?.[partKey]
            : arraySchema;
    const key = partDef?.['x-ztracker-idKey'];
    return typeof key === 'string' && key.trim() ? key.trim() : 'name';
}

/**
 * Calculates tracker-part metadata for render and regeneration flows.
 * @param {JsonSchema} schema JSON schema.
 * @returns {Record<string, TrackerPartMeta>} Metadata by top-level part key.
 */
function buildPartsMeta(schema) {
    /** @type {Record<string, TrackerPartMeta>} */
    const meta = {};
    const props = schema?.properties;
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
        return meta;
    }

    for (const key of Object.keys(props)) {
        const def = props[key];
        if (def?.type !== 'array') {
            continue;
        }

        const idKey = getArrayItemIdentityKey(def);
        const dependsOn = normalizeDependsOn(def?.['x-ztracker-dependsOn']);
        const itemProps =
            def?.items?.type === 'object' ? def.items.properties : undefined;
        const fields =
            itemProps && typeof itemProps === 'object' && !Array.isArray(itemProps)
                ? Object.keys(itemProps).filter(
                    (fieldKey) => fieldKey !== idKey && fieldKey !== 'name',
                )
                : undefined;

        meta[key] = {
            idKey,
            ...(fields?.length ? { fields } : {}),
            ...(dependsOn.length ? { dependsOn } : {}),
        };
    }

    return meta;
}

/**
 * Returns render metadata derived from a schema.
 * @param {JsonSchema} schema JSON schema.
 * @returns {SchemaRenderMetadata} Parts order and metadata.
 */
export function getSchemaRenderMetadata(schema) {
    return {
        partsOrder: resolveTopLevelPartsOrder(schema),
        partsMeta: buildPartsMeta(schema),
    };
}

/**
 * Wraps a property schema as a strict top-level object schema.
 * @param {JsonSchema} schema Source schema.
 * @param {string} titleSuffix Title suffix.
 * @param {string} propertyName Wrapped property name.
 * @param {JsonSchema} propertySchema Wrapped property schema.
 * @returns {JsonSchema} Wrapped schema.
 */
function buildWrappedSchema(schema, titleSuffix, propertyName, propertySchema) {
    const wrappedSchema = {
        $schema: schema?.$schema ?? 'http://json-schema.org/draft-07/schema#',
        title: `${schema?.title ?? 'SceneTracker'}${titleSuffix}`,
        type: 'object',
        properties: {
            [propertyName]: propertySchema,
        },
        required: [propertyName],
    };

    if (schema?.definitions) {
        wrappedSchema.definitions = schema.definitions;
    }
    if (schema?.$defs) {
        wrappedSchema.$defs = schema.$defs;
    }

    return wrappedSchema;
}

/**
 * Builds a schema containing one top-level tracker part.
 * @param {JsonSchema} schema Source schema.
 * @param {string} partKey Top-level part key.
 * @returns {JsonSchema} Wrapped part schema.
 */
export function buildTopLevelPartSchema(schema, partKey) {
    const partDef = schema?.properties?.[partKey];
    if (!partDef) {
        throw new Error(`Unknown schema part: ${partKey}`);
    }

    return buildWrappedSchema(schema, 'Part', partKey, partDef);
}

/**
 * Merges a generated part object into current tracker data.
 * @param {unknown} tracker Current tracker data.
 * @param {string} partKey Part key to replace.
 * @param {Record<string, any>} partValue Object containing the part key.
 * @returns {Record<string, any>} Updated tracker data.
 */
export function mergeTrackerPart(tracker, partKey, partValue) {
    if (!partValue || typeof partValue !== 'object' || Array.isArray(partValue)) {
        throw new Error('Part response must be an object');
    }
    if (!(partKey in partValue)) {
        throw new Error(`Part response missing key: ${partKey}`);
    }

    const base =
        tracker && typeof tracker === 'object' && !Array.isArray(tracker)
            ? tracker
            : {};
    return {
        ...base,
        [partKey]: partValue[partKey],
    };
}

/**
 * Returns a clone of tracker data with one top-level part removed.
 * @param {unknown} tracker Current tracker data.
 * @param {string} partKey Part key to redact.
 * @returns {Record<string, any>} Redacted tracker data.
 */
export function redactTrackerPartValue(tracker, partKey) {
    if (!partKey) {
        throw new Error('Part key is required');
    }

    const base =
        tracker && typeof tracker === 'object' && !Array.isArray(tracker)
            ? structuredClone(tracker)
            : {};
    delete base[partKey];
    return base;
}

/**
 * Replaces one tracker array item by numeric index.
 * @param {unknown} tracker Current tracker data.
 * @param {string} arrayKey Top-level array key.
 * @param {number} index Item index.
 * @param {unknown} newItem Replacement item.
 * @returns {Record<string, any>} Updated tracker data.
 */
export function replaceTrackerArrayItem(tracker, arrayKey, index, newItem) {
    const base =
        tracker && typeof tracker === 'object' && !Array.isArray(tracker)
            ? structuredClone(tracker)
            : {};
    const arrayValue = base[arrayKey];
    if (!Array.isArray(arrayValue)) {
        throw new Error(`Tracker field is not an array: ${arrayKey}`);
    }
    if (!Number.isInteger(index) || index < 0 || index >= arrayValue.length) {
        throw new Error(`Array index out of range for ${arrayKey}: ${index}`);
    }

    arrayValue[index] = newItem;
    return base;
}

/**
 * Finds an array item index by identity key/value, preferring exact then unique case-insensitive match.
 * @param {unknown[]} items Array items.
 * @param {string} idKey Identity key.
 * @param {string} idValue Identity value.
 * @returns {number} Matching index, or -1.
 */
function findArrayItemIndexByIdentity(items, idKey, idValue) {
    if (!Array.isArray(items) || !idKey || !idValue) {
        return -1;
    }

    const exact = items.findIndex(
        (item) => item && typeof item === 'object' && item[idKey] === idValue,
    );
    if (exact !== -1) {
        return exact;
    }

    const lowered = String(idValue).toLowerCase();
    const matches = [];
    items.forEach((item, index) => {
        if (
            item &&
            typeof item === 'object' &&
            typeof item[idKey] === 'string' &&
            item[idKey].toLowerCase() === lowered
        ) {
            matches.push(index);
        }
    });

    return matches.length === 1 ? matches[0] : -1;
}

/**
 * Replaces one tracker array item by identity key/value.
 * @param {unknown} tracker Current tracker data.
 * @param {string} arrayKey Top-level array key.
 * @param {string} idKey Identity key.
 * @param {string} idValue Identity value.
 * @param {unknown} newItem Replacement item.
 * @returns {Record<string, any>} Updated tracker data.
 */
export function replaceTrackerArrayItemByIdentity(
    tracker,
    arrayKey,
    idKey,
    idValue,
    newItem,
) {
    const base =
        tracker && typeof tracker === 'object' && !Array.isArray(tracker)
            ? structuredClone(tracker)
            : {};
    const arrayValue = base[arrayKey];
    if (!Array.isArray(arrayValue)) {
        throw new Error(`Tracker field is not an array: ${arrayKey}`);
    }

    const index = findArrayItemIndexByIdentity(arrayValue, idKey, idValue);
    if (index === -1) {
        throw new Error(
            `Array item not found for ${arrayKey}.${idKey}: ${idValue}`,
        );
    }

    arrayValue[index] = newItem;
    return base;
}
