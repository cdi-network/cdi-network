/**
 * R-1: ZK-SNARK Inference Proof — TDD Tests
 *
 * Tests the end-to-end ZK proof pipeline:
 * 1. hashActivations produces consistent BigInt hashes
 * 2. Prover generates valid Groth16 proof
 * 3. Verifier accepts valid proof
 * 4. Verifier rejects tampered proof
 * 5. Different inputs produce different commitments
 */
import { ZkInferenceProver, hashActivations } from '../../src/crypto/ZkInferenceProver.js';
import { ZkInferenceVerifier } from '../../src/crypto/ZkInferenceVerifier.js';

describe('R-1: ZK-SNARK Inference Proof', () => {
    let prover: ZkInferenceProver;
    let verifier: ZkInferenceVerifier;

    beforeAll(() => {
        prover = new ZkInferenceProver();
        verifier = new ZkInferenceVerifier();
    });

    test('hashActivations produces deterministic BigInt', () => {
        const data = new Float32Array([1.0, 2.0, 3.0]);
        const h1 = hashActivations(data);
        const h2 = hashActivations(data);
        expect(h1).toBe(h2);
        expect(typeof h1).toBe('bigint');
        expect(h1 > 0n).toBe(true);
    });

    test('hashActivations produces different hashes for different inputs', () => {
        const a = new Float32Array([1.0, 2.0, 3.0]);
        const b = new Float32Array([4.0, 5.0, 6.0]);
        expect(hashActivations(a)).not.toBe(hashActivations(b));
    });

    test('prover generates valid Groth16 proof', async () => {
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = new Float32Array([0.5, 0.6, 0.7]);
        const workerSecret = 12345n;

        const zkProof = await prover.prove(input, output, workerSecret);

        expect(zkProof.proof).toBeDefined();
        expect(zkProof.proof.pi_a).toBeDefined();
        expect(zkProof.proof.pi_b).toBeDefined();
        expect(zkProof.proof.pi_c).toBeDefined();
        expect(zkProof.publicSignals).toHaveLength(1); // commitment
    }, 30000);

    test('verifier accepts valid proof', async () => {
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = new Float32Array([0.5, 0.6, 0.7]);
        const workerSecret = 42n;

        const zkProof = await prover.prove(input, output, workerSecret);
        const isValid = await verifier.verify(zkProof);

        expect(isValid).toBe(true);
    }, 30000);

    test('verifier rejects tampered proof', async () => {
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = new Float32Array([0.5, 0.6, 0.7]);
        const workerSecret = 99n;

        const zkProof = await prover.prove(input, output, workerSecret);

        // Tamper with the commitment (public signal)
        const tampered = {
            ...zkProof,
            publicSignals: ['999999999999999999'],
        };

        const isValid = await verifier.verify(tampered);
        expect(isValid).toBe(false);
    }, 30000);

    test('different inputs produce different commitments', async () => {
        const workerSecret = 77n;

        const proof1 = await prover.prove(
            new Float32Array([1.0]),
            new Float32Array([2.0]),
            workerSecret,
        );
        const proof2 = await prover.prove(
            new Float32Array([3.0]),
            new Float32Array([4.0]),
            workerSecret,
        );

        const c1 = verifier.getCommitment(proof1);
        const c2 = verifier.getCommitment(proof2);

        expect(c1).not.toBe(c2);
        expect(await verifier.verify(proof1)).toBe(true);
        expect(await verifier.verify(proof2)).toBe(true);
    }, 60000);

    test('same inputs with different secrets produce different commitments', async () => {
        const input = new Float32Array([1.0, 2.0]);
        const output = new Float32Array([3.0, 4.0]);

        const proof1 = await prover.prove(input, output, 111n);
        const proof2 = await prover.prove(input, output, 222n);

        expect(verifier.getCommitment(proof1)).not.toBe(verifier.getCommitment(proof2));
    }, 30000);
});
