import { jest } from '@jest/globals';
import { SwarmOrchestrator } from '../../src/swarm/SwarmOrchestrator.js';
import { TaskStatus } from '../../src/types/index.js';
import type { InferenceTask, InferenceResult } from '../../src/types/index.js';

let idCounter = 0;
function nextId(): string { return `id-${++idCounter}`; }

function createMockTaskStore() {
    const tasks: InferenceTask[] = [];
    const results: InferenceResult[] = [];

    return {
        tasks,
        results,
        createTask: jest.fn(async (input: any): Promise<InferenceTask> => {
            const task: InferenceTask = {
                _id: nextId(),
                prompt: input.prompt,
                model: input.model,
                status: input.status ?? TaskStatus.PENDING,
                requesterPeerId: input.requesterPeerId,
                createdAt: Date.now(),
                parentTaskId: input.parentTaskId,
                chunkIndex: input.chunkIndex,
                totalChunks: input.totalChunks,
            };
            tasks.push(task);
            return task;
        }),
        getTask: jest.fn(async (id: string) => tasks.find((t) => t._id === id) ?? null),
        getPendingTasks: jest.fn(async () => tasks.filter((t) => t.status === TaskStatus.PENDING)),
        getResult: jest.fn(async (taskId: string) => results.find((r) => r.taskId === taskId) ?? null),
        completeTask: jest.fn(async (taskId: string, result: any) => {
            const task = tasks.find((t) => t._id === taskId);
            if (task) task.status = TaskStatus.COMPLETED;
            results.push({ _id: nextId(), ...result, completedAt: Date.now() });
        }),
        failTask: jest.fn(async (taskId: string, error: string) => {
            const task = tasks.find((t) => t._id === taskId);
            if (task) { task.status = TaskStatus.FAILED; task.error = error; }
        }),
        cancelTask: jest.fn(async (taskId: string) => {
            const task = tasks.find((t) => t._id === taskId);
            if (task && task.status === TaskStatus.PENDING) task.status = TaskStatus.CANCELLED;
        }),
        getTasksByParent: jest.fn(async (parentId: string) =>
            tasks.filter((t) => t.parentTaskId === parentId)),
    };
}

function createMockCryptoManager() {
    return {
        encrypt: jest.fn(async (text: string, _key: string) => `ENC:${text}`),
        decrypt: jest.fn(async (text: string, _key: string) => text.replace(/^ENC:/, '')),
    };
}

describe('SwarmOrchestrator', () => {
    beforeEach(() => { idCounter = 0; });

    test('should submit a single-chunk task', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        const taskId = await orch.submitPrompt('Hello world');
        expect(taskId).toBeDefined();
        expect(store.createTask).toHaveBeenCalledTimes(1);
        expect(store.createTask).toHaveBeenCalledWith(
            expect.objectContaining({
                prompt: 'Hello world',
                model: 'tinyllama',
                chunkIndex: 0,
                totalChunks: 1,
            }),
        );
    });

    test('should split prompt into N chunks (split-by-size)', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        // 300-char prompt, max 100 chars → 3 chunks
        const prompt = 'word '.repeat(60); // 300 chars
        await orch.submitPrompt(prompt, {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 100,
        });

        expect(store.createTask).toHaveBeenCalledTimes(3);
        // Check chunk indices
        const calls = (store.createTask as jest.Mock).mock.calls as any[];
        expect(calls[0][0].chunkIndex).toBe(0);
        expect(calls[1][0].chunkIndex).toBe(1);
        expect(calls[2][0].chunkIndex).toBe(2);
        expect(calls[0][0].totalChunks).toBe(3);
    });

    test('should respect word boundaries in split-by-size', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        const prompt = 'The quick brown fox jumps over the lazy dog repeatedly';
        await orch.submitPrompt(prompt, {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 25,
        });

        const calls = (store.createTask as jest.Mock).mock.calls as any[];
        // Each chunk should not break mid-word
        for (const call of calls) {
            const chunk: string = call[0].prompt;
            // Should not start or end with a partial word (unless it's a single word)
            expect(chunk.trim()).toBe(chunk);
        }
    });

    test('should aggregate results in correct order', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        const parentId = await orch.submitPrompt('chunk0 chunk1 chunk2', {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 10,
        });

        // Manually complete all chunks (simulating workers)
        for (const task of store.tasks) {
            task.status = TaskStatus.COMPLETED;
            store.results.push({
                _id: nextId(),
                taskId: task._id,
                response: `result-${task.chunkIndex}`,
                model: 'tinyllama',
                workerPeerId: 'worker-1',
                completedAt: Date.now(),
            });
        }

        const result = await orch.getResult(parentId);
        expect(result).toBe('result-0 result-1 result-2');
    });

    test('should report FAILED if any chunk fails', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        const parentId = await orch.submitPrompt('a b c', {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 3,
        });

        // Complete first, fail second
        store.tasks[0].status = TaskStatus.COMPLETED;
        store.results.push({
            _id: nextId(), taskId: store.tasks[0]._id,
            response: 'ok', model: 'tinyllama',
            workerPeerId: 'w', completedAt: Date.now(),
        });
        store.tasks[1].status = TaskStatus.FAILED;
        store.tasks[1].error = 'GPU error';

        const status = await orch.getStatus(parentId);
        expect(status.status).toBe(TaskStatus.FAILED);
    });

    test('should encrypt prompt when flag is set', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
            encryptionPublicKey: 'pub-key-123',
        });

        await orch.submitPrompt('secret data', { encrypt: true });

        expect(crypto.encrypt).toHaveBeenCalledWith('secret data', 'pub-key-123');
        const call = (store.createTask as jest.Mock).mock.calls[0][0] as any;
        expect(call.prompt).toBe('ENC:secret data');
        expect(call.encrypted).toBe(true);
    });

    test('should cancel all pending chunks', async () => {
        const store = createMockTaskStore();
        const crypto = createMockCryptoManager();
        const orch = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'peer-1',
            defaultModel: 'tinyllama',
        });

        const parentId = await orch.submitPrompt('a b c d e f', {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 5,
        });

        await orch.cancelTask(parentId);

        // All tasks with this parentId should be cancelled
        for (const task of store.tasks) {
            if (task.parentTaskId === parentId) {
                expect(task.status).toBe(TaskStatus.CANCELLED);
            }
        }
    });
});
