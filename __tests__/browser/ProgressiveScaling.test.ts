/**
 * Phase 3: Progressive Scaling — TDD tests
 *
 * NodeCapabilityProber: Detects VRAM, CPU, bandwidth per node
 * ScalingPlanner: Decides optimal model sharding across N nodes
 * ScalingTestHarness: Orchestrates multi-node inference tests
 */

// @ts-nocheck

import { NodeCapabilityProber } from '../../browser/llm/NodeCapabilityProber';
import { ScalingPlanner } from '../../browser/llm/ScalingPlanner';
import { ScalingTestHarness } from '../../browser/llm/ScalingTestHarness';


// ── Mock factories ──

function createMockPeer(opts: { nodeId: string; vramMB: number; cpuCores: number; bandwidthMbps: number }) {
    return {
        nodeId: opts.nodeId,
        capabilities: {
            vramMB: opts.vramMB,
            cpuCores: opts.cpuCores,
            bandwidthMbps: opts.bandwidthMbps,
        },
    };
}

const MODEL_SPECS = {
    '8B': { params: 8e9, vramMB: 6000, layers: 32, hiddenDim: 4096 },
    '14B': { params: 14e9, vramMB: 11000, layers: 40, hiddenDim: 5120 },
    '70B': { params: 70e9, vramMB: 42000, layers: 80, hiddenDim: 8192 },
    '671B': { params: 671e9, vramMB: 400000, layers: 160, hiddenDim: 16384 },
};


describe('NodeCapabilityProber', () => {

    it('probes local node capabilities', async () => {
        const prober = new NodeCapabilityProber();
        const caps = await prober.probe();

        expect(caps).toHaveProperty('vramMB');
        expect(caps).toHaveProperty('cpuCores');
        expect(caps).toHaveProperty('bandwidthMbps');
        expect(caps).toHaveProperty('tier');
        expect(typeof caps.vramMB).toBe('number');
        expect(caps.vramMB).toBeGreaterThanOrEqual(0);
    });

    it('classifies device tiers correctly', () => {
        const prober = new NodeCapabilityProber();

        expect(prober.classifyTier(500)).toBe('xs');    // <1GB
        expect(prober.classifyTier(2000)).toBe('s');    // 1-4GB
        expect(prober.classifyTier(6000)).toBe('m');    // 4-8GB
        expect(prober.classifyTier(16000)).toBe('l');   // 8-24GB
        expect(prober.classifyTier(48000)).toBe('xl');  // >24GB
    });

    it('estimates max model size for device VRAM', () => {
        const prober = new NodeCapabilityProber();

        // 8GB VRAM should handle ~7B model solo
        expect(prober.maxSoloModelParams(8000)).toBeGreaterThan(5e9);
        expect(prober.maxSoloModelParams(8000)).toBeLessThan(15e9);

        // 48GB VRAM should handle ~30B+ model solo
        expect(prober.maxSoloModelParams(48000)).toBeGreaterThan(25e9);
    });
});


describe('ScalingPlanner', () => {

    it('creates shard plan for 8B across 2 nodes', () => {
        const planner = new ScalingPlanner();
        const peers = [
            createMockPeer({ nodeId: 'n1', vramMB: 6000, cpuCores: 8, bandwidthMbps: 100 }),
            createMockPeer({ nodeId: 'n2', vramMB: 6000, cpuCores: 8, bandwidthMbps: 100 }),
        ];

        const plan = planner.createPlan(MODEL_SPECS['8B'], peers);

        expect(plan.stages).toHaveLength(2);
        expect(plan.stages[0].nodeId).toBe('n1');
        expect(plan.stages[1].nodeId).toBe('n2');
        // 32 layers split ~equally: [0,15] and [16,31]
        expect(plan.stages[0].layerRange[0]).toBe(0);
        expect(plan.stages[1].layerRange[1]).toBe(31);
        expect(plan.feasible).toBe(true);
    });

    it('creates shard plan for 70B across 5 nodes', () => {
        const planner = new ScalingPlanner();
        const peers = Array.from({ length: 5 }, (_, i) =>
            createMockPeer({ nodeId: `n${i}`, vramMB: 12000, cpuCores: 8, bandwidthMbps: 100 })
        );

        const plan = planner.createPlan(MODEL_SPECS['70B'], peers);

        expect(plan.stages).toHaveLength(5);
        expect(plan.feasible).toBe(true);
        // 80 layers across 5 nodes = 16 layers each
        expect(plan.stages[0].layerRange).toEqual([0, 15]);
        expect(plan.stages[4].layerRange).toEqual([64, 79]);
    });

    it('marks plan infeasible when total VRAM insufficient', () => {
        const planner = new ScalingPlanner();
        const peers = [
            createMockPeer({ nodeId: 'n1', vramMB: 2000, cpuCores: 4, bandwidthMbps: 50 }),
        ];

        const plan = planner.createPlan(MODEL_SPECS['70B'], peers);

        expect(plan.feasible).toBe(false);
        expect(plan.reason).toContain('insufficient');
    });

    it('assigns more layers to nodes with more VRAM', () => {
        const planner = new ScalingPlanner();
        const peers = [
            createMockPeer({ nodeId: 'n1', vramMB: 24000, cpuCores: 8, bandwidthMbps: 200 }),
            createMockPeer({ nodeId: 'n2', vramMB: 6000, cpuCores: 4, bandwidthMbps: 50 }),
        ];

        const plan = planner.createPlan(MODEL_SPECS['8B'], peers);

        expect(plan.feasible).toBe(true);
        // Node with 4x VRAM should get more layers
        const n1Layers = plan.stages[0].layerRange[1] - plan.stages[0].layerRange[0] + 1;
        const n2Layers = plan.stages[1].layerRange[1] - plan.stages[1].layerRange[0] + 1;
        expect(n1Layers).toBeGreaterThan(n2Layers);
    });

    it('estimates pipeline latency based on bandwidth bottleneck', () => {
        const planner = new ScalingPlanner();
        const peers = [
            createMockPeer({ nodeId: 'n1', vramMB: 8000, cpuCores: 8, bandwidthMbps: 100 }),
            createMockPeer({ nodeId: 'n2', vramMB: 8000, cpuCores: 8, bandwidthMbps: 100 }),
        ];

        const plan = planner.createPlan(MODEL_SPECS['8B'], peers);
        expect(plan.estimatedLatencyMs).toBeGreaterThan(0);
        expect(plan.bottleneck).toBeDefined();
    });

    it('plans DeepSeek-R1 671B across 50 nodes', () => {
        const planner = new ScalingPlanner();
        const peers = Array.from({ length: 50 }, (_, i) =>
            createMockPeer({ nodeId: `n${i}`, vramMB: 12000, cpuCores: 8, bandwidthMbps: 100 })
        );

        const plan = planner.createPlan(MODEL_SPECS['671B'], peers);

        expect(plan.stages).toHaveLength(50);
        expect(plan.feasible).toBe(true);
        // 160 layers across 50 nodes ≈ 3-4 layers each
        const totalLayers = plan.stages.reduce((sum, s) =>
            sum + (s.layerRange[1] - s.layerRange[0] + 1), 0);
        expect(totalLayers).toBe(160);
    });
});


describe('ScalingTestHarness', () => {

    it('runs scaling test for a model spec', async () => {
        const harness = new ScalingTestHarness();

        const result = await harness.runScaleTest({
            modelSpec: MODEL_SPECS['8B'],
            nodeCount: 3,
            defaultVramMB: 8000,
        });

        expect(result.modelParams).toBe(8e9);
        expect(result.nodeCount).toBe(3);
        expect(result.plan.feasible).toBe(true);
        expect(result.plan.stages).toHaveLength(3);
    });

    it('runs progressive scale test across all model sizes', async () => {
        const harness = new ScalingTestHarness();

        const results = await harness.runProgressiveTest([
            { modelSpec: MODEL_SPECS['8B'], nodeCount: 2, defaultVramMB: 8000 },
            { modelSpec: MODEL_SPECS['14B'], nodeCount: 3, defaultVramMB: 8000 },
            { modelSpec: MODEL_SPECS['70B'], nodeCount: 10, defaultVramMB: 8000 },
            { modelSpec: MODEL_SPECS['671B'], nodeCount: 50, defaultVramMB: 12000 },
        ]);

        expect(results).toHaveLength(4);
        expect(results.every(r => r.plan.feasible)).toBe(true);
        // Latency should increase with model size
        expect(results[3].plan.estimatedLatencyMs).toBeGreaterThan(results[0].plan.estimatedLatencyMs);
    });

    it('generates scaling report with throughput metrics', async () => {
        const harness = new ScalingTestHarness();

        const result = await harness.runScaleTest({
            modelSpec: MODEL_SPECS['8B'],
            nodeCount: 2,
            defaultVramMB: 8000,
        });

        const report = harness.generateReport([result]);
        expect(report).toContain('8B');
        expect(report).toContain('Nodes');
        expect(report).toContain('Feasible');
    });
});
