import fs from 'node:fs';
import path from 'node:path';

import sanitize from 'sanitize-filename';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import {
    JobManager,
    throwIfAborted,
    withRetries,
    runWithConcurrency,
} from './job-manager.js';
import { callLlmApi } from './group-card-job.js';

export class LorebookAIJobManager extends JobManager {
    constructor(options = {}) {
        super(options);
    }

    /**
	 * Creates a lorebook AI metadata generation job.
	 * @param {object} config Job config.
	 * @param {string} config.lorebookName Name of the lorebook.
	 * @param {string} config.worldsDir Path to worlds directory.
	 * @param {object} config.llm LLM configuration.
	 * @param {number} [config.concurrency=5] Parallel LLM requests.
	 * @param {number} [config.batchSize=10] Entries per LLM request.
	 * @param {boolean} [config.overwrite=false] Overwrite existing names.
	 * @param {{autoStart?: boolean}} [options] Job creation options.
	 * @returns {import('./job-manager.js').Job}
	 */
    createLorebookJob(config, options = {}) {
        const lorebookName = String(config?.lorebookName ?? '').trim();
        if (!lorebookName) {
            throw new Error('Lorebook name is required.');
        }
        if (!config?.worldsDir) {
            throw new Error('Worlds directory is required.');
        }

        const validatedConfig = {
            lorebookName,
            worldsDir: config.worldsDir,
            llm: config.llm ?? {},
            concurrency: Math.max(1, Math.min(20, Number(config.concurrency) || 5)),
            batchSize: Math.max(5, Math.min(50, Number(config.batchSize) || 10)),
            overwrite: Boolean(config.overwrite),
        };

        return this.createJob(validatedConfig, options);
    }

    /**
	 * Runs a lorebook AI metadata generation job.
	 * @param {string} jobId Job ID.
	 * @returns {Promise<void>}
	 */
    async runJob(jobId) {
        const job = this.getJob(jobId);
        if (!job || job.status !== 'pending') {
            return;
        }

        job.status = 'running';
        job.progress = { step: 'started' };
        this.emitEvent(jobId, 'job_started', { id: jobId });

        try {
            const signal = job.abortController?.signal;
            const config = job.config;
            const filename = sanitize(`${config.lorebookName}.json`);
            const filePath = path.join(config.worldsDir, filename);

            if (!fs.existsSync(filePath)) {
                throw new Error(`Lorebook file "${config.lorebookName}" not found.`);
            }

            const lorebookData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            const entries = lorebookData.entries || {};
            const entryList = Object.values(entries).filter(
                (entry) => entry && typeof entry === 'object' && !entry.disable,
            );

            if (!entryList.length) {
                throw new Error('No active entries found in lorebook.');
            }

            const needsGeneration = config.overwrite
                ? entryList
                : entryList.filter(
                    (entry) => !String(entry.aiFunctionName || '').trim(),
                );

            if (!needsGeneration.length) {
                job.status = 'completed';
                job.progress = { step: 'completed' };
                job.results = { generated: 0, skipped: entryList.length };
                this.emitEvent(jobId, 'job_completed', job.results);
                setTimeout(() => this.closeSseClients(job), 50);
                return;
            }

            this.emitEvent(jobId, 'generation_started', {
                total: needsGeneration.length,
                batchSize: config.batchSize,
                concurrency: config.concurrency,
            });

            const existingNames = new Set(
                entryList
                    .map((entry) => String(entry.aiFunctionName || '').trim())
                    .filter(Boolean),
            );

            let generated = 0;
            let failed = 0;

            const tasks = needsGeneration.map((entry, index) => async () => {
                throwIfAborted(signal);

                const entryUid = entry.uid;
                const entryComment = String(entry.comment || '').trim();
                const entryContent = String(entry.content || '')
                    .trim()
                    .substring(0, 500);

                this.emitEvent(jobId, 'entry_started', {
                    uid: entryUid,
                    index,
                    total: needsGeneration.length,
                    comment: entryComment,
                });

                try {
                    const prompt = buildLorebookMetadataPrompt(
                        entryComment,
                        entryContent,
                    );
                    const output = await withRetries(
                        () => callLlmApi(config.llm, prompt, signal),
                        signal,
                    );
                    const parsed = parseLlmMetadataOutput(output);
                    const name = sanitizeFunctionName(parsed.name, existingNames);
                    const description = String(parsed.description || '').substring(
                        0,
                        250,
                    );

                    existingNames.add(name);
                    entry.aiFunctionName = name;
                    if (!String(entry.aiDescription || '').trim() || config.overwrite) {
                        entry.aiDescription = description;
                    }

                    generated++;
                    this.emitEvent(jobId, 'entry_completed', {
                        uid: entryUid,
                        index,
                        total: needsGeneration.length,
                        name,
                        description,
                        generated,
                    });

                    return { ok: true, uid: entryUid, name, description };
                } catch (error) {
                    failed++;
                    const message = error?.message ?? String(error);
                    this.emitEvent(jobId, 'entry_failed', {
                        uid: entryUid,
                        index,
                        total: needsGeneration.length,
                        error: message,
                        failed,
                    });
                    return { ok: false, uid: entryUid, error: message };
                }
            });

            await runWithConcurrency(tasks, config.concurrency);
            throwIfAborted(signal);

            writeFileAtomicSync(filePath, JSON.stringify(lorebookData, null, 4));

            job.status = 'completed';
            job.progress = { step: 'completed' };
            job.results = { generated, failed, total: needsGeneration.length };
            this.emitEvent(jobId, 'job_completed', job.results);
            setTimeout(() => this.closeSseClients(job), 50);
        } catch (error) {
            if (job.abortController?.signal.aborted) {
                this.closeSseClients(job);
                return;
            }

            job.status = 'failed';
            job.error = error?.message ?? String(error);
            this.emitEvent(jobId, 'job_failed', { error: job.error });
            setTimeout(() => this.closeSseClients(job), 50);
        }
    }
}

export const lorebookAIJobManager = new LorebookAIJobManager();

process.once('SIGINT', () => lorebookAIJobManager.shutdown());
process.once('SIGTERM', () => lorebookAIJobManager.shutdown());

/**
 * Builds the LLM prompt for generating entry metadata.
 * @param {string} comment Entry comment/title.
 * @param {string} content Entry content.
 * @returns {string} Prompt.
 */
function buildLorebookMetadataPrompt(comment, content) {
    return `You are a naming assistant for a lorebook/world-info system. Given a lorebook entry, generate:
1. A function name with the prefix "get_" followed by a descriptive snake_case slug (lowercase, underscores only, no spaces). The name should be concise but descriptive of what the entry describes. Examples: "get_samus_aran", "get_beastworld_government", "get_spaceship_combat_rules", "get_magic_system".
2. A concise description of the entry's content, max 250 characters.

Entry comment/title: ${comment || '(no comment)'}

Entry content (truncated):
${content || '(empty)'}

Respond with ONLY valid JSON, no markdown, no explanation:
{"name": "get_<descriptive_slug>", "description": "<concise description>"}`;
}

/**
 * Parses LLM output for metadata JSON.
 * @param {string} output LLM output.
 * @returns {{name:string, description:string}} Parsed metadata.
 */
function parseLlmMetadataOutput(output) {
    let jsonStr = String(output || '').trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
        jsonStr = codeBlockMatch[1].trim();
    }

    try {
        const parsed = JSON.parse(jsonStr);
        return {
            name: String(parsed.name || ''),
            description: String(parsed.description || ''),
        };
    } catch {
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    name: String(parsed.name || ''),
                    description: String(parsed.description || ''),
                };
            } catch {
                // Fall through to empty metadata.
            }
        }
    }

    return { name: '', description: '' };
}

/**
 * Sanitizes a function name, ensures get_ prefix and uniqueness.
 * @param {string} rawName Raw generated name.
 * @param {Set<string>} existingNames Existing names.
 * @returns {string} Sanitized unique function name.
 */
function sanitizeFunctionName(rawName, existingNames) {
    let name = String(rawName || '').trim();

    if (!name.startsWith('get_')) {
        name = `get_${name}`;
    }

    name = name
        .replace(/[^a-zA-Z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase();

    if (!name.startsWith('get_')) {
        name = `get_${name}`;
    }

    if (!name || name === 'get_') {
        name = 'get_entry';
    }

    let finalName = name;
    let suffix = 1;
    while (existingNames.has(finalName)) {
        finalName = `${name}_${suffix++}`;
    }

    return finalName;
}
