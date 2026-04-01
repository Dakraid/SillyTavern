/**
 * @typedef {{modelId?: number, modelVersionId?: number, sourceUrl?: string}} CivitaiLookupParts
 */

/**
 * Parse a user-provided CivitAI model input.
 * Supports:
 * - model URLs: https://civitai.com/models/<modelId>?modelVersionId=<versionId>
 * - model version URLs: https://civitai.com/model-versions/<versionId>
 * - download URLs: https://civitai.com/api/download/models/<versionId>
 * - raw IDs: <modelId>, model:<modelId>, version:<versionId>, or <modelId>@<versionId>
 * - AIR IDs: urn:air:<ecosystem>:<type>:civitai:<modelId>@<versionId>
 *
 * @param {string} raw
 * @returns {CivitaiLookupParts}
 */
export function parseCivitaiLookupInput(raw) {
    const value = String(raw || '').trim();

    if (!value) {
        return {};
    }

    const airMatch = value.match(/^(?:urn:)?air:[^:]+:[^:]+:civitai:(\d+)@(\d+)$/i);
    if (airMatch) {
        return {
            modelId: Number(airMatch[1]),
            modelVersionId: Number(airMatch[2]),
        };
    }

    const explicitVersionMatch = value.match(/^(?:version|mv):(\d+)$/i);
    if (explicitVersionMatch) {
        return {
            modelVersionId: Number(explicitVersionMatch[1]),
        };
    }

    const explicitModelMatch = value.match(/^model:(\d+)$/i);
    if (explicitModelMatch) {
        return {
            modelId: Number(explicitModelMatch[1]),
        };
    }

    const idPairMatch = value.match(/^(\d+)(?:@(\d+))?$/);
    if (idPairMatch) {
        return {
            modelId: Number(idPairMatch[1]),
            modelVersionId: idPairMatch[2] ? Number(idPairMatch[2]) : undefined,
        };
    }

    try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        const pathSegments = url.pathname.split('/').filter(Boolean);

        if (!hostname.endsWith('civitai.com')) {
            return {};
        }

        if (pathSegments[0] === 'models' && pathSegments[1]) {
            return {
                sourceUrl: url.toString(),
                modelId: Number(pathSegments[1]) || undefined,
                modelVersionId: Number(url.searchParams.get('modelVersionId')) || undefined,
            };
        }

        if (pathSegments[0] === 'model-versions' && pathSegments[1]) {
            return {
                sourceUrl: url.toString(),
                modelVersionId: Number(pathSegments[1]) || undefined,
            };
        }

        if (pathSegments[0] === 'model-versions' && pathSegments[1]) {
            return {
                sourceUrl: url.toString(),
                modelVersionId: Number(pathSegments[1]) || undefined,
            };
        }

        if (pathSegments[0] === 'api' && pathSegments[1] === 'download' && pathSegments[2] === 'models' && pathSegments[3]) {
            return {
                sourceUrl: url.toString(),
                modelVersionId: Number(pathSegments[3]) || undefined,
            };
        }
    } catch {
        // noop
    }

    return {};
}

/**
 * Convert a CivitAI resource type into AIR type.
 * @param {string} type
 * @returns {'checkpoint'|'lora'}
 */
export function getCivitaiAirType(type) {
    return String(type || '').toUpperCase() === 'LORA' ? 'lora' : 'checkpoint';
}

/**
 * Map a CivitAI base model label into an AIR ecosystem token.
 * @param {string} baseModel
 * @returns {string}
 */
export function mapBaseModelToAirEcosystem(baseModel) {
    const value = String(baseModel || '').trim().toLowerCase();

    if (!value) {
        return 'sdxl';
    }

    if (value.includes('flux')) return 'flux';
    if (value.includes('sd 1') || value.includes('sd1')) return 'sd1';
    if (value.includes('sd 2') || value.includes('sd2')) return 'sd2';
    if (value.includes('sd 3') || value.includes('sd3')) return 'sd3';
    if (value.includes('sdxl') || value.includes('pony') || value.includes('illustrious') || value.includes('noob')) return 'sdxl';

    return value
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'sdxl';
}

/**
 * Build a canonical CivitAI AIR identifier for generation workflows.
 * @param {{modelId: number|string, versionId: number|string, type: string, baseModel: string}} input
 * @returns {string}
 */
export function buildCivitaiAir({ modelId, versionId, type, baseModel }) {
    const ecosystem = mapBaseModelToAirEcosystem(baseModel);
    const airType = getCivitaiAirType(type);
    return `urn:air:${ecosystem}:${airType}:civitai:${modelId}@${versionId}`;
}

/**
 * Choose the best preview image URL from a CivitAI images array.
 * @param {any[]} images
 * @returns {string}
 */
export function pickCivitaiPreviewUrl(images) {
    if (!Array.isArray(images)) {
        return '';
    }

    const firstSafe = images.find(image => !image?.nsfw && typeof image?.url === 'string');
    const fallback = images.find(image => typeof image?.url === 'string');
    return String(firstSafe?.url || fallback?.url || '');
}

/**
 * Convert LoRA rows into CivitAI additionalNetworks shape.
 * @param {Array<{air?: string, strength?: number|string}>} loras
 * @returns {Record<string, {strength?: number}>|undefined}
 */
export function buildCivitaiAdditionalNetworks(loras) {
    if (!Array.isArray(loras)) {
        return undefined;
    }

    const entries = loras
        .map(lora => ({
            air: String(lora?.air || '').trim(),
            strength: Number(lora?.strength),
        }))
        .filter(lora => lora.air)
        .map(lora => [
            lora.air,
            Number.isFinite(lora.strength) ? { strength: lora.strength } : {},
        ]);

    if (entries.length === 0) {
        return undefined;
    }

    return Object.fromEntries(entries);
}

/**
 * Build a text-to-image workflow request body for CivitAI.
 * @param {{
 *   prompt: string,
 *   negativePrompt?: string,
 *   modelAir: string,
 *   width: number,
 *   height: number,
 *   steps?: number,
 *   cfgScale?: number,
 *   seed?: number,
 *   clipSkip?: number,
 *   loras?: Array<{air?: string, strength?: number|string}>
 * }} input
 * @returns {{steps: Array<{ $type: 'textToImage', input: Record<string, any> }>}}
 */
export function buildCivitaiWorkflowRequest(input) {
    const workflowInput = {
        model: input.modelAir,
        prompt: input.prompt,
        width: input.width,
        height: input.height,
    };

    if (input.negativePrompt) {
        workflowInput.negativePrompt = input.negativePrompt;
    }

    if (Number.isFinite(input.steps)) {
        workflowInput.steps = input.steps;
    }

    if (Number.isFinite(input.cfgScale)) {
        workflowInput.cfgScale = input.cfgScale;
    }

    if (Number.isFinite(input.seed) && Number(input.seed) >= 0) {
        workflowInput.seed = Number(input.seed);
    }

    if (Number.isFinite(input.clipSkip)) {
        workflowInput.clipSkip = Number(input.clipSkip);
    }

    const additionalNetworks = buildCivitaiAdditionalNetworks(input.loras);
    if (additionalNetworks) {
        workflowInput.additionalNetworks = additionalNetworks;
    }

    return {
        steps: [
            {
                $type: 'textToImage',
                input: workflowInput,
            },
        ],
    };
}
