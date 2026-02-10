/**
 * ZkInferenceProver — Generates Groth16 ZK proofs for inference ownership.
 *
 * The prover demonstrates knowledge of (inputHash, outputHash, workerSecret)
 * such that Poseidon(inputHash, outputHash, workerSecret) = commitment,
 * without revealing any private inputs.
 */
import * as snarkjs from 'snarkjs';
import { createHash } from 'crypto';
import path from 'path';

const BUILD_DIR = path.resolve(process.cwd(), 'build/circuits');

export interface ZkProof {
    proof: snarkjs.Groth16Proof;
    publicSignals: string[];
}

export interface ProverConfig {
    wasmPath?: string;
    zkeyPath?: string;
}

/**
 * Hash a Float32Array to a BigInt suitable for Poseidon circuit input.
 * Uses SHA-256, truncated to 253 bits (BN128 field size).
 */
export function hashActivations(data: Float32Array): bigint {
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const hash = createHash('sha256').update(buf).digest();
    // Truncate to 253 bits: BN128 field is ~254 bits, Poseidon needs < field prime
    hash[0] &= 0x1f; // Clear top 3 bits → 253-bit value
    return BigInt('0x' + hash.toString('hex'));
}

export class ZkInferenceProver {
    private readonly wasmPath: string;
    private readonly zkeyPath: string;

    constructor(config: ProverConfig = {}) {
        this.wasmPath = config.wasmPath ?? path.join(BUILD_DIR, 'InferenceProof_js', 'InferenceProof.wasm');
        this.zkeyPath = config.zkeyPath ?? path.join(BUILD_DIR, 'InferenceProof_final.zkey');
    }

    /**
     * Generate a Groth16 proof of inference ownership.
     *
     * @param input - The input activations processed by the worker
     * @param output - The output activations produced by the worker
     * @param workerSecret - The worker's private secret (bigint or number)
     * @returns ZkProof containing the proof and public signals (commitment)
     */
    async prove(input: Float32Array, output: Float32Array, workerSecret: bigint): Promise<ZkProof> {
        const inputHash = hashActivations(input);
        const outputHash = hashActivations(output);

        const circuitInput = {
            inputHash: inputHash.toString(),
            outputHash: outputHash.toString(),
            workerSecret: workerSecret.toString(),
        };

        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInput,
            this.wasmPath,
            this.zkeyPath,
        );

        return { proof, publicSignals };
    }
}
