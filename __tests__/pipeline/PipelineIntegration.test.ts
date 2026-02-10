/**
 * WS-P4: Pipeline Integration Tests
 *
 * End-to-end tests wiring together:
 * - ActivationRelay (WebSocket transport)
 * - PipelineRegistry (node discovery)
 * - ActivationMasker (privacy masking)
 * - ZKPProver/Verifier (computation verification)
 * - NetworkPipelineRouter (orchestration)
 */
import { jest } from '@jest/globals';
import { NetworkPipelineRouter } from '../../src/pipeline/NetworkPipelineRouter.js';
import { ActivationRelayServer, ActivationRelayClient } from '../../src/pipeline/ActivationRelay.js';
import { PipelineRegistry } from '../../src/pipeline/PipelineRegistry.js';
import { ActivationMasker } from '../../src/pipeline/ActivationMasker.js';
import { ZKPProver, ZKPVerifier } from '../../src/pipeline/ZKPProver.js';
import { LayerServer } from '../../src/pipeline/LayerServer.js';

function mockCompute(input: Float32Array, layerIdx: number): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * 2 + layerIdx * 0.1;
    }
    return output;
}

function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: jest.fn(async (entry: any) => { data.set(entry._id, entry); }),
        get: jest.fn(async (id: string) => data.get(id) ?? null),
        del: jest.fn(async (id: string) => { data.delete(id); }),
        all: jest.fn(async () => Array.from(data.entries()).map(([key, value]) => ({ key, value }))),
    };
}

describe('WS-P4: Pipeline Integration', () => {
    let servers: ActivationRelayServer[] = [];

    afterEach(async () => {
        for (const s of servers) {
            await s.close();
        }
        servers = [];
    });

    test('full pipeline over WebSocket produces correct output', async () => {
        const hmacSecret = 'integration-test';

        // Set up 3 relay nodes
        const nodes = [
            { id: 'n0', startLayer: 0, endLayer: 0 },
            { id: 'n1', startLayer: 1, endLayer: 1 },
            { id: 'n2', startLayer: 2, endLayer: 2 },
        ];

        const addresses: string[] = [];
        for (const n of nodes) {
            const server = new ActivationRelayServer({
                port: 0,
                layerServer: new LayerServer({
                    nodeId: n.id,
                    startLayer: n.startLayer,
                    endLayer: n.endLayer,
                    computeFn: mockCompute,
                }),
                hmacSecret,
            });
            servers.push(server);
            addresses.push(await server.listen());
        }

        // Chain through all 3 nodes via client
        const client = new ActivationRelayClient({ hmacSecret, timeoutMs: 5000 });
        const input = new Float32Array([1.0, 2.0, 3.0]);

        let current: Float32Array = new Float32Array(input);
        for (const addr of addresses) {
            current = new Float32Array(await client.send(addr, current));
        }

        // Verify: compute locally
        let expected: Float32Array = new Float32Array(input);
        for (let i = 0; i <= 2; i++) {
            expected = new Float32Array(mockCompute(expected, i));
        }

        for (let i = 0; i < current.length; i++) {
            expect(current[i]).toBeCloseTo(expected[i], 4);
        }
    });

    test('masked inference produces same result as unmasked', async () => {
        const masker = new ActivationMasker();
        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        // Simple linear transform: y = 2*x (represented as weights)
        const weights = new Float32Array([
            2, 0, 0, 0,
            0, 2, 0, 0,
            0, 0, 2, 0,
            0, 0, 0, 2,
        ]);
        const bias = new Float32Array(4);

        // Direct result
        const directResult = masker.linearTransform(input, weights, 4, 4, bias);

        // Masked result
        const mask = masker.generateMask(input.length);
        const maskedInput = masker.applyMask(input, mask);
        const maskedResult = masker.linearTransform(maskedInput, weights, 4, 4, bias);
        const maskContribution = masker.linearTransform(mask, weights, 4, 4, new Float32Array(4));
        const unmaskedResult = masker.removeMask(maskedResult, maskContribution);

        // Should match within floating point tolerance
        for (let i = 0; i < directResult.length; i++) {
            expect(unmaskedResult[i]).toBeCloseTo(directResult[i], 3);
        }
    });

    test('tampered node detected via ZKP', async () => {
        const prover = new ZKPProver();
        const verifier = new ZKPVerifier();

        const input = new Float32Array([1.0, 2.0]);
        const weights = new Float32Array([1, 0, 0, 1]); // identity
        const correctOutput = new Float32Array([1.0, 2.0]);
        const tamperedOutput = new Float32Array([999.0, 999.0]);

        // Correct computation → valid proof
        const goodProof = await prover.generateProof(input, correctOutput, weights, 2, 2);
        expect(await verifier.verifyProof(goodProof)).toBe(true);

        // Tampered computation → invalid proof
        const badProof = await prover.generateProof(input, tamperedOutput, weights, 2, 2);
        expect(await verifier.verifyProof(badProof)).toBe(false);
    });

    test('PipelineRegistry auto-discovers and assembles pipeline', async () => {
        const store = createMockStore();
        const registry = new PipelineRegistry(store as any);
        const hmacSecret = 'registry-test';

        // Start 3 relay servers
        const nodeConfigs = [
            { nodeId: 'r0', startLayer: 0, endLayer: 9 },
            { nodeId: 'r1', startLayer: 10, endLayer: 19 },
            { nodeId: 'r2', startLayer: 20, endLayer: 29 },
        ];

        for (const conf of nodeConfigs) {
            const server = new ActivationRelayServer({
                port: 0,
                layerServer: new LayerServer({
                    nodeId: conf.nodeId,
                    startLayer: conf.startLayer,
                    endLayer: conf.endLayer,
                    computeFn: mockCompute,
                }),
                hmacSecret,
            });
            servers.push(server);
            const addr = await server.listen();
            const port = parseInt(new URL(addr).port, 10);

            await registry.registerNode({
                nodeId: conf.nodeId,
                peerId: `peer-${conf.nodeId}`,
                host: '127.0.0.1',
                port,
                startLayer: conf.startLayer,
                endLayer: conf.endLayer,
                model: 'test-model',
            });
        }

        // Discover pipeline
        const pipeline = await registry.discoverPipeline('test-model', 30);
        expect(pipeline.length).toBe(3);
        expect(pipeline[0].nodeId).toBe('r0');
        expect(pipeline[1].nodeId).toBe('r1');
        expect(pipeline[2].nodeId).toBe('r2');

        // Use discovered pipeline to route activations
        const client = new ActivationRelayClient({ hmacSecret, timeoutMs: 5000 });
        const input = new Float32Array([1.0, 2.0]);

        let current: Float32Array = new Float32Array(input);
        for (const node of pipeline) {
            const addr = `ws://${node.host}:${node.port}`;
            current = new Float32Array(await client.send(addr, current));
        }

        // Output should exist and be a Float32Array
        expect(current).toBeInstanceOf(Float32Array);
        expect(current.length).toBe(input.length);
    });
});
