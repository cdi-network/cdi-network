import { jest } from '@jest/globals';
import { Worker } from '../../src/swarm/Worker.js';
import { TaskStatus } from '../../src/types/index.js';
import type { InferenceTask } from '../../src/types/index.js';

/**
 * Creates a mock TaskStore for Worker tests.
 */
function createMockTaskStore(tasks: InferenceTask[] = []) {
    const db = [...tasks];

    return {
        getPendingTasks: jest.fn(async () => db.filter((t) => t.status === TaskStatus.PENDING)),
        claimTask: jest.fn(async (taskId: string, workerPeerId: string) => {
            const task = db.find((t) => t._id === taskId);
            if (!task || task.status !== TaskStatus.PENDING) {
                throw new Error(`Cannot claim ${taskId}`);
            }
            task.status = TaskStatus.CLAIMED;
            task.workerPeerId = workerPeerId;
            task.claimedAt = Date.now();
            return task;
        }),
        completeTask: jest.fn(async (taskId: string, result: any) => {
            const task = db.find((t) => t._id === taskId);
            if (task) task.status = TaskStatus.COMPLETED;
        }),
        failTask: jest.fn(async (taskId: string, error: string) => {
            const task = db.find((t) => t._id === taskId);
            if (task) task.status = TaskStatus.FAILED;
        }),
        getTask: jest.fn(async (taskId: string) => db.find((t) => t._id === taskId) ?? null),
    };
}

/**
 * Creates a mock OllamaClient for Worker tests.
 */
function createMockOllamaClient(responseText = 'Hello from AI') {
    return {
        generate: jest.fn(async () => ({
            model: 'tinyllama',
            response: responseText,
            done: true,
            total_duration: 1000000,
            eval_count: 10,
            prompt_eval_count: 5,
        })),
    };
}

function makeTask(overrides: Partial<InferenceTask> = {}): InferenceTask {
    return {
        _id: `task-${Math.random().toString(36).slice(2, 8)}`,
        prompt: 'Test prompt',
        model: 'tinyllama',
        status: TaskStatus.PENDING,
        requesterPeerId: 'requester-1',
        createdAt: Date.now(),
        ...overrides,
    };
}

describe('Worker', () => {
    test('should pick up a PENDING task matching its models', async () => {
        const task = makeTask({ model: 'tinyllama' });
        const store = createMockTaskStore([task]);
        const ollama = createMockOllamaClient();

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 1,
            pollIntervalMs: 50,
        });

        worker.start();
        // Wait for at least one polling cycle
        await new Promise((r) => setTimeout(r, 200));
        worker.stop();

        expect(store.claimTask).toHaveBeenCalledWith(task._id, 'worker-1');
        expect(ollama.generate).toHaveBeenCalled();
        expect(store.completeTask).toHaveBeenCalled();
    });

    test('should ignore tasks for models it does not serve', async () => {
        const task = makeTask({ model: 'llama3' });
        const store = createMockTaskStore([task]);
        const ollama = createMockOllamaClient();

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 1,
            pollIntervalMs: 50,
        });

        worker.start();
        await new Promise((r) => setTimeout(r, 200));
        worker.stop();

        expect(store.claimTask).not.toHaveBeenCalled();
        expect(ollama.generate).not.toHaveBeenCalled();
    });

    test('should not exceed maxConcurrent tasks', async () => {
        const tasks = [
            makeTask({ _id: 't1' }),
            makeTask({ _id: 't2' }),
            makeTask({ _id: 't3' }),
        ];

        const store = createMockTaskStore(tasks);
        // Slow ollama — takes 300ms per response
        const ollama = {
            generate: jest.fn(async () => {
                await new Promise((r) => setTimeout(r, 300));
                return {
                    model: 'tinyllama',
                    response: 'slow response',
                    done: true,
                    total_duration: 300000000,
                    eval_count: 10,
                    prompt_eval_count: 5,
                };
            }),
        };

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 1,
            pollIntervalMs: 50,
        });

        worker.start();
        await new Promise((r) => setTimeout(r, 150));

        // With maxConcurrent=1 and 300ms generate, at most 1 should be active
        expect(worker.getActiveTaskCount()).toBeLessThanOrEqual(1);

        // Wait for all to finish
        await new Promise((r) => setTimeout(r, 1200));
        worker.stop();

        // All 3 should eventually be claimed
        expect(store.claimTask).toHaveBeenCalledTimes(3);
    });

    test('should mark task COMPLETED on Ollama success', async () => {
        const task = makeTask();
        const store = createMockTaskStore([task]);
        const ollama = createMockOllamaClient('Success response');

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 2,
            pollIntervalMs: 50,
        });

        worker.start();
        await new Promise((r) => setTimeout(r, 200));
        worker.stop();

        expect(store.completeTask).toHaveBeenCalledWith(
            task._id,
            expect.objectContaining({
                taskId: task._id,
                response: 'Success response',
                workerPeerId: 'worker-1',
            }),
        );
    });

    test('should mark task FAILED on Ollama error', async () => {
        const task = makeTask();
        const store = createMockTaskStore([task]);
        const ollama = {
            generate: jest.fn(async () => { throw new Error('GPU out of memory'); }),
        };

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 1,
            pollIntervalMs: 50,
        });

        worker.start();
        await new Promise((r) => setTimeout(r, 200));
        worker.stop();

        expect(store.failTask).toHaveBeenCalledWith(task._id, 'GPU out of memory');
    });

    test('should stop gracefully', async () => {
        const task = makeTask();
        const store = createMockTaskStore([task]);
        const ollama = {
            generate: jest.fn(async () => {
                await new Promise((r) => setTimeout(r, 500));
                return {
                    model: 'tinyllama',
                    response: 'delayed response',
                    done: true,
                    total_duration: 500000000,
                    eval_count: 10,
                    prompt_eval_count: 5,
                };
            }),
        };

        const worker = new Worker(store as any, ollama as any, {
            peerId: 'worker-1',
            models: ['tinyllama'],
            maxConcurrent: 1,
            pollIntervalMs: 50,
        });

        worker.start();
        await new Promise((r) => setTimeout(r, 100));
        worker.stop();

        // Should not accept new tasks after stop
        expect(worker.getActiveTaskCount()).toBeLessThanOrEqual(1);
    });
});
