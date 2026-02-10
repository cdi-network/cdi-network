/**
 * ZkInferenceVerifier — Verifies Groth16 ZK proofs of inference ownership.
 *
 * The verifier checks that a proof is valid against the verification key,
 * confirming the prover knew the private inputs without learning them.
 */
import * as snarkjs from 'snarkjs';
import { readFileSync } from 'fs';
import path from 'path';
import type { ZkProof } from './ZkInferenceProver.js';

const BUILD_DIR = path.resolve(process.cwd(), 'build/circuits');

export interface VerifierConfig {
    vkeyPath?: string;
}

export class ZkInferenceVerifier {
    private vkey: any;

    constructor(config: VerifierConfig = {}) {
        const vkeyPath = config.vkeyPath ?? path.join(BUILD_DIR, 'verification_key.json');
        this.vkey = JSON.parse(readFileSync(vkeyPath, 'utf-8'));
    }

    /**
     * Verify a Groth16 proof of inference ownership.
     *
     * @param zkProof - The proof + public signals to verify
     * @returns true if the proof is valid, false otherwise
     */
    async verify(zkProof: ZkProof): Promise<boolean> {
        return snarkjs.groth16.verify(this.vkey, zkProof.publicSignals, zkProof.proof);
    }

    /**
     * Get the commitment (public signal) from a proof.
     * This is the Poseidon hash that was published for verification.
     */
    getCommitment(zkProof: ZkProof): string {
        return zkProof.publicSignals[0];
    }
}
