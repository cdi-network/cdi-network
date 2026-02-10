#!/usr/bin/env node
/**
 * L1 Real Smoke Test — 2 Nodes + Ollama
 *
 * Verifies:
 * 1. Ollama sidecar is healthy
 * 2. Both pipeline nodes connect to Ollama
 * 3. Pipeline returns non-empty, finite output (real LLM embeddings)
 * 4. Latency measured with real compute
 */
import { TestOrchestrator } from '../dist/pipeline/TestOrchestrator.js';
import http from 'http';

const HMAC = 'swarm-secret';
const NODES = [
    'ws://127.0.0.1:9000',
    'ws://127.0.0.1:9001',
];
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
    console.log('║   L1 Real Test — 2 Nodes + Ollama     ║');
    console.log('╚═══════════════════════════════════════╝');
    console.log();

    // Step 1: Ollama health
    console.log('[1/5] Ollama health check...');
    try {
        const health = await ollamaRequest('GET', '/');
        console.log(`  Ollama status: ${health.status === 200 ? '✅ healthy' : '❌ down'}`);
        if (health.status !== 200) process.exit(1);
    } catch (e) {
        console.log(`  ❌ Ollama not reachable: ${e.message}`);
        process.exit(1);
    }

    // Step 2: Ensure model is pulled
    console.log('[2/5] Pulling tinyllama model...');
    try {
        const pull = await ollamaRequest('POST', '/api/pull', JSON.stringify({ name: 'tinyllama', stream: false }));
        console.log(`  Model pull: ${pull.status === 200 ? '✅ ready' : '⏳ ' + pull.body}`);
    } catch (e) {
        console.log(`  ⚠️ Model pull failed: ${e.message}, continuing...`);
    }

    // Step 3: Health check pipeline nodes
    console.log('[3/5] Pipeline node health...');
    const orch = TestOrchestrator.ollamaMode(HMAC, 120000);
    const health = await orch.checkHealth(NODES);
    const healthyCount = health.filter(h => h).length;
    console.log(`  ${healthyCount}/${NODES.length} nodes healthy`);
    if (healthyCount < NODES.length) {
        console.log('  ❌ Not all nodes healthy');
        process.exit(1);
    }

    // Step 4: Run pipeline with real Ollama compute
    console.log('[4/5] Running 2-hop pipeline (real Ollama)...');
    const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
    const result = await orch.runPipeline(input, NODES);

    console.log(`  Total latency: ${result.metrics.totalLatencyMs.toFixed(2)}ms`);
    console.log(`  Output length: ${result.output.length}`);
    console.log(`  Output sample: [${Array.from(result.output.slice(0, 5)).map(v => v.toFixed(4)).join(', ')}...]`);

    // Step 5: Verify output is valid
    console.log('[5/5] Verifying output...');
    const valid = orch.verifyResult(result.output, new Float32Array([])); // ollamaMode just checks finite
    console.log(`  Output valid: ${valid ? '✅' : '❌'}`);

    if (!valid) {
        console.log('  ❌ Output verification failed');
        process.exit(1);
    }

    console.log();
    console.log('┌─────────────────────────────────────┐');
    console.log('│  ✅ L1 Real Test PASSED               │');
    console.log('└─────────────────────────────────────┘');
}

main().catch((e) => {
    console.error('Test failed:', e);
    process.exit(1);
});
