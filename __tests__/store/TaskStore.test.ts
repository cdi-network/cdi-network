import os from 'os';
import path from 'path';
import fs from 'fs';
import { TaskStore } from '../../src/store/TaskStore.js';
import { OrbitDbManagerBuilder } from '../../src/core/OrbitDbManager.js';
import { TaskStatus } from '../../src/types/index.js';
import type { OrbitDbManager } from '../../src/core/OrbitDbManager.js';

const makeTempDir = (): string => {
    const dir = path.join(os.tmpdir(), `taskstore-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

describe('TaskStore', () => {
    let manager: OrbitDbManager;
    let store: TaskStore;

    beforeEach(async () => {
        const dir = makeTempDir();
        manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        store = new TaskStore(manager);
        await store.initialize();
    }, 30_000);

    afterEach(async () => {
        await store.close();
        await manager.stop();
    }, 30_000);

    test('should create a task with auto-generated ID and timestamp', async () => {
        const task = await store.createTask({
            prompt: 'Hello world',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        expect(task._id).toBeDefined();
        expect(task._id).toMatch(/^[0-9a-f-]{36}$/);
        expect(task.createdAt).toBeGreaterThan(0);
        expect(task.prompt).toBe('Hello world');
        expect(task.status).toBe(TaskStatus.PENDING);
    }, 30_000);

    test('should claim a PENDING task', async () => {
        const task = await store.createTask({
            prompt: 'test',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        const claimed = await store.claimTask(task._id, 'worker-1');
        expect(claimed.status).toBe(TaskStatus.CLAIMED);
        expect(claimed.workerPeerId).toBe('worker-1');
        expect(claimed.claimedAt).toBeGreaterThan(0);
    }, 30_000);

    test('should reject claiming an already CLAIMED task', async () => {
        const task = await store.createTask({
            prompt: 'test',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        await store.claimTask(task._id, 'worker-1');

        await expect(
            store.claimTask(task._id, 'worker-2')
        ).rejects.toThrow();
    }, 30_000);

    test('should complete a task and store result', async () => {
        const task = await store.createTask({
            prompt: 'test',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        await store.claimTask(task._id, 'worker-1');
        await store.completeTask(task._id, {
            taskId: task._id,
            response: 'Hello response',
            model: 'tinyllama',
            workerPeerId: 'worker-1',
        });

        const updated = await store.getTask(task._id);
        expect(updated?.status).toBe(TaskStatus.COMPLETED);

        const result = await store.getResult(task._id);
        expect(result).toBeDefined();
        expect(result?.response).toBe('Hello response');
    }, 30_000);

    test('should query pending tasks', async () => {
        // Create 5 tasks — 3 pending, 2 claimed
        for (let i = 0; i < 3; i++) {
            await store.createTask({
                prompt: `pending-${i}`,
                model: 'tinyllama',
                status: TaskStatus.PENDING,
                requesterPeerId: 'peer-A',
            });
        }
        const t4 = await store.createTask({
            prompt: 'claimed-1',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });
        await store.claimTask(t4._id, 'w1');

        const t5 = await store.createTask({
            prompt: 'claimed-2',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });
        await store.claimTask(t5._id, 'w2');

        const pending = await store.getPendingTasks();
        expect(pending.length).toBe(3);
        pending.forEach((t) => expect(t.status).toBe(TaskStatus.PENDING));
    }, 30_000);

    test('should fail a task', async () => {
        const task = await store.createTask({
            prompt: 'test',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        await store.claimTask(task._id, 'worker-1');
        await store.failTask(task._id, 'Model crashed');

        const updated = await store.getTask(task._id);
        expect(updated?.status).toBe(TaskStatus.FAILED);
    }, 30_000);

    test('should get tasks by requester', async () => {
        await store.createTask({
            prompt: 'p1',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });
        await store.createTask({
            prompt: 'p2',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-B',
        });
        await store.createTask({
            prompt: 'p3',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-A',
        });

        const tasksA = await store.getTasksByRequester('peer-A');
        expect(tasksA.length).toBe(2);
        tasksA.forEach((t) => expect(t.requesterPeerId).toBe('peer-A'));
    }, 30_000);
});
