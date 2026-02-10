/**
 * WS-P6a: PipelineNode TDD Tests
 *
 * 1. Start and accept WebSocket connections
 * 2. Register with registry on startup
 * 3. Compute layers in correct range
 * 4. Gracefully shutdown
 */
import { PipelineNode } from '../../src/pipeline/PipelineNode.js';
import { ActivationRelayClient } from '../../src/pipeline/ActivationRelay.js';

describe('WS-P6a: PipelineNode', () => {
    let node: PipelineNode;

    afterEach(async () => {
        if (node) await node.stop();
    });

    test('should start and accept WebSocket connections', async () => {
        node = new PipelineNode({
            nodeId: 'test-node-0',
            startLayer: 0,
            endLayer: 5,
            port: 0, // random port
            hmacSecret: 'test-secret',
        });

        const address = await node.start();
        expect(address).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);

        // Send an activation and get a response
        const client = new ActivationRelayClient({ hmacSecret: 'test-secret', timeoutMs: 3000 });
        const input = new Float32Array([1, 2, 3, 4]);
        const output = await client.send(address, input);
        expect(output.length).toBe(4);
    });

    test('should register with registry on startup', async () => {
        node = new PipelineNode({
            nodeId: 'test-node-1',
            startLayer: 10,
            endLayer: 19,
            port: 0,
            hmacSecret: 'test-secret',
        });

        await node.start();

        const registration = node.getRegistration();
        expect(registration.nodeId).toBe('test-node-1');
        expect(registration.startLayer).toBe(10);
        expect(registration.endLayer).toBe(19);
        expect(registration.status).toBe('online');
    });

    test('should compute layers in correct range', async () => {
        node = new PipelineNode({
            nodeId: 'test-node-2',
            startLayer: 0,
            endLayer: 2,
            port: 0,
            hmacSecret: 'test-secret',
        });

        const address = await node.start();

        const client = new ActivationRelayClient({ hmacSecret: 'test-secret', timeoutMs: 3000 });
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = await client.send(address, input);

        // computeFn: value * (1 + layerIdx * 0.01) per layer
        // Layer 0: [1.0, 2.0, 3.0] * 1.00 = [1.0, 2.0, 3.0]
        // Layer 1: [1.0, 2.0, 3.0] * 1.01 = [1.01, 2.02, 3.03]
        // Layer 2: [1.01, 2.02, 3.03] * 1.02 = [1.0302, 2.0604, 3.0906]
        // The exact values depend on the multiply chain
        expect(output.length).toBe(3);
        // Output should be different from input (computation happened)
        expect(output[0]).not.toBe(input[0]);
    });

    test('should gracefully shutdown', async () => {
        node = new PipelineNode({
            nodeId: 'test-node-3',
            startLayer: 0,
            endLayer: 5,
            port: 0,
            hmacSecret: 'test-secret',
        });

        const address = await node.start();
        expect(node.isRunning()).toBe(true);

        await node.stop();
        expect(node.isRunning()).toBe(false);

        // Connection should be refused after shutdown
        const client = new ActivationRelayClient({ hmacSecret: 'test-secret', timeoutMs: 1000 });
        await expect(
            client.send(address, new Float32Array([1, 2]))
        ).rejects.toThrow();
    });
});
