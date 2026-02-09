import { jest } from '@jest/globals';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { SwarmNode } from '../../src/node/SwarmNode.js';
import type { NodeConfig } from '../../src/types/index.js';

const makeTempDir = (): string => {
    const dir = path.join(os.tmpdir(), `swarmnode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('SwarmNode', () => {
    let node: SwarmNode | null = null;

    afterEach(async () => {
        if (node) {
            await node.shutdown();
            node = null;
        }
    }, 30_000);

    test('should create a SwarmNode with valid config', async () => {
        node = await SwarmNode.create(makeConfig());

        expect(node).toBeDefined();
        expect(node.getPeerId()).toBeDefined();
        expect(typeof node.getPeerId()).toBe('string');
    }, 30_000);

    test('should expose submitPrompt and getResult methods', async () => {
        node = await SwarmNode.create(makeConfig());

        expect(typeof node.submitPrompt).toBe('function');
        expect(typeof node.getResult).toBe('function');
        expect(typeof node.shutdown).toBe('function');
    }, 30_000);

    test('should shut down gracefully', async () => {
        node = await SwarmNode.create(makeConfig());

        await node.shutdown();
        // After shutdown, node should not throw
        node = null; // Prevent double shutdown in afterEach
    }, 30_000);
});
