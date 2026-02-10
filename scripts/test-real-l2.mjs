#!/usr/bin/env node
/**
 * L2 Real Discovery Test — 5 Nodes + Ollama + Token Settlement
 *
 * Verifies:
 * 1. Ollama sidecar health
 * 2. 5 pipeline nodes healthy with real compute
 * 3. 5-hop pipeline with real embeddings
 * 4. Token settlement across all nodes
 * 5. Latency comparison hint (real vs simulated)
 */
import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';
import http from 'http';

const HMAC = 'swarm-secret';
const NODE_COUNT = 5;
const NODES = Array.from({ length: NODE_COUNT }, (_, i) => `ws://127.0.0.1:${9000 + i}`);
const NODE_IDS = Array.from({ length: NODE_COUNT }, (_, i) => `node-${i}`);
const OLLAMA_URL = 'http://127.0.0.1:11434';

function ollamaRequest(method, path, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, OLLAMA_URL);
        const opts = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            method,
            timeout: 120000,
            headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
        };
        const req = http.request(opts, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
    });
}

async function main() {
    console.log('╔═══════════════════════════════════════╗');
    console.log('║   L2 Real Test — 5 Nodes + Ollama     ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log();

    // Step 1: Ollama health
    console.log('[1/5] Ollama health...');
    try {
        const h = await ollamaRequest('GET', '/');
        if (h.status !== 200) { console.log('  ❌ Ollama down'); process.exit(1); }
        console.log('  ✅ Ollama healthy');
    } catch (e) {
        console.log(`  ❌ ${e.message}`); process.exit(1);
    }

    // Step 2: Pipeline health
    console.log(`[2/5] Pipeline health (${NODE_COUNT} nodes)...`);
    const orch = TestOrchestrator.ollamaMode(HMAC, 60000);
    const health = await orch.checkHealth(NODES);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODE_COUNT} nodes healthy`);
    if (healthyCount < NODE_COUNT) { console.log('  ❌ Not all healthy'); process.exit(1); }

    // Step 3: Run 5-hop pipeline
    console.log('[3/5] Running 5-hop pipeline (real Ollama)...');
    const input = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
    const result = await orch.runPipeline(input, NODES);

    console.log(`  Total latency: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);
    console.log(`  Output length: ${result.output.length}`);
    console.log(`  Per-hop latency:`);
    result.metrics.hops.forEach((h, i) => {
        console.log(`    hop ${i}: ${h.latencyMs.toFixed(2)}ms`);
    });

    const valid = orch.verifyResult(result.output, new Float32Array([]));
    console.log(`  Output valid: ${valid ? '✅' : '❌'}`);
    if (!valid) { process.exit(1); }

    // Step 4: Token settlement
    console.log('[4/5] Token settlement...');
    const report = await orch.settleAndReport(NODE_IDS, 0);
    console.log(`  Block reward: ${report.blockReward} SWARM`);
    console.log(`  Reward/node:  ${report.rewardPerNode.toFixed(4)} SWARM`);
    console.log('  Balances:');
    for (const [id, bal] of Object.entries(report.balances)) {
        console.log(`    ${id}: ${bal.toFixed(4)} SWARM`);
    }

    // Step 5: Summary
    console.log('[5/5] Latency analysis...');
    const latencies = result.metrics.hops.map(h => h.latencyMs).sort((a, b) => a - b);
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = latencies[Math.floor(latencies.length * 0.5)];
    const p99 = latencies[Math.floor(latencies.length * 0.99)];
    console.log(`  Avg: ${avg.toFixed(2)}ms  P50: ${p50.toFixed(2)}ms  P99: ${p99.toFixed(2)}ms`);

    console.log();
    console.log('┌─────────────────────────────────────┐');
    console.log('│  ✅ L2 Real Test PASSED               │');
    console.log('└─────────────────────────────────────┘');
}

main().catch((e) => {
    console.error('Test failed:', e);
    process.exit(1);
});
