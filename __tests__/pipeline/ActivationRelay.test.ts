/**
 * WS-P1: ActivationRelay TDD Tests
 *
 * Validates WebSocket-based activation transport between pipeline nodes:
 * 1. Relay activations between two local nodes and verify output
 * 2. Detect tampered activations via HMAC
 * 3. Timeout on unresponsive node
 * 4. Handle concurrent inference requests with isolation
 */
import { jest } from '@jest/globals';
import { ActivationRelayServer, ActivationRelayClient } from '../../src/pipeline/ActivationRelay.js';
import { LayerServer } from '../../src/pipeline/LayerServer.js';

function mockCompute(input: Float32Array, layerIdx: number): Float32Array {
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * 2 + layerIdx * 0.1;
    }
    return output;
}

describe('WS-P1: ActivationRelay', () => {
    let servers: ActivationRelayServer[] = [];

    afterEach(async () => {
        for (const s of servers) {
            await s.close();
        }
        servers = [];
    });

    test('should relay activations between two local nodes', async () => {
        // Node A serves layers 0-1, Node B serves layers 2-3
        const nodeA = new ActivationRelayServer({
            port: 0, // OS-assigned
            layerServer: new LayerServer({ nodeId: 'A', startLayer: 0, endLayer: 1, computeFn: mockCompute }),
            hmacSecret: 'test-secret',
        });
        servers.push(nodeA);
        const addrA = await nodeA.listen();

        const nodeB = new ActivationRelayServer({
            port: 0,
            layerServer: new LayerServer({ nodeId: 'B', startLayer: 2, endLayer: 3, computeFn: mockCompute }),
            hmacSecret: 'test-secret',
        });
        servers.push(nodeB);
        const addrB = await nodeB.listen();

        // Client sends input to A, A's output goes to B, B returns final result
        const client = new ActivationRelayClient({ hmacSecret: 'test-secret', timeoutMs: 5000 });
        const input = new Float32Array([1.0, 2.0, 3.0]);

        const afterA = await client.send(addrA, input);
        const afterB = await client.send(addrB, afterA);

        // Verify by computing locally
        let expected: Float32Array = new Float32Array(input);
        for (let i = 0; i <= 3; i++) {
            expected = new Float32Array(mockCompute(expected, i));
        }
        expect(afterB.length).toBe(expected.length);
        for (let i = 0; i < afterB.length; i++) {
            expect(afterB[i]).toBeCloseTo(expected[i], 5);
        }
    });

    test('should detect tampered activations via HMAC', async () => {
        const node = new ActivationRelayServer({
            port: 0,
            layerServer: new LayerServer({ nodeId: 'C', startLayer: 0, endLayer: 0, computeFn: mockCompute }),
            hmacSecret: 'server-secret',
        });
        servers.push(node);
        const addr = await node.listen();

        // Client uses WRONG secret → HMAC mismatch at server
        const client = new ActivationRelayClient({ hmacSecret: 'WRONG-secret', timeoutMs: 5000 });
        const input = new Float32Array([1.0, 2.0]);

        await expect(client.send(addr, input)).rejects.toThrow(/hmac/i);
    });

    test('should timeout on unresponsive node', async () => {
        // Connect to a port where nothing listens (very short timeout)
        const client = new ActivationRelayClient({ hmacSecret: 'test', timeoutMs: 500 });
        const input = new Float32Array([1.0]);

        // Port 19999 — nothing should be listening
        await expect(client.send('ws://127.0.0.1:19999', input)).rejects.toThrow(/timeout|ECONNREFUSED|connect/i);
    });

    test('should handle concurrent inference requests', async () => {
        const node = new ActivationRelayServer({
            port: 0,
            layerServer: new LayerServer({ nodeId: 'D', startLayer: 0, endLayer: 0, computeFn: mockCompute }),
            hmacSecret: 'shared',
        });
        servers.push(node);
        const addr = await node.listen();

        const client = new ActivationRelayClient({ hmacSecret: 'shared', timeoutMs: 5000 });

        // Send 3 concurrent requests with different inputs
        const results = await Promise.all([
            client.send(addr, new Float32Array([1.0])),
            client.send(addr, new Float32Array([2.0])),
            client.send(addr, new Float32Array([3.0])),
        ]);

        // Each should get its own correct result
        expect(results[0][0]).toBeCloseTo(mockCompute(new Float32Array([1.0]), 0)[0], 5);
        expect(results[1][0]).toBeCloseTo(mockCompute(new Float32Array([2.0]), 0)[0], 5);
        expect(results[2][0]).toBeCloseTo(mockCompute(new Float32Array([3.0]), 0)[0], 5);
    });
});
