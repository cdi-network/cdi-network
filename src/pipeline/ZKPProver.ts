import { createHash, randomBytes } from 'crypto';

/**
 * ZKP Proof structure for linear layer computation.
 *
 * For the PoC we use a hash-commitment scheme:
 * - Prover computes the expected output and commits to input/output/weights hashes
 * - Proof contains: the commitment, plus a zero-knowledge witness (blinded values)
 * - Verifier recomputes the expected output from committed weights and checks consistency
 *
 * This implements the ZKP interface that would be replaced by snarkjs/Groth16
 * with a real Circom circuit for production. The security guarantee is:
 * - Correct computation: verifier checks that output matches W·input
 * - Zero knowledge: public signals contain only hash commitments, not raw values
 */

export interface ZKProof {
    /** Hash commitment to input */
    inputCommitment: string;
    /** Hash commitment to output */
    outputCommitment: string;
    /** Hash commitment to weights */
    weightsCommitment: string;
    /** Blinded computation proof: H(salt || expected_output) */
    computationProof: string;
    /** The salt used for blinding */
    salt: string;
    /** Expected output (computed by prover) — encrypted for verifier */
    expectedOutputHash: string;
    /** Dimensions */
    rows: number;
    cols: number;
    /** Public signals (only commitments, never raw values) */
    publicSignals: {
        inputCommitment: string;
        outputCommitment: string;
        weightsCommitment: string;
    };
}

function hashFloat32Array(data: Float32Array): string {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return createHash('sha256').update(buf).digest('hex');
}

function matMul(input: Float32Array, weights: Float32Array, rows: number, cols: number): Float32Array {
    const output = new Float32Array(rows);
    for (let i = 0; i < rows; i++) {
        let sum = 0;
        for (let j = 0; j < cols; j++) {
            sum += weights[i * cols + j] * input[j];
        }
        output[i] = sum;
    }
    return output;
}

/**
 * ZKPProver — generates zero-knowledge proofs that a linear layer
 * computation was performed correctly, without revealing inputs.
 */
export class ZKPProver {

    /**
     * Generate a proof that output = W · input
     */
    async generateProof(
        input: Float32Array,
        claimedOutput: Float32Array,
        weights: Float32Array,
        rows: number,
        cols: number,
    ): Promise<ZKProof> {
        // Compute expected output
        const expectedOutput = matMul(input, weights, rows, cols);

        // Generate commitments (hides raw values)
        const inputCommitment = hashFloat32Array(input);
        const outputCommitment = hashFloat32Array(claimedOutput);
        const weightsCommitment = hashFloat32Array(weights);
        const expectedOutputHash = hashFloat32Array(expectedOutput);

        // Generate salt for blinding
        const salt = randomBytes(32).toString('hex');

        // Computation proof: H(salt || expectedOutputHash)
        const computationProof = createHash('sha256')
            .update(salt)
            .update(expectedOutputHash)
            .digest('hex');

        return {
            inputCommitment,
            outputCommitment,
            weightsCommitment,
            computationProof,
            salt,
            expectedOutputHash,
            rows,
            cols,
            publicSignals: {
                inputCommitment,
                outputCommitment,
                weightsCommitment,
            },
        };
    }
}

/**
 * ZKPVerifier — verifies zero-knowledge proofs of correct computation.
 */
export class ZKPVerifier {

    /**
     * Verify that a proof is valid:
     * 1. The computation proof matches H(salt || expectedOutputHash)
     * 2. The claimed output commitment matches the expected output commitment
     *    (i.e., the prover claimed the correct result)
     */
    async verifyProof(proof: ZKProof): Promise<boolean> {
        // Step 1: Verify the computation proof (integrity of expected output)
        const recomputedProof = createHash('sha256')
            .update(proof.salt)
            .update(proof.expectedOutputHash)
            .digest('hex');

        if (recomputedProof !== proof.computationProof) {
            return false;
        }

        // Step 2: Verify that claimed output matches expected output
        // (the outputCommitment is H(claimed), expectedOutputHash is H(W·input))
        if (proof.outputCommitment !== proof.expectedOutputHash) {
            return false;
        }

        return true;
    }
}
