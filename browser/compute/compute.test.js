/**
 * Tests for P3 WS-P3.3: WebGPU ShardExecutor + compute layer.
 * Run: node browser/compute/compute.test.js
 */

import { ShardExecutor } from './ShardExecutor.js';
import { FallbackExecutor, createExecutor } from './FallbackExecutor.js';
import { ModelLoader } from './ModelLoader.js';
import { COMPUTE_SHADERS } from './ComputeShaders.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── ShardExecutor Tests ───────────────────────────────────────────────

describe('ShardExecutor', () => {
    it('should detect WebGPU availability (Node.js = false)', async () => {
        const exec = new ShardExecutor();
        const hasGpu = await exec.init();
        assert.equal(hasGpu, false); // No WebGPU in Node.js
        assert.ok(exec.isInitialized);
    });

    it('should load shard weights', async () => {
        const exec = new ShardExecutor();
        await exec.init();

        // Create fake weights (4 floats = 16 bytes)
        const weights = new Uint8Array(new Float32Array([0.1, 0.2, 0.3, 0.4]).buffer);
        await exec.loadWeights('shard-0', weights);
        assert.deepEqual(exec.loadedShards, ['shard-0']);
    });

    it('should execute forward pass and produce activations', async () => {
        const exec = new ShardExecutor();
        await exec.init();

        const weights = new Uint8Array(new Float32Array(64).fill(0.01).buffer);
        await exec.loadWeights('shard-0', weights);

        const input = new Float32Array(16).fill(1.0);
        const result = await exec.execute('shard-0', input, {
            shardId: 'shard-0',
            layerRange: [0, 1],  // 2 layers
            cid: 'bafytest',
            hiddenDim: 16,
            numHeads: 4,
        });

        assert.ok(result.activations instanceof Float32Array);
        assert.equal(result.activations.length, 16);
        assert.ok(result.latencyMs >= 0);
        assert.ok(result.commitment.length === 64); // SHA-256 hex
        assert.deepEqual(result.shape, [1, 16]);
    });

    it('should generate deterministic commitment for same output', async () => {
        const exec = new ShardExecutor();
        await exec.init();

        const weights = new Uint8Array(new Float32Array(8).fill(0.5).buffer);
        await exec.loadWeights('s1', weights);

        const input = new Float32Array(8).fill(2.0);
        const config = { shardId: 's1', layerRange: [0, 0], cid: 'x', hiddenDim: 8, numHeads: 2 };

        const r1 = await exec.execute('s1', input, config);
        const r2 = await exec.execute('s1', input, config);

        assert.equal(r1.commitment, r2.commitment);
    });

    it('should throw on unloaded shard', async () => {
        const exec = new ShardExecutor();
        await exec.init();
        await assert.rejects(
            () => exec.execute('nonexistent', new Float32Array(4), {
                shardId: 'nonexistent', layerRange: [0, 0], cid: 'x',
                hiddenDim: 4, numHeads: 1,
            }),
            { message: /not loaded/ }
        );
    });

    it('should dispose resources', async () => {
        const exec = new ShardExecutor();
        await exec.init();
        await exec.loadWeights('s1', new Uint8Array(16));
        await exec.dispose();
        assert.ok(!exec.isInitialized);
        assert.equal(exec.loadedShards.length, 0);
    });
});

// ── FallbackExecutor Tests ────────────────────────────────────────────

describe('FallbackExecutor', () => {
    it('should always report no GPU', async () => {
        const fallback = new FallbackExecutor();
        const hasGpu = await fallback.init();
        assert.equal(hasGpu, false);
        assert.equal(fallback.isGpuAvailable, false);
    });

    it('should execute with same interface as ShardExecutor', async () => {
        const fallback = new FallbackExecutor();
        await fallback.init();

        const weights = new Uint8Array(new Float32Array(32).fill(0.1).buffer);
        await fallback.loadWeights('s1', weights);

        const result = await fallback.execute('s1', new Float32Array(8).fill(1.0), {
            shardId: 's1', layerRange: [0, 0], cid: 'x', hiddenDim: 8, numHeads: 2,
        });

        assert.ok(result.activations instanceof Float32Array);
        assert.ok(result.commitment);
    });

    it('should auto-select fallback via createExecutor', async () => {
        const exec = await createExecutor();
        // In Node.js, always falls back to CPU
        assert.equal(exec.isGpuAvailable, false);
        assert.ok(exec.isInitialized);
    });
});

// ── ModelLoader Tests ─────────────────────────────────────────────────

describe('ModelLoader', () => {
    it('should create shard plan for small model', () => {
        const loader = new ModelLoader({ targetShardSizeBytes: 500_000_000 });
        const plan = loader.createShardPlan({
            modelId: 'tinyllama-1.1b',
            name: 'TinyLlama 1.1B',
            family: 'llama',
            paramCount: 1_100_000_000,
            hiddenDim: 2048,
            numLayers: 22,
            numHeads: 16,
            format: 'safetensors',
        });

        assert.ok(plan.length >= 1);
        assert.equal(plan[0].modelId, 'tinyllama-1.1b');
        assert.ok(plan[0].shardId.includes('shard-0'));
        // All layers should be covered
        const firstLayer = plan[0].layerRange[0];
        const lastLayer = plan[plan.length - 1].layerRange[1];
        assert.equal(firstLayer, 0);
        assert.equal(lastLayer, 21);
    });

    it('should create more shards for larger models', () => {
        const loader = new ModelLoader({ targetShardSizeBytes: 500_000_000 });

        const smallPlan = loader.createShardPlan({
            modelId: 'tiny', name: 'Tiny', family: 'llama',
            paramCount: 1e9, hiddenDim: 2048, numLayers: 22, numHeads: 16, format: 'safetensors',
        });
        const largePlan = loader.createShardPlan({
            modelId: 'big', name: 'Big', family: 'llama',
            paramCount: 70e9, hiddenDim: 8192, numLayers: 80, numHeads: 64, format: 'safetensors',
        });

        assert.ok(largePlan.length > smallPlan.length,
            `Large model (${largePlan.length} shards) should have more shards than small (${smallPlan.length})`);
    });

    it('should throw on invalid manifest', () => {
        const loader = new ModelLoader();
        assert.throws(
            () => loader.createShardPlan({ name: 'No ID' }),
            { message: /requires modelId/ }
        );
    });
});

// ── ComputeShaders Tests ──────────────────────────────────────────────

describe('ComputeShaders', () => {
    it('should export all 4 shader sources', () => {
        assert.ok(COMPUTE_SHADERS.matmul);
        assert.ok(COMPUTE_SHADERS.layernorm);
        assert.ok(COMPUTE_SHADERS.gelu);
        assert.ok(COMPUTE_SHADERS.softmax);
    });

    it('should contain valid WGSL syntax markers', () => {
        assert.ok(COMPUTE_SHADERS.matmul.includes('@compute'));
        assert.ok(COMPUTE_SHADERS.matmul.includes('@workgroup_size'));
        assert.ok(COMPUTE_SHADERS.gelu.includes('tanh'));
        assert.ok(COMPUTE_SHADERS.softmax.includes('exp'));
    });
});
