/**
 * Tests for ShardRegistry and PipelineOrchestrator.
 * Run: node browser/sharding/sharding.test.js
 */

import { ShardRegistry } from './ShardRegistry.js';
import { PipelineOrchestrator } from './PipelineOrchestrator.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── Test Fixtures ─────────────────────────────────────────────────────

function createDeepSeekManifests() {
    const shards = [];
    for (let i = 0; i < 4; i++) {
        shards.push({
            shardId: `deepseek-shard-${i}`,
            modelId: 'deepseek-r1-671b',
            layerRange: [i * 20, (i + 1) * 20 - 1],
            weightsCid: `QmShard${i}CID`,
            inputShape: [1, 4096],
            outputShape: [1, 4096],
            sizeBytes: 40_000_000_000, // ~40GB per shard
        });
    }
    return shards;
}

// ── ShardRegistry Tests ───────────────────────────────────────────────

describe('ShardRegistry', () => {
    it('should register shard manifests', () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        for (const s of shards) registry.registerManifest(s);
        assert.equal(registry.manifestCount, 4);
    });

    it('should reject manifest without shardId', () => {
        const registry = new ShardRegistry();
        assert.throws(() => registry.registerManifest({ modelId: 'test' }));
    });

    it('should allow nodes to claim shards', () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        shards.forEach(s => registry.registerManifest(s));

        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.claimShard('phone-B', 'deepseek-shard-1');

        assert.equal(registry.getAvailableNodes('deepseek-shard-0').length, 1);
        assert.equal(registry.getAvailableNodes('deepseek-shard-0')[0].nodeId, 'phone-A');
        assert.equal(registry.getNodeShards('phone-A').length, 1);
    });

    it('should not duplicate claims', () => {
        const registry = new ShardRegistry();
        registry.registerManifest(createDeepSeekManifests()[0]);
        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.claimShard('phone-A', 'deepseek-shard-0'); // duplicate
        assert.equal(registry.getAvailableNodes('deepseek-shard-0').length, 1);
    });

    it('should support replica shards', () => {
        const registry = new ShardRegistry();
        registry.registerManifest(createDeepSeekManifests()[0]);
        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.claimShard('phone-B', 'deepseek-shard-0');
        assert.equal(registry.replicaCount('deepseek-shard-0'), 2);
    });

    it('should release shards', () => {
        const registry = new ShardRegistry();
        registry.registerManifest(createDeepSeekManifests()[0]);
        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.releaseShard('phone-A', 'deepseek-shard-0');
        assert.equal(registry.replicaCount('deepseek-shard-0'), 0);
        assert.equal(registry.getNodeShards('phone-A').length, 0);
    });

    it('should get model shards ordered by layer range', () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        // Register in reverse order
        shards.reverse().forEach(s => registry.registerManifest(s));
        const ordered = registry.getModelShards('deepseek-r1-671b');
        assert.equal(ordered.length, 4);
        assert.equal(ordered[0].layerRange[0], 0);
        assert.equal(ordered[3].layerRange[0], 60);
    });

    it('should evict stale nodes', async () => {
        const registry = new ShardRegistry();
        registry.registerManifest(createDeepSeekManifests()[0]);
        registry.claimShard('phone-A', 'deepseek-shard-0');

        // Wait a bit so lastSeen is in the past
        await new Promise(r => setTimeout(r, 15));
        const evicted = registry.evictStaleNodes(5);
        assert.equal(evicted.length, 1);
        assert.equal(evicted[0], 'phone-A');
        assert.equal(registry.getAvailableNodes('deepseek-shard-0').length, 0);
    });

    it('should throw on claim unknown shard', () => {
        const registry = new ShardRegistry();
        assert.throws(() => registry.claimShard('phone-A', 'nonexistent'));
    });
});

// ── PipelineOrchestrator Tests ────────────────────────────────────────

describe('PipelineOrchestrator', () => {
    function setupFullPipeline() {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        shards.forEach(s => registry.registerManifest(s));
        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.claimShard('phone-B', 'deepseek-shard-1');
        registry.claimShard('phone-C', 'deepseek-shard-2');
        registry.claimShard('phone-D', 'deepseek-shard-3');
        return { registry, shards };
    }

    it('should build a pipeline for a fully-covered model', () => {
        const { registry } = setupFullPipeline();
        const orchestrator = new PipelineOrchestrator(registry);
        const pipeline = orchestrator.buildPipeline('deepseek-r1-671b');
        assert.equal(pipeline.length, 4);
        assert.equal(pipeline[0].nodeId, 'phone-A');
        assert.equal(pipeline[3].nodeId, 'phone-D');
    });

    it('should throw when model has no shards', () => {
        const registry = new ShardRegistry();
        const orchestrator = new PipelineOrchestrator(registry);
        assert.throws(() => orchestrator.buildPipeline('nonexistent'));
    });

    it('should throw when shard has no available nodes', () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        shards.forEach(s => registry.registerManifest(s));
        // Only claim shard-0, leave others unclaimed
        registry.claimShard('phone-A', 'deepseek-shard-0');
        const orchestrator = new PipelineOrchestrator(registry);
        assert.throws(() => orchestrator.buildPipeline('deepseek-r1-671b'));
    });

    it('should execute a complete pipeline', async () => {
        const { registry } = setupFullPipeline();
        const orchestrator = new PipelineOrchestrator(registry);

        const request = {
            requestId: 'req-001',
            modelId: 'deepseek-r1-671b',
            prompt: 'What is quantum computing?',
            requesterId: 'user-X',
            fee: 100.0,
        };

        const executeStage = async (stage, input) => {
            // Simulate compute
            return { ...input, [`shard_${stage.shardId}`]: 'processed' };
        };

        const result = await orchestrator.executePipeline(request, executeStage);
        assert.equal(result.requestId, 'req-001');
        assert.equal(result.pipeline.length, 4);
        assert.ok(result.pipeline.every(s => s.status === 'done'));
        assert.ok(result.totalTimeMs >= 0);
        assert.equal(result.rewards.length, 4);
    });

    it('should distribute rewards proportionally', async () => {
        const { registry } = setupFullPipeline();
        const orchestrator = new PipelineOrchestrator(registry);

        const request = {
            requestId: 'req-002',
            modelId: 'deepseek-r1-671b',
            prompt: 'test',
            requesterId: 'user-X',
            fee: 100.0,
        };

        const executeStage = async (stage, input) => input;
        const result = await orchestrator.executePipeline(request, executeStage);

        // All shards have equal weight (20 layers each) → equal rewards
        const totalReward = result.rewards.reduce((sum, r) => sum + r.amount, 0);
        assert.ok(Math.abs(totalReward - 85.0) < 0.01, `Expected ~85 CDI (85% of 100), got ${totalReward}`);
        // Each gets 85/4 = 21.25
        for (const r of result.rewards) {
            assert.ok(Math.abs(r.amount - 21.25) < 0.01, `Expected ~21.25, got ${r.amount}`);
        }
    });

    it('should failover to replica on stage failure', async () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        shards.forEach(s => registry.registerManifest(s));
        registry.claimShard('phone-A', 'deepseek-shard-0');
        registry.claimShard('phone-A-backup', 'deepseek-shard-0'); // replica
        registry.claimShard('phone-B', 'deepseek-shard-1');
        registry.claimShard('phone-C', 'deepseek-shard-2');
        registry.claimShard('phone-D', 'deepseek-shard-3');

        const orchestrator = new PipelineOrchestrator(registry);

        let firstCallShard0 = true;
        const executeStage = async (stage, input) => {
            if (stage.shardId === 'deepseek-shard-0' && firstCallShard0) {
                firstCallShard0 = false;
                throw new Error('Phone A crashed!');
            }
            return { ...input, processed: true };
        };

        const request = {
            requestId: 'req-003',
            modelId: 'deepseek-r1-671b',
            prompt: 'failover test',
            requesterId: 'user-X',
            fee: 50.0,
        };

        const result = await orchestrator.executePipeline(request, executeStage);
        assert.equal(result.pipeline[0].nodeId, 'phone-A-backup');
        assert.ok(result.pipeline.every(s => s.status === 'done'));
    });

    it('should check pipeline readiness', () => {
        const registry = new ShardRegistry();
        const shards = createDeepSeekManifests();
        shards.forEach(s => registry.registerManifest(s));

        const orchestrator = new PipelineOrchestrator(registry);

        // No nodes claimed → not ready
        let readiness = orchestrator.checkPipelineReadiness('deepseek-r1-671b');
        assert.equal(readiness.complete, false);
        assert.equal(readiness.missing.length, 4);

        // Claim all shards
        registry.claimShard('A', 'deepseek-shard-0');
        registry.claimShard('B', 'deepseek-shard-1');
        registry.claimShard('C', 'deepseek-shard-2');
        registry.claimShard('D', 'deepseek-shard-3');

        readiness = orchestrator.checkPipelineReadiness('deepseek-r1-671b');
        assert.equal(readiness.complete, true);
        assert.equal(readiness.missing.length, 0);
    });
});
