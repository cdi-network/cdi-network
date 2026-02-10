/**
 * WS-P7c: TestOrchestrator v2 TDD Tests
 *
 * Tests the upgraded TestOrchestrator with:
 * - External ledger store injection
 * - Ollama mode (skip verification)
 * - Factory methods
 * - Backwards compatibility with simulated mode
 */
import { TestOrchestrator, type LedgerStoreProvider } from '../../src/pipeline/TestOrchestrator.js';

describe('WS-P7c: TestOrchestrator v2', () => {
    test('should default to in-memory store', () => {
        const orchestrator = TestOrchestrator.simulated('secret');
        expect(orchestrator.getStoreType()).toBe('in-memory');
    });

    test('should accept external store', async () => {
        // Create a spy store to verify calls
        const ops: string[] = [];
        const externalStore: LedgerStoreProvider = {
            put: async (entry: any) => { ops.push(`put:${entry._id}`); },
            get: async (id: string) => { ops.push(`get:${id}`); return null; },
            del: async (id: string) => { ops.push(`del:${id}`); },
            all: async () => { ops.push('all'); return []; },
        };

        const orchestrator = TestOrchestrator.withStore('secret', externalStore);
        expect(orchestrator.getStoreType()).toBe('external');

        // Settle uses the store — verify it's called
        const report = await orchestrator.settleAndReport(['node-a', 'node-b'], 0);
        expect(report.blockReward).toBe(50);
        expect(ops.some(o => o.startsWith('get:'))).toBe(true);
        expect(ops.some(o => o.startsWith('put:'))).toBe(true);
    });

    test('should support ollamaMode with skip verification', () => {
        const orchestrator = TestOrchestrator.ollamaMode('secret');

        // In ollama mode, verification should pass for any valid floats
        const actual = new Float32Array([0.123, 0.456, 0.789]);
        const expected = new Float32Array([9.99, 8.88, 7.77]); // Completely different
        const result = orchestrator.verifyResult(actual, expected);
        expect(result).toBe(true); // Should pass because we skip comparison

        // But empty output should still fail
        const emptyResult = orchestrator.verifyResult(new Float32Array([]), expected);
        expect(emptyResult).toBe(false);

        // Output with NaN/Infinity should fail
        const nanResult = orchestrator.verifyResult(new Float32Array([NaN, 0.5]), expected);
        expect(nanResult).toBe(false);
    });

    test('should verify result strictly in simulated mode', () => {
        const orchestrator = TestOrchestrator.simulated('secret');

        // Same values should pass
        const a = new Float32Array([1.0, 2.0, 3.0]);
        const b = new Float32Array([1.0, 2.0, 3.0]);
        expect(orchestrator.verifyResult(a, b)).toBe(true);

        // Different values should fail
        const c = new Float32Array([1.0, 2.0, 3.0]);
        const d = new Float32Array([1.0, 2.0, 9.0]);
        expect(orchestrator.verifyResult(c, d)).toBe(false);
    });

    test('should use custom local compute function', () => {
        const customComputeFn = (input: Float32Array, _layerIdx: number): Float32Array => {
            const out = new Float32Array(input.length);
            for (let i = 0; i < input.length; i++) out[i] = input[i] * 2;
            return out;
        };

        const orchestrator = new TestOrchestrator({
            hmacSecret: 'secret',
            localComputeFn: customComputeFn,
        });

        const ref = orchestrator.computeLocalReference(
            new Float32Array([1.0, 2.0]),
            0, 2, // 3 layers
        );

        // 3 layers of doubling: 1.0 → 2.0 → 4.0 → 8.0
        expect(ref[0]).toBeCloseTo(8.0, 4);
        expect(ref[1]).toBeCloseTo(16.0, 4);
    });
});
