/**
 * WS-P3b: ZKP TDD Tests
 *
 * Validates zero-knowledge proof generation and verification for linear layers:
 * 1. Should generate valid proof for correct computation
 * 2. Should reject proof for incorrect computation
 * 3. Proof should not leak input values (public signals contain only commitment)
 * 4. Should handle small matrix (4x4)
 *
 * NOTE: We use a simplified hash-based commitment scheme instead of full Circom
 * for the PoC. The mathematical guarantee is: the prover commits to input/output
 * hashes and proves knowledge of the preimage. Full SNARK circuits would replace
 * this for production.
 */
import { ZKPProver, ZKPVerifier } from '../../src/pipeline/ZKPProver.js';

describe('WS-P3b: ZKP Inference Verification', () => {

    test('should generate valid proof for correct computation', async () => {
        const prover = new ZKPProver();
        const verifier = new ZKPVerifier();

        const input = new Float32Array([1.0, 2.0]);
        const weights = new Float32Array([3.0, 4.0, 5.0, 6.0]); // 2x2
        // output = W·x = [1*3+2*4, 1*5+2*6] = [11, 17]
        const output = new Float32Array([11.0, 17.0]);

        const proof = await prover.generateProof(input, output, weights, 2, 2);
        const isValid = await verifier.verifyProof(proof);

        expect(isValid).toBe(true);
    });

    test('should reject proof for incorrect computation', async () => {
        const prover = new ZKPProver();
        const verifier = new ZKPVerifier();

        const input = new Float32Array([1.0, 2.0]);
        const weights = new Float32Array([3.0, 4.0, 5.0, 6.0]);
        // WRONG output (should be [11, 17])
        const wrongOutput = new Float32Array([99.0, 99.0]);

        const proof = await prover.generateProof(input, wrongOutput, weights, 2, 2);
        const isValid = await verifier.verifyProof(proof);

        expect(isValid).toBe(false);
    });

    test('proof should not leak input values', async () => {
        const prover = new ZKPProver();
        const input = new Float32Array([42.0, 99.0]);
        const weights = new Float32Array([1, 0, 0, 1]); // identity
        const output = new Float32Array([42.0, 99.0]);

        const proof = await prover.generateProof(input, output, weights, 2, 2);

        // Public signals should contain ONLY commitments (hashes), not raw values
        expect(proof.publicSignals).toBeDefined();
        // Public signals should only contain hash strings (64-char hex)
        const signals = proof.publicSignals;
        expect(signals.inputCommitment).toMatch(/^[0-9a-f]{64}$/);
        expect(signals.outputCommitment).toMatch(/^[0-9a-f]{64}$/);
        expect(signals.weightsCommitment).toMatch(/^[0-9a-f]{64}$/);

        // The raw float binary data should NOT appear encoded in the public signals
        const inputBuf = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('hex');
        const publicStr = JSON.stringify(proof.publicSignals);
        expect(publicStr).not.toContain(inputBuf);
    });

    test('should handle small matrix (4x4)', async () => {
        const prover = new ZKPProver();
        const verifier = new ZKPVerifier();

        // 4x4 identity-like matrix
        const input = new Float32Array([1, 2, 3, 4]);
        const weights = new Float32Array([
            2, 0, 0, 0,
            0, 2, 0, 0,
            0, 0, 2, 0,
            0, 0, 0, 2,
        ]); // 2 * identity
        const output = new Float32Array([2, 4, 6, 8]);

        const proof = await prover.generateProof(input, output, weights, 4, 4);
        const isValid = await verifier.verifyProof(proof);

        expect(isValid).toBe(true);
    });
});
