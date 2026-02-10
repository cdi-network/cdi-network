/**
 * WS-P6c: TestOrchestrator TDD Tests
 *
 * 1. Detect healthy nodes via WebSocket ping
 * 2. Compute local reference result
 * 3. Report per-hop latency metrics
 * 4. Settle tokens after pipeline execution
 */
import { TestOrchestrator } from '../../src/pipeline/TestOrchestrator.js';
import { PipelineNode } from '../../src/pipeline/PipelineNode.js';

describe('WS-P6c: TestOrchestrator', () => {
    const nodes: PipelineNode[] = [];

    afterEach(async () => {
        for (const n of nodes) await n.stop();
        nodes.length = 0;
    });

    test('should detect healthy nodes via WebSocket ping', async () => {
        const n0 = new PipelineNode({
            nodeId: 'health-0', startLayer: 0, endLayer: 4,
            port: 0, hmacSecret: 'test-secret',
        });
        const addr = await n0.start();
        nodes.push(n0);

        const orch = TestOrchestrator.simulated('test-secret');
        const healthy = await orch.checkHealth([addr]);
        expect(healthy).toEqual([true]);
    });

    test('should compute local reference result', () => {
        const orch = TestOrchestrator.simulated('test-secret');
        const input = new Float32Array([1.0, 2.0, 3.0]);

        // Reference: compute layers 0-2 locally
        const expected = orch.computeLocalReference(input, 0, 2);
        expect(expected.length).toBe(3);
        // Layer 0: *= 1.00, Layer 1: *= 1.01, Layer 2: *= 1.02
        expect(expected[0]).toBeCloseTo(1.0 * 1.00 * 1.01 * 1.02, 4);
    });

    test('should report per-hop latency metrics', async () => {
        const n0 = new PipelineNode({
            nodeId: 'metric-0', startLayer: 0, endLayer: 4,
            port: 0, hmacSecret: 'test-secret',
        });
        const n1 = new PipelineNode({
            nodeId: 'metric-1', startLayer: 5, endLayer: 9,
            port: 0, hmacSecret: 'test-secret',
        });
        const a0 = await n0.start();
        const a1 = await n1.start();
        nodes.push(n0, n1);

        const orch = TestOrchestrator.simulated('test-secret');
        const input = new Float32Array([1, 2, 3, 4]);
        const result = await orch.runPipeline(input, [a0, a1]);

        expect(result.output.length).toBe(4);
        expect(result.metrics.hops.length).toBe(2);
        expect(result.metrics.hops[0].latencyMs).toBeGreaterThan(0);
        expect(result.metrics.totalLatencyMs).toBeGreaterThan(0);
    });

    test('should settle tokens after pipeline execution', async () => {
        const orch = TestOrchestrator.simulated('test-secret');
        const settlement = await orch.settleAndReport(
            ['node-0', 'node-1', 'node-2'],
            0,
        );

        expect(settlement.blockReward).toBe(50);
        expect(settlement.rewardPerNode).toBeCloseTo(50 / 3, 2);
        expect(settlement.balances['node-0']).toBeCloseTo(50 / 3, 2);
        expect(settlement.balances['node-1']).toBeCloseTo(50 / 3, 2);
        expect(settlement.balances['node-2']).toBeCloseTo(50 / 3, 2);
    });
});
