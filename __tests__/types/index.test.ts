import {
    TaskStatus,
    type InferenceTask,
    type InferenceResult,
    type OllamaOptions,
    type OllamaGenerateRequest,
    type OllamaGenerateResponse,
    type OllamaModelInfo,
    type EncryptionModule,
    type KeyPair,
    type NodeConfig,
    type SwarmEvents,
} from '../../src/types/index.js';

describe('Shared Types', () => {
    test('TaskStatus enum has all expected values', () => {
        expect(TaskStatus.PENDING).toBe('PENDING');
        expect(TaskStatus.CLAIMED).toBe('CLAIMED');
        expect(TaskStatus.RUNNING).toBe('RUNNING');
        expect(TaskStatus.COMPLETED).toBe('COMPLETED');
        expect(TaskStatus.FAILED).toBe('FAILED');
        expect(TaskStatus.CANCELLED).toBe('CANCELLED');
    });

    test('InferenceTask satisfies the interface contract', () => {
        const task: InferenceTask = {
            _id: 'test-id',
            prompt: 'Hello',
            model: 'tinyllama',
            status: TaskStatus.PENDING,
            requesterPeerId: 'peer-1',
            createdAt: Date.now(),
        };
        expect(task._id).toBe('test-id');
        expect(task.status).toBe(TaskStatus.PENDING);
    });

    test('InferenceResult satisfies the interface contract', () => {
        const result: InferenceResult = {
            _id: 'result-1',
            taskId: 'task-1',
            response: 'world',
            model: 'tinyllama',
            workerPeerId: 'peer-2',
            completedAt: Date.now(),
        };
        expect(result.taskId).toBe('task-1');
    });

    test('NodeConfig satisfies the interface contract', () => {
        const config: NodeConfig = {
            ollamaHost: '127.0.0.1',
            ollamaPort: 11434,
            orbitDbDirectory: './orbitdb',
            bootstrapPeers: [],
            listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
            models: ['tinyllama'],
            maxConcurrentTasks: 2,
            logLevel: 'info',
        };
        expect(config.ollamaHost).toBe('127.0.0.1');
    });
});
