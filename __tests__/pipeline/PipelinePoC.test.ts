/**
 * Fase 0 PoC: Pipeline-Parallel Inference Tests
 *
 * Validates that:
 * 1. A model can be logically split into layer ranges
 * 2. Activations are relayed correctly between pipeline stages
 * 3. The pipeline produces identical output to single-node inference
 * 4. Fault detection catches corrupted activations
 * 5. E2E encryption on activations works
 */
import { jest } from '@jest/globals';
import { LayerServer } from '../../src/pipeline/LayerServer.js';
import { PipelineRouter } from '../../src/pipeline/PipelineRouter.js';
import type { PipelineStage, ActivationPacket } from '../../src/pipeline/types.js';

// --- Mock layer computation (simulates transformer block forward pass) ---
function mockLayerCompute(input: Float32Array, layerIdx: number): Float32Array {
    // Deterministic transformation: multiply each element by (layerIdx + 1) / 10
    const output = new Float32Array(input.length);
    const scale = (layerIdx + 1) / 10;
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * scale + 0.01 * layerIdx;
    }
    return output;
}

// Compute expected result by running all layers sequentially
function computeExpected(input: Float32Array, totalLayers: number): Float32Array {
    let current = input;
    for (let i = 0; i < totalLayers; i++) {
        current = mockLayerCompute(current, i);
    }
    return current;
}

describe('Fase 0 PoC: Pipeline Parallel Inference', () => {

    test('LayerServer should process its assigned layer range', async () => {
        const server = new LayerServer({
            nodeId: 'node-0',
            startLayer: 0,
            endLayer: 2,
            computeFn: mockLayerCompute,
        });

        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const result = await server.forward(input);

        // Should have applied layers 0, 1, 2 sequentially
        let expected: Float32Array = new Float32Array(input);
        for (let i = 0; i <= 2; i++) {
            expected = new Float32Array(mockLayerCompute(expected, i));
        }
        expect(Array.from(result)).toEqual(Array.from(expected));
    });

    test('PipelineRouter should chain stages and relay activations', async () => {
        const stages: PipelineStage[] = [
            new LayerServer({ nodeId: 'node-0', startLayer: 0, endLayer: 3, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'node-1', startLayer: 4, endLayer: 7, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'node-2', startLayer: 8, endLayer: 11, computeFn: mockLayerCompute }),
        ];

        const router = new PipelineRouter(stages);
        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const result = await router.infer(input);

        // Should be identical to running all 12 layers locally
        const expected = computeExpected(input, 12);
        expect(result.length).toBe(expected.length);
        for (let i = 0; i < result.length; i++) {
            expect(result[i]).toBeCloseTo(expected[i], 5);
        }
    });

    test('PipelineRouter should detect corrupted activations via checksum', async () => {
        const corruptStage: PipelineStage = {
            nodeId: 'evil-node',
            forward: async (input: Float32Array) => {
                // Corrupt the output
                const bad = new Float32Array(input.length);
                bad[0] = NaN;
                return bad;
            },
        };

        const stages: PipelineStage[] = [
            new LayerServer({ nodeId: 'node-0', startLayer: 0, endLayer: 3, computeFn: mockLayerCompute }),
            corruptStage,
            new LayerServer({ nodeId: 'node-2', startLayer: 8, endLayer: 11, computeFn: mockLayerCompute }),
        ];

        const router = new PipelineRouter(stages, { validateActivations: true });
        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        await expect(router.infer(input)).rejects.toThrow(/corrupted/i);
    });

    test('ActivationPacket should encrypt and decrypt correctly', async () => {
        const { ActivationPacket: AP } = await import('../../src/pipeline/types.js');

        const data = new Float32Array([1.0, 2.0, 3.0]);
        const key = 'test-secret-key-32bytes-padding!'; // 32 bytes

        const encrypted = AP.encrypt(data, key);
        expect(encrypted).not.toEqual(data); // Should be different

        const decrypted = AP.decrypt(encrypted, key);
        expect(Array.from(decrypted)).toEqual(Array.from(data));
    });

    test('Pipeline should preserve output equivalence across 1-stage and multi-stage', async () => {
        const totalLayers = 8;
        const input = new Float32Array([0.5, 1.5, 2.5, 3.5]);

        // Single-stage: one node does all 8 layers
        const singleStage = new PipelineRouter([
            new LayerServer({ nodeId: 'single', startLayer: 0, endLayer: 7, computeFn: mockLayerCompute }),
        ]);

        // Multi-stage: 4 nodes each do 2 layers
        const multiStage = new PipelineRouter([
            new LayerServer({ nodeId: 'n0', startLayer: 0, endLayer: 1, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'n1', startLayer: 2, endLayer: 3, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'n2', startLayer: 4, endLayer: 5, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'n3', startLayer: 6, endLayer: 7, computeFn: mockLayerCompute }),
        ]);

        const singleResult = await singleStage.infer(input);
        const multiResult = await multiStage.infer(input);

        // Must produce identical output
        expect(singleResult.length).toBe(multiResult.length);
        for (let i = 0; i < singleResult.length; i++) {
            expect(singleResult[i]).toBeCloseTo(multiResult[i], 5);
        }
    });

    test('Pipeline should report latency per stage', async () => {
        const stages: PipelineStage[] = [
            new LayerServer({ nodeId: 'n0', startLayer: 0, endLayer: 3, computeFn: mockLayerCompute }),
            new LayerServer({ nodeId: 'n1', startLayer: 4, endLayer: 7, computeFn: mockLayerCompute }),
        ];

        const router = new PipelineRouter(stages, { collectMetrics: true });
        const input = new Float32Array([1.0, 2.0]);
        await router.infer(input);

        const metrics = router.getLastMetrics();
        expect(metrics).toBeDefined();
        expect(metrics!.stages.length).toBe(2);
        expect(metrics!.stages[0].nodeId).toBe('n0');
        expect(metrics!.stages[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(metrics!.totalDurationMs).toBeGreaterThanOrEqual(0);
    });
});
