/**
 * ZkInferenceProver — Generates Groth16 ZK proofs for inference ownership.
 *
 * Supports two backends:
 *   - 'snarkjs' (default): pure JS, ~550ms — always available
 *   - 'rapidsnark': C++ native binary, ~15ms — requires bin/rapidsnark
 *
 * Both backends produce identical public signals and proofs that are
 * verifiable by the same snarkjs Groth16 verifier.
 *
 * The prover demonstrates knowledge of (inputHash, outputHash, workerSecret)
 * such that Poseidon(inputHash, outputHash, workerSecret) = commitment,
 * without revealing any private inputs.
 */
import * as snarkjs from 'snarkjs';
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import os from 'os';

const BUILD_DIR = path.resolve(process.cwd(), 'build/circuits');

export interface ZkProof {
    proof: snarkjs.Groth16Proof;
    publicSignals: string[];
}

export interface ProverConfig {
    wasmPath?: string;
    zkeyPath?: string;
    backend?: 'snarkjs' | 'rapidsnark';
    rapidsnarkBin?: string;
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
    private readonly backend: 'snarkjs' | 'rapidsnark';
    private readonly rapidsnarkBin: string;

    constructor(config: ProverConfig = {}) {
        this.wasmPath = config.wasmPath ?? path.join(BUILD_DIR, 'InferenceProof_js', 'InferenceProof.wasm');
        this.zkeyPath = config.zkeyPath ?? path.join(BUILD_DIR, 'InferenceProof_final.zkey');
        this.backend = config.backend ?? 'snarkjs';
        this.rapidsnarkBin = config.rapidsnarkBin ?? path.resolve(process.cwd(), 'bin/rapidsnark');
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

        // Try rapidsnark if configured, fallback to snarkjs
        if (this.backend === 'rapidsnark') {
            try {
                return await this.proveWithRapidsnark(circuitInput);
            } catch (e) {
                // Graceful fallback to snarkjs
                const msg = e instanceof Error ? e.message : String(e);
                if (process.env.LOG_LEVEL === 'debug') {
                    console.debug(`[ZkProver] rapidsnark failed (${msg}), falling back to snarkjs`);
                }
                return this.proveWithSnarkjs(circuitInput);
            }
        }

        return this.proveWithSnarkjs(circuitInput);
    }

    /**
     * Proof via snarkjs (pure JS). ~550ms but always available.
     */
    private async proveWithSnarkjs(circuitInput: Record<string, string>): Promise<ZkProof> {
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(
            circuitInput,
            this.wasmPath,
            this.zkeyPath,
        );
        return { proof, publicSignals };
    }

    /**
     * Proof via rapidsnark C++ binary. ~15ms.
     *
     * 1. Calculate witness using snarkjs WASM (fast, ~10ms)
     * 2. Write witness to temp .wtns file
     * 3. Spawn rapidsnark binary with zkey + witness
     * 4. Read proof.json + public.json from temp files
     */
    private async proveWithRapidsnark(circuitInput: Record<string, string>): Promise<ZkProof> {
        // Verify binary exists
        if (!existsSync(this.rapidsnarkBin)) {
            throw new Error(`rapidsnark binary not found at ${this.rapidsnarkBin}`);
        }

        // Create temp directory for this proof
        const tmpDir = path.join(os.tmpdir(), `zkproof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        mkdirSync(tmpDir, { recursive: true });

        const witnessPath = path.join(tmpDir, 'witness.wtns');
        const proofPath = path.join(tmpDir, 'proof.json');
        const publicPath = path.join(tmpDir, 'public.json');

        try {
            // 1. Calculate witness using snarkjs WASM (fast, ~10ms)
            // @ts-expect-error — snarkjs.wtns exists at runtime but lacks TS declarations
            await snarkjs.wtns.calculate(
                circuitInput,
                this.wasmPath,
                witnessPath,
            );

            // 3. Run rapidsnark (C++ binary)
            execFileSync(this.rapidsnarkBin, [
                this.zkeyPath,
                witnessPath,
                proofPath,
                publicPath,
            ], {
                timeout: 30_000,
                stdio: 'pipe',
            });

            // 4. Read results
            const proof = JSON.parse(readFileSync(proofPath, 'utf-8'));
            const publicSignals = JSON.parse(readFileSync(publicPath, 'utf-8'));

            return { proof, publicSignals };
        } finally {
            // Cleanup temp files
            try {
                if (existsSync(witnessPath)) unlinkSync(witnessPath);
                if (existsSync(proofPath)) unlinkSync(proofPath);
                if (existsSync(publicPath)) unlinkSync(publicPath);
                // rmdir silently (might fail if not empty)
                try { require('fs').rmdirSync(tmpDir); } catch { /* ok */ }
            } catch { /* cleanup is best-effort */ }
        }
    }
}
