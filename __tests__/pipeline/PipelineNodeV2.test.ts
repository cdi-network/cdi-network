/**
 * WS-P7b: PipelineNode v2 TDD Tests — Dual Mode
 *
 * Tests the upgraded PipelineNode with COMPUTE_MODE and REGISTRY_MODE switching.
 * Existing tests (WS-P6a) cover simulated mode basics.
 * These tests verify mode selection, Ollama adapter integration, and env parsing.
 */
import http from 'http';
import { PipelineNode } from '../../src/pipeline/PipelineNode.js';
import { ActivationRelayClient } from '../../src/pipeline/ActivationRelay.js';

describe('WS-P7b: PipelineNode v2 — Dual Mode', () => {
    let node: PipelineNode;
    let mockOllama: http.Server;

    afterEach(async () => {
        if (node) await node.stop();
        if (mockOllama) await new Promise<void>((r) => mockOllama.close(() => r()));
    });

    test('should default to simulated mode', () => {
        node = new PipelineNode({
            nodeId: 'test-simulated',
            startLayer: 0,
            endLayer: 5,
            port: 0,
            hmacSecret: 'secret',
        });

        expect(node.getComputeMode()).toBe('simulated');
        expect(node.getRegistryMode()).toBe('none');
        expect(node.getRegistration().model).toBe('simulated');
    });

    test('should use ollama mode when configured', async () => {
        // Start mock Ollama server (handles both embed and generate)
        mockOllama = await new Promise<http.Server>((resolve) => {
            const server = http.createServer((req, res) => {
                let body = '';
                req.on('data', (c: Buffer) => { body += c.toString(); });
                req.on('end', () => {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    if (req.url === '/api/embed') {
                        res.end(JSON.stringify({ model: 'test', embeddings: [[0.5, 0.6, 0.7]] }));
                    } else if (req.url === '/api/generate') {
                        res.end(JSON.stringify({ response: '0.5, 0.6, 0.7' }));
                    } else {
                        res.end('ok');
                    }
                });
            });
            server.listen(0, '127.0.0.1', () => resolve(server));
        });
        const ollamaPort = (mockOllama.address() as any).port;

        node = new PipelineNode({
            nodeId: 'test-ollama',
            startLayer: 0,
            endLayer: 0,
            port: 0,
            hmacSecret: 'secret',
            computeMode: 'ollama',
            ollamaHost: '127.0.0.1',
            ollamaPort,
            ollamaModel: 'test-model',
            ollamaApiMode: 'embed',
        });

        expect(node.getComputeMode()).toBe('ollama');
        expect(node.getRegistration().model).toBe('test-model');

        // Verify actual Ollama compute works through the pipeline
        const address = await node.start();
        const client = new ActivationRelayClient({ hmacSecret: 'secret', timeoutMs: 3000 });
        const output = await client.send(address, new Float32Array([1.0, 2.0, 3.0]));

        // The mock returns [0.5, 0.6, 0.7] regardless of input
        expect(output.length).toBe(3);
        expect(output[0]).toBeCloseTo(0.5, 4);
        expect(output[1]).toBeCloseTo(0.6, 4);
        expect(output[2]).toBeCloseTo(0.7, 4);
    });

    test('should parse fromEnv with compute and registry modes', () => {
        // Save and set env vars
        const origCompute = process.env.COMPUTE_MODE;
        const origRegistry = process.env.REGISTRY_MODE;
        const origOllamaHost = process.env.OLLAMA_HOST;
        const origOllamaPort = process.env.OLLAMA_PORT;
        const origOllamaModel = process.env.OLLAMA_MODEL;

        process.env.COMPUTE_MODE = 'ollama';
        process.env.REGISTRY_MODE = 'none'; // OrbitDB requires libp2p, skip in unit test
        process.env.OLLAMA_HOST = 'ollama-sidecar';
        process.env.OLLAMA_PORT = '11434';
        process.env.OLLAMA_MODEL = 'tinyllama';
        process.env.NODE_ID = 'env-node';

        try {
            node = PipelineNode.fromEnv();
            expect(node.getComputeMode()).toBe('ollama');
            expect(node.getRegistryMode()).toBe('none');
            expect(node.getRegistration().model).toBe('tinyllama');
            expect(node.getRegistration().nodeId).toBe('env-node');
        } finally {
            // Restore
            process.env.COMPUTE_MODE = origCompute;
            process.env.REGISTRY_MODE = origRegistry;
            process.env.OLLAMA_HOST = origOllamaHost;
            process.env.OLLAMA_PORT = origOllamaPort;
            process.env.OLLAMA_MODEL = origOllamaModel;
            delete process.env.NODE_ID;
        }
    });

    test('should still work in simulated mode (backwards compat)', async () => {
        node = new PipelineNode({
            nodeId: 'compat-node',
            startLayer: 0,
            endLayer: 2,
            port: 0,
            hmacSecret: 'secret',
            computeMode: 'simulated',
        });

        const address = await node.start();
        const client = new ActivationRelayClient({ hmacSecret: 'secret', timeoutMs: 3000 });
        const input = new Float32Array([1.0, 2.0]);
        const output = await client.send(address, input);

        // Simulated: value * (1 + layerIdx * 0.01) per layer
        // Layer 0: [1.0, 2.0] * 1.00 = [1.0, 2.0]
        // Layer 1: [1.0, 2.0] * 1.01 = [1.01, 2.02]
        // Layer 2: [1.01, 2.02] * 1.02 ≈ [1.0302, 2.0604]
        expect(output.length).toBe(2);
        expect(output[0]).toBeCloseTo(1.0302, 3);
        expect(output[1]).toBeCloseTo(2.0604, 3);
    });

    // ── WS-P8a: ADVERTISE_HOST ──────────────────────────────

    test('should use advertiseHost for registration instead of 127.0.0.1', async () => {
        node = new PipelineNode({
            nodeId: 'docker-node',
            startLayer: 0,
            endLayer: 1,
            port: 0,
            hmacSecret: 'secret',
            advertiseHost: 'swarm-node-0',
        });

        await node.start();
        const reg = node.getRegistration();
        expect(reg.host).toBe('swarm-node-0');
    });

    test('should parse ADVERTISE_HOST from env', () => {
        const origAdvHost = process.env.ADVERTISE_HOST;
        process.env.ADVERTISE_HOST = 'my-container';
        process.env.NODE_ID = 'env-adv-node';

        try {
            node = PipelineNode.fromEnv();
            expect(node.getRegistration().host).toBe('my-container');
        } finally {
            if (origAdvHost === undefined) delete process.env.ADVERTISE_HOST;
            else process.env.ADVERTISE_HOST = origAdvHost;
            delete process.env.NODE_ID;
        }
    });

    test('should default registration host to 127.0.0.1 when no advertiseHost', async () => {
        node = new PipelineNode({
            nodeId: 'default-host',
            startLayer: 0,
            endLayer: 0,
            port: 0,
            hmacSecret: 'secret',
        });

        await node.start();
        expect(node.getRegistration().host).toBe('127.0.0.1');
    });
});
