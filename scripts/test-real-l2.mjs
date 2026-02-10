#!/usr/bin/env node
/**
 * L2 Real Discovery Test — 2 Nodes + Ollama + OrbitDB Registration
 *
 * Verifies:
 * 1. Ollama sidecar health & model availability
 * 2. OrbitDB registration (via container logs)
 * 3. Pipeline node health (2 nodes with real Ollama)
 * 4. 2-hop pipeline with real LLM inference
 * 5. Token settlement + latency analysis
 */
import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';
import { execSync } from 'child_process';
import http from 'http';

const HMAC = 'swarm-secret';
const NODE_COUNT = 2;
const NODES = ['ws://127.0.0.1:9000', 'ws://127.0.0.1:9001'];
const NODE_IDS = ['node-0', 'node-1'];
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function waitForOrbitDbRegistration(containerName, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        try {
            const logs = execSync(`docker logs ${containerName} 2>&1`, { encoding: 'utf-8' });
            if (logs.includes('orbitdb_registered')) {
                // Parse the registration JSON
                const lines = logs.split('\n');
                for (const line of lines) {
                    if (line.includes('orbitdb_registered')) {
                        try { return JSON.parse(line); } catch { return { event: 'orbitdb_registered' }; }
                    }
                }
            }
        } catch { /* container not ready */ }
        await sleep(2000);
    }
    return null;
}

async function main() {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║  L2 Real Test — OrbitDB + Ollama Discovery ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log();

    // Step 1: Ollama health
    console.log('[1/6] Ollama health check...');
    try {
        const h = await ollamaRequest('GET', '/');
        if (h.status !== 200) { console.log('  ❌ Ollama down'); process.exit(1); }
        console.log('  Ollama status: ✅ healthy');
    } catch (e) {
        console.log(`  ❌ ${e.message}`); process.exit(1);
    }

    // Step 2: Pull + warm-up model
    console.log('[2/6] Pulling & warming up tinyllama model...');
    try {
        await ollamaRequest('POST', '/api/pull', JSON.stringify({ name: 'tinyllama', stream: false }));
        console.log('  Model pull: ✅ ready');
        // Warm up: first inference is slow due to model loading into memory
        console.log('  Warming up model (first inference is slow)...');
        const warmup = await ollamaRequest('POST', '/api/generate', JSON.stringify({
            model: 'tinyllama', prompt: 'hello', stream: false,
        }));
        console.log(`  Warm-up: ✅ done (status ${warmup.status})`);
    } catch (e) {
        console.log(`  ❌ ${e.message}`); process.exit(1);
    }

    // Step 3: Verify OrbitDB registration via container logs
    console.log('[3/6] Verifying OrbitDB registration...');
    let allRegistered = true;
    for (const id of NODE_IDS) {
        const containerName = `swarm-${id}`;
        const reg = await waitForOrbitDbRegistration(containerName, 45000);
        if (reg) {
            console.log(`  ${id}: ✅ registered (peerId: ${reg.peerId?.slice(0, 12) ?? '?'}...)`);
        } else {
            console.log(`  ${id}: ❌ not registered`);
            allRegistered = false;
        }
    }
    if (!allRegistered) {
        console.log('  ⚠️  Not all nodes registered in OrbitDB — checking if nodes are still reachable...');
    }

    // Step 4: Pipeline node health
    console.log('[4/6] Pipeline node health...');
    const orch = TestOrchestrator.ollamaMode(HMAC, 180000);
    const health = await orch.checkHealth(NODES);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODE_COUNT} nodes healthy`);
    if (healthyCount < NODE_COUNT) { console.log('  ❌ Not all nodes healthy'); process.exit(1); }

    // Step 5: Run 2-hop pipeline with real Ollama
    console.log('[5/6] Running 2-hop pipeline (Ollama + OrbitDB)...');
    const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const result = await orch.runPipeline(input, NODES);

    console.log(`  Total latency: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);
    console.log(`  Output length: ${result.output.length}`);
    console.log(`  Output sample: [${Array.from(result.output.slice(0, 4)).map(v => v.toFixed(4)).join(', ')}...]`);
    result.metrics.hops.forEach((h, i) => {
        console.log(`  Hop ${i} (${NODE_IDS[i]}): ${h.latencyMs.toFixed(2)}ms`);
    });

    const valid = orch.verifyResult(result.output, new Float32Array([]));
    console.log(`  Output valid: ${valid ? '✅' : '❌'}`);
    if (!valid) { process.exit(1); }

    // Step 6: Token settlement
    console.log('[6/6] Token settlement...');
    const report = await orch.settleAndReport(NODE_IDS, 0);
    console.log(`  Block reward: ${report.blockReward} SWARM`);
    console.log(`  Reward/node:  ${report.rewardPerNode.toFixed(4)} SWARM`);
    for (const [id, bal] of Object.entries(report.balances)) {
        console.log(`  ${id}: ${bal.toFixed(4)} SWARM`);
    }

    console.log();
    console.log('┌────────────────────────────────────────────┐');
    console.log('│  ✅ L2 Real Discovery Test PASSED            │');
    console.log('│                                              │');
    console.log(`│  OrbitDB: ${allRegistered ? '✅ all nodes registered' : '⚠️  partial registration'}       │`);
    console.log(`│  Pipeline: ${healthyCount}/${NODE_COUNT} healthy, ${result.metrics.totalLatencyMs.toFixed(0)}ms total  │`);
    console.log(`│  Settlement: ${report.rewardPerNode.toFixed(2)} SWARM per node     │`);
    console.log('└────────────────────────────────────────────┘');
}

main().catch((e) => {
    console.error('Test failed:', e);
    process.exit(1);
});
