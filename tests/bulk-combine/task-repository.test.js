import { afterAll, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    BulkCombineTaskRepository,
    InvalidTaskIdError,
    TaskNotFoundError,
    TaskRevisionConflictError,
    TaskValidationError,
} from '../../src/util/bulk-combine/task-repository.js';
import { hashInputs } from '../../src/util/bulk-combine/task-state.js';

const tempRoots = [];
let root;
let repo;

async function makeRoot() {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'st-bulk-combine-'));
    tempRoots.push(directory);
    return directory;
}

async function overwriteTask(tasksRoot, task) {
    await fs.promises.writeFile(
        path.join(tasksRoot, task.id, 'task.json'),
        JSON.stringify(task),
        'utf8',
    );
}

beforeEach(async () => {
    root = await makeRoot();
    repo = new BulkCombineTaskRepository(root);
});

afterAll(async () => {
    await Promise.all(tempRoots.map(directory => fs.promises.rm(directory, { recursive: true, force: true })));
});

describe('BulkCombineTaskRepository', () => {
    test('creates, gets, lists, and updates tasks with a revision bump', async () => {
        const created = await repo.createTask({ name: 'First' });

        await expect(repo.getTask(created.id)).resolves.toEqual(created);
        await expect(repo.listTasks()).resolves.toEqual([{
            id: created.id,
            name: 'First',
            status: 'draft',
            currentPage: 1,
            archivedAt: null,
            updatedAt: created.updatedAt,
            lastActivityAt: created.lastActivityAt,
        }]);

        const updated = await repo.updateTask(created.id, task => {
            task.name = 'Renamed';
            task.currentPage = 2;
        }, { expectedRevision: 1 });

        expect(updated).toMatchObject({ name: 'Renamed', currentPage: 2, revision: 2 });
        expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));
        await expect(repo.getTask(created.id)).resolves.toEqual(updated);
    });

    test('round-trips a hash input revision through update and persistence', async () => {
        const task = await repo.createTask({ name: 'Hash revision' });
        const inputRevision = hashInputs({ prompt: 'Transform', sources: ['alpha'] });

        const updated = await repo.updateTask(task.id, draft => {
            draft.passes.transform1.inputRevision = inputRevision;
        }, { expectedRevision: 1 });

        expect(inputRevision).toMatch(/^[0-9a-f]{64}$/);
        expect(updated.passes.transform1.inputRevision).toBe(inputRevision);
        await expect(repo.getTask(task.id)).resolves.toMatchObject({
            passes: { transform1: { inputRevision } },
        });
    });

    test('rejects a non-record task returned by a mutator', async () => {
        const task = await repo.createTask({ name: 'Bad mutator' });

        await expect(repo.updateTask(task.id, () => 'invalid', { expectedRevision: 1 }))
            .rejects.toThrow(new TaskValidationError('Task mutator must return undefined or a record'));
        await expect(repo.getTask(task.id)).resolves.toMatchObject({ revision: 1, name: 'Bad mutator' });
    });

    test('throws a revision conflict containing the current task', async () => {
        const task = await repo.createTask({ name: 'Conflict' });
        await repo.updateTask(task.id, draft => {
            draft.name = 'Current';
        }, { expectedRevision: 1 });

        await expect(repo.updateTask(task.id, () => {}, { expectedRevision: 1 }))
            .rejects.toMatchObject({
                name: TaskRevisionConflictError.name,
                expectedRevision: 1,
                actualRevision: 2,
                currentTask: { name: 'Current', revision: 2 },
            });
    });

    test('deletes the task directory and reports missing tasks', async () => {
        const task = await repo.createTask({ name: 'Delete me' });
        const taskDirectory = path.join(root, task.id);

        await repo.deleteTask(task.id);

        await expect(fs.promises.access(taskDirectory)).rejects.toThrow();
        await expect(repo.getTask(task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
        await expect(repo.deleteTask(task.id)).rejects.toBeInstanceOf(TaskNotFoundError);
    });

    test('duplicates lifecycle state while retaining sources and outputs', async () => {
        const task = await repo.createTask({ name: 'Original' });
        const running = await repo.updateTask(task.id, draft => {
            draft.status = 'running';
            draft.activePass = 'transform1';
            draft.execution = { status: 'running', pass: 'transform1' };
            draft.sources = [{ key: 'alpha', name: 'Alpha' }];
            draft.passes.transform1 = {
                status: 'running',
                inputRevision: 1,
                items: { alpha: { status: 'succeeded', output: 'Kept output' } },
            };
        }, { expectedRevision: 1 });

        const duplicate = await repo.duplicateTask(task.id, { name: 'Duplicate' });

        expect(duplicate.id).not.toBe(task.id);
        expect(duplicate).toMatchObject({
            name: 'Duplicate',
            revision: 1,
            status: 'draft',
            archivedAt: null,
            activePass: null,
            sources: running.sources,
        });
        expect(duplicate.passes.transform1.items.alpha.output).toBe('Kept output');
        expect(duplicate.passes.transform1.status).toBe('pending');
        expect(duplicate.execution.status).toBe('idle');
    });

    test('archives and unarchives tasks', async () => {
        const task = await repo.createTask({ name: 'Archive' });
        const archived = await repo.setArchived(task.id, true);

        expect(archived.archivedAt).not.toBeNull();
        expect(archived.revision).toBe(2);

        const unarchived = await repo.setArchived(task.id, false);
        expect(unarchived.archivedAt).toBeNull();
        expect(unarchived.revision).toBe(3);
    });

    test('cleanup removes only expired unarchived tasks', async () => {
        const old = await repo.createTask({ name: 'Old' });
        const archived = await repo.createTask({ name: 'Archived old' });
        const recent = await repo.createTask({ name: 'Recent' });
        archived.archivedAt = '2026-01-01T00:00:00.000Z';
        old.lastActivityAt = '2026-01-01T00:00:00.000Z';
        archived.lastActivityAt = '2026-01-01T00:00:00.000Z';
        recent.lastActivityAt = '2026-01-09T12:00:00.000Z';
        await Promise.all([
            overwriteTask(root, old),
            overwriteTask(root, archived),
            overwriteTask(root, recent),
        ]);

        await expect(repo.cleanupExpired({
            now: Date.parse('2026-01-10T00:00:00.000Z'),
            ttlMs: 7 * 24 * 60 * 60 * 1000,
        })).resolves.toBe(1);
        await expect(repo.getTask(old.id)).rejects.toBeInstanceOf(TaskNotFoundError);
        await expect(repo.getTask(archived.id)).resolves.toMatchObject({ name: 'Archived old' });
        await expect(repo.getTask(recent.id)).resolves.toMatchObject({ name: 'Recent' });
    });

    test('recovers active pass and task statuses as interrupted', async () => {
        const task = await repo.createTask({ name: 'Interrupted' });
        await repo.updateTask(task.id, draft => {
            draft.status = 'running';
            draft.activePass = 'transform1';
            draft.execution.status = 'running';
            draft.passes.transform1.status = 'running';
            draft.passes.transform2.status = 'queued';
        }, { expectedRevision: 1 });

        await expect(repo.recoverInterrupted({ now: Date.parse('2026-02-01T00:00:00.000Z') })).resolves.toBe(1);
        const recovered = await repo.getTask(task.id);
        expect(recovered.status).toBe('interrupted');
        expect(recovered.activePass).toBeNull();
        expect(recovered.execution).toMatchObject({ status: 'interrupted', interruptedAt: '2026-02-01T00:00:00.000Z' });
        expect(recovered.passes.transform1.status).toBe('interrupted');
        expect(recovered.passes.transform2.status).toBe('interrupted');
        expect(recovered.passes.summary.status).toBe('pending');
    });

    test('continues recovery when a listed task is deleted before mutation', async () => {
        const deleted = await repo.createTask({ name: 'Deleted during recovery' });
        const survivor = await repo.createTask({ name: 'Recovery survivor' });
        for (const task of [deleted, survivor]) {
            await repo.updateTask(task.id, draft => {
                draft.status = 'running';
                draft.passes.transform1.status = 'running';
            }, { expectedRevision: 1 });
        }
        const listTasks = repo.listTasks.bind(repo);
        repo.listTasks = async () => {
            const summaries = await listTasks();
            await fs.promises.rm(path.join(root, deleted.id), { recursive: true, force: true });
            return [
                summaries.find(summary => summary.id === deleted.id),
                summaries.find(summary => summary.id === survivor.id),
            ];
        };

        await expect(repo.recoverInterrupted()).resolves.toBe(1);
        await expect(repo.getTask(survivor.id)).resolves.toMatchObject({
            status: 'interrupted',
            passes: { transform1: { status: 'interrupted' } },
        });
    });

    test('does not revise tasks when recovery finds no active passes', async () => {
        const task = await repo.createTask({ name: 'Already idle' });

        await expect(repo.recoverInterrupted()).resolves.toBe(0);
        await expect(repo.getTask(task.id)).resolves.toMatchObject({ revision: task.revision });
    });

    test('skips garbage task files during listing and maintenance', async () => {
        const garbageId = '00000000-0000-4000-8000-000000000099';
        const garbageDirectory = path.join(root, garbageId);
        await fs.promises.mkdir(garbageDirectory, { recursive: true });
        await fs.promises.writeFile(path.join(garbageDirectory, 'task.json'), 'not json', 'utf8');

        await expect(repo.listTasks()).resolves.toEqual([]);
        await expect(repo.recoverInterrupted()).resolves.toBe(0);
        await expect(repo.cleanupExpired()).resolves.toBe(0);
    });

    test('isolates repositories rooted in separate user directories', async () => {
        const secondRoot = await makeRoot();
        const secondRepo = new BulkCombineTaskRepository(secondRoot);
        await repo.createTask({ name: 'User one' });
        await secondRepo.createTask({ name: 'User two' });

        await expect(repo.listTasks()).resolves.toEqual([expect.objectContaining({ name: 'User one' })]);
        await expect(secondRepo.listTasks()).resolves.toEqual([expect.objectContaining({ name: 'User two' })]);
    });

    test('rejects traversal task ids', async () => {
        await expect(repo.getTask('../escape')).rejects.toBeInstanceOf(InvalidTaskIdError);
        await expect(repo.deleteTask('not-a-uuid')).rejects.toBeInstanceOf(InvalidTaskIdError);
    });

    test('serializes concurrent updates to one task in call order', async () => {
        const task = await repo.createTask({ name: 'Concurrent' });
        const order = [];
        const updates = Array.from({ length: 5 }, (_, index) => repo.updateTask(task.id, draft => {
            order.push(index);
            draft.review.count = (draft.review.count || 0) + 1;
        }, { expectedRevision: index + 1 }));

        const results = await Promise.all(updates);

        expect(order).toEqual([0, 1, 2, 3, 4]);
        expect(results.map(result => result.revision)).toEqual([2, 3, 4, 5, 6]);
        await expect(repo.getTask(task.id)).resolves.toMatchObject({ revision: 6, review: { count: 5 } });
    });

    test('checkpoints without an expected revision and serializes mutations', async () => {
        const task = await repo.createTask({ name: 'Checkpoints' });
        const checkpoints = Array.from({ length: 3 }, () => repo.checkpoint(task.id, draft => {
            draft.review.count = (draft.review.count || 0) + 1;
        }));

        const results = await Promise.all(checkpoints);

        expect(results.map(result => result.revision)).toEqual([2, 3, 4]);
        await expect(repo.getTask(task.id)).resolves.toMatchObject({
            revision: 4,
            review: { count: 3 },
        });
    });
});
