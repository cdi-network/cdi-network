/**
 * WS-P2: PipelineRegistry TDD Tests
 *
 * Validates node/layer discovery for pipeline assembly:
 * 1. Register a node and discover it
 * 2. Assemble full pipeline from multiple nodes covering all layers
 * 3. Detect gaps in layer coverage
 * 4. Mark unresponsive nodes as offline
 */
import { jest } from '@jest/globals';
import { PipelineRegistry, type NodeRegistration } from '../../src/pipeline/PipelineRegistry.js';

// In-memory store mock (simulates OrbitDB KeyValue)
function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: jest.fn(async (entry: any) => { data.set(entry._id, entry); }),
        get: jest.fn(async (id: string) => data.get(id) ?? null),
        del: jest.fn(async (id: string) => { data.delete(id); }),
        all: jest.fn(async () => Array.from(data.entries()).map(([key, value]) => ({ key, value }))),
        _data: data,
    };
}

describe('WS-P2: PipelineRegistry', () => {

    test('should register a node and discover it', async () => {
        const store = createMockStore();
        const registry = new PipelineRegistry(store as any);

        await registry.registerNode({
            nodeId: 'node-1',
            peerId: 'peer-abc',
            host: '192.168.1.10',
            port: 8080,
            startLayer: 0,
            endLayer: 9,
            model: 'deepseek-r1',
        });

        const nodes = await registry.getRegisteredNodes();
        expect(nodes.length).toBe(1);
        expect(nodes[0].nodeId).toBe('node-1');
        expect(nodes[0].startLayer).toBe(0);
        expect(nodes[0].endLayer).toBe(9);
        expect(nodes[0].status).toBe('online');
    });

    test('should assemble full pipeline from multiple nodes', async () => {
        const store = createMockStore();
        const registry = new PipelineRegistry(store as any);

        await registry.registerNode({
            nodeId: 'n0', peerId: 'p0', host: '10.0.0.1', port: 8080,
            startLayer: 0, endLayer: 19, model: 'deepseek-r1',
        });
        await registry.registerNode({
            nodeId: 'n1', peerId: 'p1', host: '10.0.0.2', port: 8080,
            startLayer: 20, endLayer: 39, model: 'deepseek-r1',
        });
        await registry.registerNode({
            nodeId: 'n2', peerId: 'p2', host: '10.0.0.3', port: 8080,
            startLayer: 40, endLayer: 60, model: 'deepseek-r1',
        });

        const pipeline = await registry.discoverPipeline('deepseek-r1', 61);
        expect(pipeline.length).toBe(3);
        // Should be ordered by startLayer
        expect(pipeline[0].nodeId).toBe('n0');
        expect(pipeline[1].nodeId).toBe('n1');
        expect(pipeline[2].nodeId).toBe('n2');
    });

    test('should detect gaps in layer coverage', async () => {
        const store = createMockStore();
        const registry = new PipelineRegistry(store as any);

        await registry.registerNode({
            nodeId: 'n0', peerId: 'p0', host: '10.0.0.1', port: 8080,
            startLayer: 0, endLayer: 19, model: 'deepseek-r1',
        });
        // Gap: layers 20-29 missing
        await registry.registerNode({
            nodeId: 'n2', peerId: 'p2', host: '10.0.0.3', port: 8080,
            startLayer: 30, endLayer: 60, model: 'deepseek-r1',
        });

        await expect(
            registry.discoverPipeline('deepseek-r1', 61)
        ).rejects.toThrow(/gap|missing|coverage/i);
    });

    test('should mark unresponsive nodes as offline', async () => {
        const store = createMockStore();
        const registry = new PipelineRegistry(store as any);

        await registry.registerNode({
            nodeId: 'n0', peerId: 'p0', host: '10.0.0.1', port: 8080,
            startLayer: 0, endLayer: 9, model: 'deepseek-r1',
        });

        // Simulate marking node offline
        await registry.markOffline('n0');
        const nodes = await registry.getRegisteredNodes();
        expect(nodes[0].status).toBe('offline');

        // Offline nodes should not appear in pipeline discovery
        await expect(
            registry.discoverPipeline('deepseek-r1', 10)
        ).rejects.toThrow(/gap|missing|coverage|no online/i);
    });
});
