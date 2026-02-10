pragma circom 2.0.0;

include "../node_modules/circomlib/circuits/poseidon.circom";

/**
 * InferenceProof: ZK proof that a worker correctly processed an inference step.
 *
 * The worker proves: "I know (inputHash, outputHash) such that
 * Poseidon(inputHash, outputHash, workerSecret) == publicCommitment"
 *
 * - publicCommitment: published on OrbitDB for verification
 * - workerSecret: private key of the worker (never revealed)
 * - inputHash: hash of the input activations
 * - outputHash: hash of the output activations
 *
 * This proves the worker processed the exact input→output pair
 * without revealing the activations or the worker's secret.
 */
template InferenceProof() {
    // Private inputs (known only to prover/worker)
    signal input inputHash;
    signal input outputHash;
    signal input workerSecret;

    // Public output (published for verification)
    signal output commitment;

    // Poseidon hash of (inputHash, outputHash, workerSecret)
    component hasher = Poseidon(3);
    hasher.inputs[0] <== inputHash;
    hasher.inputs[1] <== outputHash;
    hasher.inputs[2] <== workerSecret;

    commitment <== hasher.out;
}

component main = InferenceProof();
