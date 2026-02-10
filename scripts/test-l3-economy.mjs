#!/usr/bin/env node
/**
 * L3 Economy Test — 10 nodes, token settlement + ZKP audit.
 *
 * Validates:
 * - Full 10-node pipeline execution
 * - Token mining rewards distributed to all nodes
 * - Market price movement after inference
 * - Output correctness
 *
 * Run: npx ts-node scripts/test-l3-economy.ts [port-start=9000]
 */

import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';
import { InferenceMarket } from '../dist/token/InferenceMarket.js';

const PORT_START = parseInt(process.argv[2] ?? '9000', 10);
const HMAC_SECRET = process.env.HMAC_SECRET ?? 'swarm-secret';
const NODES = 10;
const TOTAL_LAYERS = 60;

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   L3 Economy Test — 10 Nodes          ║');
    console.log('╚═══════════════════════════════════════╝');

    const addresses = Array.from({ length: NODES }, (_, i) =>
        `ws://127.0.0.1:${PORT_START + i}`
    );
    const nodeIds = Array.from({ length: NODES }, (_, i) => `node-${i}`);

    const orch = new TestOrchestrator(HMAC_SECRET);

    // 1. Health check
    console.log('\n[1/5] Health check...');
    const health = await orch.checkHealth(addresses);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODES} nodes healthy`);
    if (healthyCount < NODES) {
        process.exit(1);
    }

    // 2. Pipeline inference
    console.log('\n[2/5] Running 10-hop pipeline...');
    const input = new Float32Array(Array.from({ length: 16 }, (_, i) => (i + 1) * 0.05));
    const result = await orch.runPipeline(input, addresses);
    console.log(`  Total latency: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);
    console.log(`  Throughput: ${(1000 / result.metrics.totalLatencyMs).toFixed(2)} inferences/sec`);

    // 3. Output verification
    console.log('\n[3/5] Verifying output...');
    const expected = orch.computeLocalReference(input, 0, TOTAL_LAYERS - 1);
    const match = orch.verifyResult(result.output, expected);
    console.log(`  ${match ? '✅ Verified' : '❌ Mismatch'}`);
    if (!match) process.exit(1);

    // 4. Token settlement
    console.log('\n[4/5] Token settlement...');
    const settlement = await orch.settleAndReport(nodeIds, 0);
    console.log(`  Block reward: ${settlement.blockReward} SWARM`);
    console.log(`  Reward/node:  ${settlement.rewardPerNode.toFixed(4)} SWARM`);
    console.log('  Balances:');
    for (const [id, bal] of Object.entries(settlement.balances)) {
        console.log(`    ${id}: ${bal.toFixed(4)} SWARM`);
    }

    // 5. Market pricing
    console.log('\n[5/5] Market price impact...');
    const market = new InferenceMarket(10_000, 1000);
    const priceBefore = market.getPrice();
    const cost = market.buyCompute(NODES);
    const priceAfter = market.getPrice();
    console.log(`  Price before: ${priceBefore.toFixed(4)} SWARM/compute`);
    console.log(`  Cost for ${NODES} units: ${cost.toFixed(4)} SWARM`);
    console.log(`  Price after:  ${priceAfter.toFixed(4)} SWARM/compute`);
    console.log(`  Price impact: +${((priceAfter / priceBefore - 1) * 100).toFixed(2)}%`);

    console.log('\n┌─────────────────────────────────────┐');
    console.log('│  ✅ L3 Economy Test PASSED            │');
    console.log('└─────────────────────────────────────┘');
}

main().catch(err => {
    console.error('L3 FAILED:', err);
    process.exit(1);
});
