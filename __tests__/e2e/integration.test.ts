/**
 * WS-8: Integration & E2E Tests
 *
 * These tests verify the full system works end-to-end, testing the integration
 * of all modules (OrbitDbManager, TaskStore, Worker, SwarmOrchestrator, SwarmNode).
 *
 * Note: Tests that involve actual Ollama inference are skipped unless OLLAMA_AVAILABLE=1
 * is set, since CI may not have a running Ollama instance.
 */
import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { SwarmNode } from '../../src/node/SwarmNode.js';
import { TaskStore } from '../../src/store/TaskStore.js';
import { OrbitDbManagerBuilder } from '../../src/core/OrbitDbManager.js';
import { SwarmOrchestrator } from '../../src/swarm/SwarmOrchestrator.js';
import { CryptoManager } from '../../src/crypto/CryptoManager.js';
import { TaskStatus } from '../../src/types/index.js';
import type { OrbitDbManager } from '../../src/core/OrbitDbManager.js';
import type { NodeConfig } from '../../src/types/index.js';

const makeTempDir = (): string => {
    const dir = path.join(os.tmpdir(), `e2e-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

function makeConfig(overrides: Partial<NodeConfig> = {}): NodeConfig {
    return {
        ollamaHost: '127.0.0.1',
        ollamaPort: 11434,
        orbitDbDirectory: makeTempDir(),
        bootstrapPeers: [],
        listenAddresses: [],
        models: ['tinyllama'],
        maxConcurrentTasks: 2,
        logLevel: 'info',
        ...overrides,
    };
}

describe('E2E: TaskStore + Orchestrator integration', () => {
    let manager: OrbitDbManager;
    let store: TaskStore;

    beforeEach(async () => {
        manager = await new OrbitDbManagerBuilder()
            .withDirectory(makeTempDir())
            .build();
        store = new TaskStore(manager);
        await store.initialize();
    }, 30_000);

    afterEach(async () => {
        await store.close();
        await manager.stop();
    }, 30_000);

    test('should create task via orchestrator and query it from store', async () => {
        const crypto = new CryptoManager();
        const orchestrator = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'test-peer',
            defaultModel: 'tinyllama',
        });

        const parentId = await orchestrator.submitPrompt('E2E test prompt');

        // Should be queryable in the store
        const pending = await store.getPendingTasks();
        expect(pending.length).toBe(1);
        expect(pending[0].prompt).toBe('E2E test prompt');
        expect(pending[0].parentTaskId).toBe(parentId);
    }, 30_000);

    test('should handle full task lifecycle: create → claim → complete → query result', async () => {
        const crypto = new CryptoManager();
        const orchestrator = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'test-peer',
            defaultModel: 'tinyllama',
        });

        const parentId = await orchestrator.submitPrompt('Lifecycle test');

        // Get the task
        const pending = await store.getPendingTasks();
        const task = pending[0];

        // Claim it
        await store.claimTask(task._id, 'worker-1');

        // Complete it
        await store.completeTask(task._id, {
            taskId: task._id,
            response: 'Test response',
            model: 'tinyllama',
            workerPeerId: 'worker-1',
        });

        // Query the result through orchestrator
        const result = await orchestrator.getResult(parentId);
        expect(result).toBe('Test response');
    }, 30_000);

    test('should handle chunked prompt lifecycle', async () => {
        const crypto = new CryptoManager();
        const orchestrator = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'test-peer',
            defaultModel: 'tinyllama',
        });

        // Submit a chunked prompt
        const prompt = 'word '.repeat(60); // 300 chars
        const parentId = await orchestrator.submitPrompt(prompt, {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 100,
        });

        // Should create 3 chunks
        const pending = await store.getPendingTasks();
        expect(pending.length).toBe(3);

        // Complete all chunks in order
        const tasks = await store.getTasksByParent(parentId);
        tasks.sort((a, b) => (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));

        for (let i = 0; i < tasks.length; i++) {
            await store.claimTask(tasks[i]._id, 'worker-1');
            await store.completeTask(tasks[i]._id, {
                taskId: tasks[i]._id,
                response: `chunk-${i}`,
                model: 'tinyllama',
                workerPeerId: 'worker-1',
            });
        }

        // Aggregated result should be in order
        const result = await orchestrator.getResult(parentId);
        expect(result).toBe('chunk-0 chunk-1 chunk-2');
    }, 30_000);

    test('should handle encrypted task lifecycle', async () => {
        const crypto = new CryptoManager();
        const keyPair = await crypto.generateKeyPair();
        const orchestrator = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'test-peer',
            defaultModel: 'tinyllama',
            encryptionPublicKey: keyPair.publicKey,
        });

        await orchestrator.submitPrompt('Secret prompt', { encrypt: true });

        // The stored prompt should be encrypted (not plaintext)
        const pending = await store.getPendingTasks();
        expect(pending.length).toBe(1);
        expect(pending[0].prompt).not.toBe('Secret prompt');
        expect(pending[0].encrypted).toBe(true);

        // Should be decryptable
        const decrypted = await crypto.decrypt(pending[0].prompt, keyPair.privateKey);
        expect(decrypted).toBe('Secret prompt');
    }, 30_000);

    test('should cancel pending chunks', async () => {
        const crypto = new CryptoManager();
        const orchestrator = new SwarmOrchestrator(store as any, crypto as any, {
            peerId: 'test-peer',
            defaultModel: 'tinyllama',
        });

        const prompt = 'word '.repeat(60);
        const parentId = await orchestrator.submitPrompt(prompt, {
            chunkStrategy: 'split-by-size',
            maxChunkSize: 100,
        });

        await orchestrator.cancelTask(parentId);

        const tasks = await store.getTasksByParent(parentId);
        tasks.forEach((t) => expect(t.status).toBe(TaskStatus.CANCELLED));
    }, 30_000);
});

describe('E2E: SwarmNode full assembly', () => {
    test('should create SwarmNode and verify all subsystems are operational', async () => {
        const node = await SwarmNode.create(makeConfig());

        expect(node.getPeerId()).toBeDefined();

        // Submit a prompt (won't complete since no real Ollama)
        const taskId = await node.submitPrompt('Integration test');
        expect(taskId).toBeDefined();
        expect(typeof taskId).toBe('string');

        await node.shutdown();
    }, 30_000);
});
