#!/usr/bin/env node
/**
 * L4 Scale Test — 20 nodes, throughput and latency stress test.
 *
 * Validates:
 * - All 20 nodes healthy
 * - Full 20-hop pipeline execution
 * - Concurrent pipeline executions (3 parallel inferences)
 * - Latency distribution analysis
 * - Output correctness
 *
 * Run: npx ts-node scripts/test-l4-scale.ts [port-start=9000]
 */

import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';

const PORT_START = parseInt(process.argv[2] ?? '9000', 10);
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'swarm-secret';
const NODES = 20;
const TOTAL_LAYERS = 60;
const CONCURRENT = 3;

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   L4 Scale Test — 20 Nodes            ║');
    console.log('╚═══════════════════════════════════════╝');

    const addresses = Array.from({ length: NODES }, (_, i) =>
        `ws://127.0.0.1:${PORT_START + i}`
    );

    const orch = new TestOrchestrator(HMAC_SECRET, 10000);

    // 1. Health check
    console.log('\n[1/4] Health check...');
    const health = await orch.checkHealth(addresses);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODES} nodes healthy`);
    if (healthyCount < NODES) {
        const unhealthy = health.map((h, i) => h ? null : i).filter(i => i !== null);
        console.log(`  Unhealthy: ${unhealthy.map(i => `node-${i}`).join(', ')}`);
        process.exit(1);
    }

    // 2. Single pipeline
    console.log('\n[2/4] Single pipeline run...');
    const input = new Float32Array(Array.from({ length: 32 }, (_, i) => (i + 1) * 0.03));
    const result = await orch.runPipeline(input, addresses);

    const expected = orch.computeLocalReference(input, 0, TOTAL_LAYERS - 1);
    const match = orch.verifyResult(result.output, expected);
    console.log(`  Latency: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);
    console.log(`  Output correct: ${match ? '✅' : '❌'}`);
    if (!match) process.exit(1);

    // 3. Concurrent pipelines
    console.log(`\n[3/4] ${CONCURRENT} concurrent pipelines...`);
    const concurrentStart = performance.now();
    const inputs = Array.from({ length: CONCURRENT }, (_, i) =>
        new Float32Array(Array.from({ length: 32 }, (_, j) => (i * 32 + j + 1) * 0.01))
    );

    const results = await Promise.all(
        inputs.map(inp => orch.runPipeline(inp, addresses))
    );
    const concurrentDuration = performance.now() - concurrentStart;

    let allCorrect = true;
    for (let i = 0; i < CONCURRENT; i++) {
        const exp = orch.computeLocalReference(inputs[i], 0, TOTAL_LAYERS - 1);
        const ok = orch.verifyResult(results[i].output, exp);
        if (!ok) allCorrect = false;
        console.log(`  Pipeline ${i}: ${results[i].metrics.totalLatencyMs.toFixed(2)}ms ${ok ? '✅' : '❌'}`);
    }
    console.log(`  Total concurrent time: ${concurrentDuration.toFixed(2)}ms`);
    console.log(`  Throughput: ${(CONCURRENT / (concurrentDuration / 1000)).toFixed(2)} inf/sec`);
    if (!allCorrect) process.exit(1);

    // 4. Latency distribution
    console.log('\n[4/4] Latency distribution (single run)...');
    const latencies = result.metrics.hops.map(h => h.latencyMs);
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p90 = sorted[Math.floor(sorted.length * 0.9)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;

    console.log(`  Avg: ${avg.toFixed(2)}ms  P50: ${p50.toFixed(2)}ms  P90: ${p90.toFixed(2)}ms  P99: ${p99.toFixed(2)}ms`);

    console.log('\n┌─────────────────────────────────────┐');
    console.log('│  ✅ L4 Scale Test PASSED              │');
    console.log('└─────────────────────────────────────┘');
}

main().catch(err => {
    console.error('L4 FAILED:', err);
    process.exit(1);
});
