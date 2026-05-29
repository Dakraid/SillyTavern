import fs from 'node:fs';
import path from 'node:path';

const MAX_BACKUP_VERSIONS = 10;

function getBackupDir(charactersDir, avatarFilename) {
    const parsed = path.parse(avatarFilename);
    return path.join(charactersDir, `${parsed.name}.backups`);
}

function getCharacterPaths(charactersDir, avatarFilename) {
    const avatarPath = path.join(charactersDir, avatarFilename);
    const parsed = path.parse(avatarFilename);
    const jsonPath = path.join(charactersDir, `${parsed.name}.json`);
    return { avatarPath, jsonPath };
}

function createTimestamp() {
    return new Date().toISOString().replace(/[:.]/g, '-');
}

function pruneBackups(backupDir) {
    const backups = listBackupFiles(backupDir);
    const timestamps = [...new Set(backups.map((file) => file.timestamp))]
        .sort()
        .reverse();
    const staleTimestamps = timestamps.slice(MAX_BACKUP_VERSIONS);

    for (const timestamp of staleTimestamps) {
        for (const extension of ['.png', '.json']) {
            const filePath = path.join(backupDir, `${timestamp}${extension}`);
            if (fs.existsSync(filePath)) {
                fs.rmSync(filePath, { force: true });
            }
        }
    }
}

function listBackupFiles(backupDir) {
    if (!fs.existsSync(backupDir)) {
        return [];
    }

    return fs
        .readdirSync(backupDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .map((file) => {
            const parsed = path.parse(file);
            return { timestamp: parsed.name, file };
        })
        .filter(
            ({ timestamp, file }) =>
                timestamp &&
				['.png', '.json'].includes(path.extname(file).toLowerCase()),
        );
}

/**
 * Create a timestamped backup of a character PNG (and JSON metadata if present).
 * @param {string} charactersDir Absolute path to characters directory.
 * @param {string} avatarFilename Avatar filename.
 * @returns {{ timestamp: string, backupDir: string }} Backup info.
 */
export function createBackup(charactersDir, avatarFilename) {
    const { avatarPath, jsonPath } = getCharacterPaths(
        charactersDir,
        avatarFilename,
    );
    if (!fs.existsSync(avatarPath)) {
        throw new Error(`Avatar not found: ${avatarFilename}`);
    }

    const backupDir = getBackupDir(charactersDir, avatarFilename);
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = createTimestamp();

    fs.copyFileSync(avatarPath, path.join(backupDir, `${timestamp}.png`));
    if (fs.existsSync(jsonPath)) {
        fs.copyFileSync(jsonPath, path.join(backupDir, `${timestamp}.json`));
    }

    pruneBackups(backupDir);
    return { timestamp, backupDir };
}

/**
 * List available backups for a character.
 * @param {string} charactersDir Absolute path to characters directory.
 * @param {string} avatarFilename Avatar filename.
 * @returns {Array<{timestamp: string, files: string[]}>} Backups.
 */
export function listBackups(charactersDir, avatarFilename) {
    const backupDir = getBackupDir(charactersDir, avatarFilename);
    const byTimestamp = new Map();

    for (const { timestamp, file } of listBackupFiles(backupDir)) {
        if (!byTimestamp.has(timestamp)) {
            byTimestamp.set(timestamp, []);
        }
        byTimestamp.get(timestamp).push(file);
    }

    return [...byTimestamp.entries()]
        .map(([timestamp, files]) => ({ timestamp, files: files.sort() }))
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Restore a character from a backup.
 * @param {string} charactersDir Absolute path to characters directory.
 * @param {string} avatarFilename Avatar filename.
 * @param {string} timestamp Backup timestamp.
 * @returns {void}
 */
export function restoreBackup(charactersDir, avatarFilename, timestamp) {
    if (!/^[\w-]+$/.test(timestamp)) {
        throw new Error('Invalid backup timestamp');
    }

    const backupDir = getBackupDir(charactersDir, avatarFilename);
    const backupPngPath = path.join(backupDir, `${timestamp}.png`);
    const backupJsonPath = path.join(backupDir, `${timestamp}.json`);
    const { avatarPath, jsonPath } = getCharacterPaths(
        charactersDir,
        avatarFilename,
    );

    if (!fs.existsSync(backupPngPath)) {
        throw new Error(`Backup not found: ${timestamp}`);
    }

    fs.copyFileSync(backupPngPath, avatarPath);
    if (fs.existsSync(backupJsonPath)) {
        fs.copyFileSync(backupJsonPath, jsonPath);
    }
}
