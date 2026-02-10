#!/usr/bin/env node
/**
 * L1 Smoke Test — 2 nodes, basic WebSocket relay.
 *
 * Validates:
 * - WebSocket connectivity between containers
 * - HMAC integrity through the pipeline
 * - Correct layer computation (layers 0-59 across 2 nodes)
 *
 * Run: npx ts-node scripts/test-l1-smoke.ts [port-start=9000]
 */

import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';

const PORT_START = parseInt(process.argv[2] ?? '9000', 10);
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'swarm-secret';
const NODES = 2;
const LAYERS_PER_NODE = 30;

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   L1 Smoke Test — 2 Nodes             ║');
    console.log('╚═══════════════════════════════════════╝');

    const addresses = Array.from({ length: NODES }, (_, i) =>
        `ws://127.0.0.1:${PORT_START + i}`
    );

    const orch = new TestOrchestrator(HMAC_SECRET);

    // 1. Health check
    console.log('\n[1/3] Health check...');
    const health = await orch.checkHealth(addresses);
    const allHealthy = health.every(h => h);
    for (let i = 0; i < NODES; i++) {
        console.log(`  node-${i}: ${health[i] ? '✅ healthy' : '❌ unhealthy'}`);
    }
    if (!allHealthy) {
        console.error('FAIL: Not all nodes are healthy');
        process.exit(1);
    }

    // 2. Pipeline inference
    console.log('\n[2/3] Running pipeline inference...');
    const input = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0]);
    const result = await orch.runPipeline(input, addresses);

    console.log(`  Input:  [${Array.from(input).join(', ')}]`);
    console.log(`  Output: [${Array.from(result.output).map(v => v.toFixed(4)).join(', ')}]`);
    console.log('  Metrics:');
    for (const hop of result.metrics.hops) {
        console.log(`    ${hop.address}: ${hop.latencyMs.toFixed(2)}ms`);
    }
    console.log(`    Total: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);

    // 3. Verify against local reference
    console.log('\n[3/3] Verifying output...');
    const totalLayers = NODES * LAYERS_PER_NODE;
    const expected = orch.computeLocalReference(input, 0, totalLayers - 1);

    const match = orch.verifyResult(result.output, expected);
    if (match) {
        console.log('  ✅ Output matches local reference');
    } else {
        console.log('  ❌ Output MISMATCH');
        console.log(`  Expected: [${Array.from(expected).map(v => v.toFixed(4)).join(', ')}]`);
        process.exit(1);
    }

    console.log('\n┌─────────────────────────────────────┐');
    console.log('│  ✅ L1 Smoke Test PASSED             │');
    console.log('└─────────────────────────────────────┘');
}

main().catch(err => {
    console.error('L1 FAILED:', err);
    process.exit(1);
});
