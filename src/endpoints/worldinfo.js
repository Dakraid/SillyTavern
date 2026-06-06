import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import _ from 'lodash';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { tryParse } from '../util.js';
import { lorebookAIJobManager } from '../util/lorebook-ai-job.js';
import { globalJobRegistry } from '../util/job-manager.js';

globalJobRegistry.register('lorebook-ai', lorebookAIJobManager);

/**
 * Reads a World Info file and returns its contents
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {string} worldInfoName Name of the World Info file
 * @param {boolean} allowDummy If true, returns an empty object if the file doesn't exist
 * @returns {object} World Info file contents
 */
export function readWorldInfoFile(directories, worldInfoName, allowDummy) {
    const dummyObject = allowDummy ? { entries: {} } : null;

    if (!worldInfoName) {
        return dummyObject;
    }

    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        console.error(`World info file ${filename} doesn't exist.`);
        return dummyObject;
    }

    const worldInfoText = fs.readFileSync(pathToWorldInfo, 'utf8');
    const worldInfo = JSON.parse(worldInfoText);
    return worldInfo;
}

export const router = express.Router();

router.post('/list', async (request, response) => {
    try {
        const data = [];
        const jsonFiles = (await fs.promises.readdir(request.user.directories.worlds, { withFileTypes: true }))
            .filter((file) => file.isFile() && path.extname(file.name).toLowerCase() === '.json')
            .sort((a, b) => a.name.localeCompare(b.name));

        for (const file of jsonFiles) {
            try {
                const filePath = path.join(request.user.directories.worlds, file.name);
                const fileContents = await fs.promises.readFile(filePath, 'utf8');
                const fileContentsParsed = tryParse(fileContents) || {};
                const fileExtensions = fileContentsParsed?.extensions || {};
                const fileNameWithoutExt = path.parse(file.name).name;
                const fileData = {
                    file_id: fileNameWithoutExt,
                    name: fileContentsParsed?.name || fileNameWithoutExt,
                    extensions: _.isObjectLike(fileExtensions) ? fileExtensions : {},
                };
                data.push(fileData);
            } catch (err) {
                console.warn(`Error reading or parsing World Info file ${file.name}:`, err);
            }
        }

        return response.send(data);
    } catch (err) {
        console.error('Error reading World Info directory:', err);
        return response.sendStatus(500);
    }
});

router.post('/get', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const file = readWorldInfoFile(request.user.directories, request.body.name, true);

    return response.send(file);
});

router.post('/delete', (request, response) => {
    if (!request.body?.name) {
        return response.sendStatus(400);
    }

    const worldInfoName = request.body.name;
    const filename = sanitize(`${worldInfoName}.json`);
    const pathToWorldInfo = path.join(request.user.directories.worlds, filename);

    if (!fs.existsSync(pathToWorldInfo)) {
        throw new Error(`World info file ${filename} doesn't exist.`);
    }

    fs.unlinkSync(pathToWorldInfo);

    return response.sendStatus(200);
});

router.post('/import', (request, response) => {
    if (!request.file) return response.sendStatus(400);

    const filename = `${path.parse(sanitize(request.file.originalname)).name}.json`;

    let fileContents = null;

    if (request.body.convertedData) {
        fileContents = request.body.convertedData;
    } else {
        const pathToUpload = path.join(request.file.destination, request.file.filename);
        fileContents = fs.readFileSync(pathToUpload, 'utf8');
        fs.unlinkSync(pathToUpload);
    }

    try {
        const worldContent = JSON.parse(fileContents);
        if (!('entries' in worldContent)) {
            throw new Error('File must contain a world info entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const pathToNewFile = path.join(request.user.directories.worlds, filename);
    const worldName = path.parse(pathToNewFile).name;

    if (!worldName) {
        return response.status(400).send('World file must have a name');
    }

    writeFileAtomicSync(pathToNewFile, fileContents);
    return response.send({ name: worldName });
});

router.post('/edit', (request, response) => {
    if (!request.body) {
        return response.sendStatus(400);
    }

    if (!request.body.name) {
        return response.status(400).send('World file must have a name');
    }

    try {
        if (!('entries' in request.body.data)) {
            throw new Error('World info must contain an entries list');
        }
    } catch (err) {
        return response.status(400).send('Is not a valid world info file');
    }

    const filename = sanitize(`${request.body.name}.json`);
    const pathToFile = path.join(request.user.directories.worlds, filename);

    writeFileAtomicSync(pathToFile, JSON.stringify(request.body.data, null, 4));

    return response.send({ ok: true });
});

// --- Lorebook AI Metadata Generation ---

router.post('/ai-generate', (request, response) => {
    try {
        if (!request.body?.lorebookName) {
            return response.status(400).json({ error: 'Lorebook name is required.' });
        }

        const config = {
            lorebookName: request.body.lorebookName,
            worldsDir: request.user.directories.worlds,
            llm: {
                ...(request.body.llm || {}),
                directories: request.user.directories,
            },
            concurrency: request.body.concurrency,
            batchSize: request.body.batchSize,
            overwrite: request.body.overwrite,
        };

        const job = lorebookAIJobManager.createLorebookJob(config);
        return response.json({ jobId: job.id });
    } catch (error) {
        return response.status(400).json({ error: error.message });
    }
});

router.get('/ai-jobs/:id/events', (request, response) => {
    const jobId = request.params.id;
    const job = lorebookAIJobManager.getJob(jobId);

    if (!job) {
        return response.status(404).json({ error: 'Job not found.' });
    }

    response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    response.flush?.();

    const lastEventId = Number(request.headers['last-event-id'] || 0);
    lorebookAIJobManager.addSseClient(jobId, response, lastEventId);

    request.on('close', () => {
        try {
            if (!response.writableEnded) {
                response.end();
            }
        } catch {
            // Ignore close errors.
        }
    });
});

router.get('/ai-jobs/:id', (request, response) => {
    const job = lorebookAIJobManager.getJob(request.params.id);
    if (!job) {
        return response.status(404).json({ error: 'Job not found.' });
    }
    return response.json(lorebookAIJobManager.serializeJob(job));
});

router.post('/ai-jobs/:id/cancel', (request, response) => {
    const cancelled = lorebookAIJobManager.cancelJob(request.params.id);
    if (!cancelled) {
        return response.status(404).json({ error: 'Job not found or already terminal.' });
    }
    return response.json({ ok: true });
});
