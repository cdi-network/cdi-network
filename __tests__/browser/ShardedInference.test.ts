/**
 * ShardedInferenceEngine + DistributedPipeline — TDD tests for distributed layer-sharded inference.
 *
 * ShardedInferenceEngine: Loads partial layers from GGUF, executes via WebGPU
 * DistributedPipeline: Orchestrates multi-node inference via TabMesh encrypted relay
 */

// @ts-nocheck

import { ShardedInferenceEngine } from '../../browser/llm/ShardedInferenceEngine';
import { DistributedPipeline } from '../../browser/llm/DistributedPipeline';

// ── Mock factories ──

function createMockGGUFParser(layerCount = 4) {
    const tensors: any[] = [];
    for (let l = 0; l < layerCount; l++) {
        tensors.push(
            { name: `blk.${l}.attn_q.weight`, nDims: 2, shape: [64, 64], type: 0, offset: l * 4096, byteSize: 4096 },
            { name: `blk.${l}.attn_k.weight`, nDims: 2, shape: [64, 64], type: 0, offset: l * 4096 + 4096, byteSize: 4096 },
            { name: `blk.${l}.ffn.weight`, nDims: 2, shape: [64, 256], type: 0, offset: l * 4096 + 8192, byteSize: 16384 },
        );
    }

    return {
        version: 3,
        tensorCount: tensors.length,
        kvCount: 0,
        metadata: { 'general.name': 'test-model' },
        tensors,
        layerCount,
        getLayerTensors(idx: number) {
            return tensors.filter(t => t.name.startsWith(`blk.${idx}.`));
        },
        getLayerRangeTensors(start: number, end: number) {
            const result: any[] = [];
            for (let i = start; i <= end; i++) result.push(...this.getLayerTensors(i));
            return result;
        },
        getTensorData(name: string) {
            const t = tensors.find(x => x.name === name);
            return t ? new Uint8Array(t.byteSize).fill(1) : null;
        },
    };
}

function createMockShardExecutor() {
    const executions: any[] = [];
    return {
        async execute(input: Float32Array, weights: Map<string, Uint8Array>) {
            executions.push({ inputSize: input.length, weightCount: weights.size });
            // Simulate layer computation: return transformed activations
            const output = new Float32Array(input.length);
            for (let i = 0; i < input.length; i++) output[i] = input[i] * 1.1;
            return output;
        },
        executions,
    };
}

function createMockTabMesh() {
    const messages: any[] = [];
    const handlers: Map<string, Function> = new Map();
    return {
        nodeId: 'node-test-1',
        async sendEncrypted(peerId: string, type: string, payload: any) {
            messages.push({ peerId, type, payload });
        },
        onMessage(type: string, handler: Function) {
            handlers.set(type, handler);
        },
        simulateReceive(type: string, payload: any, fromPeer: string) {
            const handler = handlers.get(type);
            if (handler) handler(payload, fromPeer);
        },
        messages,
        handlers,
        getPeers() {
            return [
                { nodeId: 'node-2', loadedModels: ['test-model'] },
                { nodeId: 'node-3', loadedModels: ['test-model'] },
            ];
        },
    };
}


describe('ShardedInferenceEngine', () => {

    it('loads specific layer range from parsed GGUF', async () => {
        const parser = createMockGGUFParser(8);
        const executor = createMockShardExecutor();

        const engine = new ShardedInferenceEngine({ executor });
        await engine.loadLayers(parser, 2, 4); // Load layers 2-4

        expect(engine.layerRange).toEqual([2, 4]);
        expect(engine.loadedLayerCount).toBe(3);
        expect(engine.isReady).toBe(true);
    });

    it('executes forward pass through loaded layers sequentially', async () => {
        const parser = createMockGGUFParser(4);
        const executor = createMockShardExecutor();

        const engine = new ShardedInferenceEngine({ executor });
        await engine.loadLayers(parser, 0, 1); // 2 layers

        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const output = await engine.forward(input);

        // Should have executed 2 layers (one per loaded layer)
        expect(executor.executions).toHaveLength(2);
        // Output should be transformed (input * 1.1 * 1.1 for 2 layers)
        expect(output.length).toBe(4);
        expect(output[0]).toBeCloseTo(1.21, 2); // 1.0 * 1.1 * 1.1
    });

    it('reports VRAM usage for loaded layers', async () => {
        const parser = createMockGGUFParser(4);
        const executor = createMockShardExecutor();

        const engine = new ShardedInferenceEngine({ executor });
        await engine.loadLayers(parser, 0, 0); // 1 layer

        expect(engine.vramUsageBytes).toBeGreaterThan(0);
    });

    it('rejects forward before loading', async () => {
        const engine = new ShardedInferenceEngine({ executor: createMockShardExecutor() });
        const input = new Float32Array([1.0]);
        await expect(engine.forward(input)).rejects.toThrow('No layers loaded');
    });
});


describe('DistributedPipeline', () => {

    it('creates pipeline stages from shard plan', () => {
        const mesh = createMockTabMesh();
        const pipeline = new DistributedPipeline({ mesh });

        pipeline.addStage({ nodeId: 'node-1', layerRange: [0, 3] });
        pipeline.addStage({ nodeId: 'node-2', layerRange: [4, 7] });
        pipeline.addStage({ nodeId: 'node-3', layerRange: [8, 11] });

        expect(pipeline.stageCount).toBe(3);
        expect(pipeline.stages[0].nodeId).toBe('node-1');
        expect(pipeline.stages[2].layerRange).toEqual([8, 11]);
    });

    it('executes local stage when current node owns the stage', async () => {
        const mesh = createMockTabMesh();
        mesh.nodeId = 'node-1';

        const executor = createMockShardExecutor();
        const parser = createMockGGUFParser(4);
        const localEngine = new ShardedInferenceEngine({ executor });
        await localEngine.loadLayers(parser, 0, 1);

        const pipeline = new DistributedPipeline({ mesh, localEngine });
        pipeline.addStage({ nodeId: 'node-1', layerRange: [0, 1] });
        pipeline.addStage({ nodeId: 'node-2', layerRange: [2, 3] });

        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        // Execute first stage locally
        const result = await pipeline.executeStage(0, input);
        expect(result).not.toBeNull();
        expect(executor.executions.length).toBeGreaterThan(0);
    });

    it('sends activations to remote peer for non-local stages', async () => {
        const mesh = createMockTabMesh();
        mesh.nodeId = 'node-1';

        const pipeline = new DistributedPipeline({ mesh });
        pipeline.addStage({ nodeId: 'node-1', layerRange: [0, 3] });
        pipeline.addStage({ nodeId: 'node-2', layerRange: [4, 7] });

        const activations = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        // Send to remote stage
        await pipeline.sendActivations('node-2', activations);

        expect(mesh.messages).toHaveLength(1);
        expect(mesh.messages[0].peerId).toBe('node-2');
        expect(mesh.messages[0].type).toBe('activations');
    });

    it('receives activations from remote peer', async () => {
        const mesh = createMockTabMesh();
        const executor = createMockShardExecutor();
        const parser = createMockGGUFParser(4);
        const localEngine = new ShardedInferenceEngine({ executor });
        await localEngine.loadLayers(parser, 0, 1);

        const pipeline = new DistributedPipeline({ mesh, localEngine });

        // Set up activation handler
        let receivedResult: Float32Array | null = null;
        pipeline.onActivationsReceived(async (activations: Float32Array) => {
            receivedResult = await localEngine.forward(activations);
        });

        // Simulate receiving activations from another node
        const testActivations = Array.from(new Float32Array([1.0, 2.0, 3.0, 4.0]));
        mesh.simulateReceive('activations', { data: testActivations }, 'node-remote');

        // Wait for processing 
        await new Promise(r => setTimeout(r, 50));

        expect(receivedResult).not.toBeNull();
        expect(executor.executions.length).toBeGreaterThan(0);
    });
});
