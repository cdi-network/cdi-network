/**
 * E2E integration tests for P3 WS-P3.4: Distributed Inference Pipeline.
 * Tests the full flow: ShardRegistry → PipelineOrchestrator → ShardExecutor → Rewards.
 * Run: node browser/network/e2e.test.js
 */

import { ShardRegistry } from '../sharding/ShardRegistry.js';
import { PipelineOrchestrator } from '../sharding/PipelineOrchestrator.js';
import { ShardExecutor } from '../compute/ShardExecutor.js';
import { HeliaManager } from '../storage/HeliaManager.js';
import { LedgerStore } from '../storage/LedgerStore.js';
import { AutoBalancer } from './AutoBalancer.js';
import { ActivationRelay } from '../p2p/ActivationRelay.js';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// ── E2E Distributed Inference Tests ───────────────────────────────────

describe('E2E Distributed Inference', () => {

    it('should run 3-node distributed inference pipeline', async () => {
        // Setup: 3 shards across 3 nodes for a "mini" model
        const registry = new ShardRegistry();

        // Register 3 shards for model "tiny-3"
        registry.registerManifest({ shardId: 'tiny-s0', modelId: 'tiny-3', layerRange: [0, 7] });
        registry.registerManifest({ shardId: 'tiny-s1', modelId: 'tiny-3', layerRange: [8, 15] });
        registry.registerManifest({ shardId: 'tiny-s2', modelId: 'tiny-3', layerRange: [16, 21] });

        // 3 nodes claim 1 shard each
        registry.claimShard('node-A', 'tiny-s0');
        registry.claimShard('node-B', 'tiny-s1');
        registry.claimShard('node-C', 'tiny-s2');

        // Build pipeline
        const orchestrator = new PipelineOrchestrator(registry);
        const pipeline = orchestrator.buildPipeline('tiny-3');

        assert.equal(pipeline.length, 3);
        assert.equal(pipeline[0].nodeId, 'node-A');
        assert.equal(pipeline[1].nodeId, 'node-B');
        assert.equal(pipeline[2].nodeId, 'node-C');

        // Execute pipeline with mock shard executor
        const executor = new ShardExecutor();
        await executor.init();

        // Load weights for each shard
        for (const stage of pipeline) {
            const fakeWeights = new Uint8Array(new Float32Array(32).fill(0.01).buffer);
            await executor.loadWeights(stage.shardId, fakeWeights);
        }

        // Run through all stages sequentially
        let activations = new Float32Array(8).fill(1.0);
        for (const stage of pipeline) {
            const result = await executor.execute(stage.shardId, activations, {
                shardId: stage.shardId,
                layerRange: stage.layerRange,
                cid: 'test-cid',
                hiddenDim: 8,
                numHeads: 2,
            });
            activations = result.activations;
            stage.status = 'complete';
        }

        // All stages complete
        assert.ok(pipeline.every(s => s.status === 'complete'));
        assert.equal(activations.length, 8);
    });

    it('should distribute CDI rewards proportionally', async () => {
        const registry = new ShardRegistry();
        registry.registerManifest({ shardId: 's0', modelId: 'm1', layerRange: [0, 9] });
        registry.registerManifest({ shardId: 's1', modelId: 'm1', layerRange: [10, 29] });

        registry.claimShard('nodeA', 's0');
        registry.claimShard('nodeB', 's1');

        const ledger = new LedgerStore();
        // Mint treasury
        ledger.recordTransaction({
            from: 'treasury', to: 'treasury', amount: 10000,
            txType: 'mint', signature: 'genesis',
        });

        const orchestrator = new PipelineOrchestrator(registry);
        const pipeline = orchestrator.buildPipeline('m1');

        // Calculate rewards: s0 has 10 layers (weight 10), s1 has 20 layers (weight 20)
        const totalFee = 10; // CDI
        const totalWeight = pipeline.reduce((sum, s) => sum + s.computeWeight, 0);

        for (const stage of pipeline) {
            const reward = (totalFee * 0.85) * (stage.computeWeight / totalWeight);
            ledger.recordTransaction({
                from: 'treasury', to: stage.nodeId, amount: reward,
                txType: 'reward', signature: `reward-${stage.shardId}`,
            });
        }

        // nodeB did 2x the compute → gets 2x the reward
        const nodeABalance = ledger.getBalance('nodeA');
        const nodeBBalance = ledger.getBalance('nodeB');
        assert.ok(nodeBBalance > nodeABalance,
            `nodeB (${nodeBBalance}) should earn more than nodeA (${nodeABalance})`);

        // Verify proportional: nodeB should have ~2x nodeA
        const ratio = nodeBBalance / nodeABalance;
        assert.ok(ratio > 1.8 && ratio < 2.2, `Reward ratio should be ~2x, got ${ratio}`);
    });
});

// ── AutoBalancer Tests ────────────────────────────────────────────────

describe('AutoBalancer', () => {

    it('should detect under-replicated shards', () => {
        const balancer = new AutoBalancer({ minReplicas: 2 });

        // Shard with only 1 node
        balancer.registerAssignment('s0', 'node-A');
        // Shard with 2 nodes
        balancer.registerAssignment('s1', 'node-B');
        balancer.registerAssignment('s1', 'node-C');

        const underRep = balancer.getUnderReplicated();
        assert.equal(underRep.length, 1);
        assert.equal(underRep[0].shardId, 's0');
        assert.equal(underRep[0].needed, 1);
    });

    it('should auto-replicate under-replicated shard to least-loaded node', () => {
        const balancer = new AutoBalancer({ minReplicas: 2 });

        // Register nodes
        balancer.registerAssignment('s0', 'node-A');
        balancer.registerAssignment('s1', 'node-B');
        balancer.registerAssignment('s1', 'node-C');

        // Rebalance should replicate s0 to least-loaded node (B or C)
        const actions = balancer.rebalance();
        const replicateActions = actions.filter(a => a.type === 'replicate');
        assert.equal(replicateActions.length, 1);
        assert.equal(replicateActions[0].shardId, 's0');
    });

    it('should identify hot shards', () => {
        const balancer = new AutoBalancer({ hotThreshold: 3 });

        balancer.registerAssignment('hot-shard', 'node-A');
        balancer.registerAssignment('cold-shard', 'node-B');

        // Simulate 5 requests for hot-shard, 1 for cold-shard
        for (let i = 0; i < 5; i++) balancer.recordRequest('hot-shard');
        balancer.recordRequest('cold-shard');

        const hotShards = balancer.getHotShards();
        assert.equal(hotShards.length, 1);
        assert.equal(hotShards[0].shardId, 'hot-shard');
        assert.equal(hotShards[0].requestCount, 5);
    });

    it('should identify overloaded nodes', () => {
        const balancer = new AutoBalancer({ maxShardsPerNode: 3 });

        // Node with 5 shards
        for (let i = 0; i < 5; i++) {
            balancer.registerAssignment(`shard-${i}`, 'overloaded-node');
        }
        // Node with 2 shards
        balancer.registerAssignment('s-a', 'normal-node');
        balancer.registerAssignment('s-b', 'normal-node');

        const overloaded = balancer.getOverloadedNodes();
        assert.equal(overloaded.length, 1);
        assert.equal(overloaded[0].nodeId, 'overloaded-node');
        assert.equal(overloaded[0].excess, 2);
    });

    it('should track rebalance action log', () => {
        const balancer = new AutoBalancer({ minReplicas: 2 });
        balancer.registerAssignment('s0', 'node-A');
        balancer.registerAssignment('s1', 'node-B');

        balancer.rebalance();
        assert.ok(balancer.actionLog.length > 0);
    });
});

// ── ActivationRelay integration ───────────────────────────────────────

describe('ActivationRelay E2E', () => {
    it('should relay activations between simulated pipeline stages', async () => {
        const relay = new ActivationRelay();
        const stages = [];

        // Simulate 3-stage pipeline via relay
        const stage0Output = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const buffer = relay.serialize({
            requestId: 'e2e-req',
            shardId: 'stage-0',
            stageIndex: 0,
            data: stage0Output,
            shape: [1, 4],
            timestamp: Date.now(),
        });

        // Stage 1 receives stage 0 output
        const waitPromise = relay.waitForActivation('e2e-req', 0);
        relay.handleIncoming(buffer);
        const received = await waitPromise;

        assert.equal(received.stageIndex, 0);
        assert.deepEqual([...received.data], [1.0, 2.0, 3.0, 4.0]);
    });
});
