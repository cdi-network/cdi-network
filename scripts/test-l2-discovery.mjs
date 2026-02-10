#!/usr/bin/env node
/**
 * L2 Discovery Test — 5 nodes, registry-based pipeline assembly.
 *
 * Validates:
 * - All 5 nodes healthy and reachable
 * - Full pipeline execution across 5 hops
 * - Output correctness (60 layers across 5 nodes = 12 each)
 * - Per-hop latency distribution
 *
 * Run: npx ts-node scripts/test-l2-discovery.ts [port-start=9000]
 */

import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';

const PORT_START = parseInt(process.argv[2] ?? '9000', 10);
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'swarm-secret';
const NODES = 5;
const TOTAL_LAYERS = 60;

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   L2 Discovery Test — 5 Nodes         ║');
    console.log('╚═══════════════════════════════════════╝');

    const addresses = Array.from({ length: NODES }, (_, i) =>
        `ws://127.0.0.1:${PORT_START + i}`
    );

    const orch = new TestOrchestrator(HMAC_SECRET);

    // 1. Health check
    console.log('\n[1/4] Health check...');
    const health = await orch.checkHealth(addresses);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODES} nodes healthy`);
    if (healthyCount < NODES) {
        for (let i = 0; i < NODES; i++) {
            if (!health[i]) console.log(`  ❌ node-${i} unhealthy`);
        }
        process.exit(1);
    }

    // 2. Pipeline inference
    console.log('\n[2/4] Running 5-hop pipeline...');
    const input = new Float32Array(Array.from({ length: 10 }, (_, i) => (i + 1) * 0.1));
    const result = await orch.runPipeline(input, addresses);

    console.log(`  Input:  [${Array.from(input).map(v => v.toFixed(2)).join(', ')}]`);
    console.log(`  Output: [${Array.from(result.output).map(v => v.toFixed(6)).join(', ')}]`);

    // 3. Latency analysis
    console.log('\n[3/4] Latency analysis...');
    const latencies = result.metrics.hops.map(h => h.latencyMs);
    const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const maxLatency = Math.max(...latencies);
    const minLatency = Math.min(...latencies);

    for (const hop of result.metrics.hops) {
        const bar = '█'.repeat(Math.ceil(hop.latencyMs));
        console.log(`  ${hop.address.padEnd(25)} ${hop.latencyMs.toFixed(2).padStart(8)}ms ${bar}`);
    }
    console.log(`  ─────────────────────────────────────`);
    console.log(`  Avg: ${avgLatency.toFixed(2)}ms  Min: ${minLatency.toFixed(2)}ms  Max: ${maxLatency.toFixed(2)}ms`);
    console.log(`  Total: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);

    // 4. Output verification
    console.log('\n[4/4] Verifying output...');
    const expected = orch.computeLocalReference(input, 0, TOTAL_LAYERS - 1);
    const match = orch.verifyResult(result.output, expected);

    if (match) {
        console.log('  ✅ Output matches local reference');
    } else {
        console.log('  ❌ Output MISMATCH');
        process.exit(1);
    }

    console.log('\n┌─────────────────────────────────────┐');
    console.log('│  ✅ L2 Discovery Test PASSED          │');
    console.log('└─────────────────────────────────────┘');
}

main().catch(err => {
    console.error('L2 FAILED:', err);
    process.exit(1);
});
