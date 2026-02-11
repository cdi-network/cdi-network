/**
 * ProofAggregator — ZKP commitment verification for inference pipelines.
 *
 * Collects activation commitments from pipeline stages,
 * verifies consistency, and produces a pipeline proof.
 *
 * @module browser/security/ProofAggregator
 */

import { createHash } from '../crypto-browser.js';

/**
 * @typedef {Object} StageCommitment
 * @property {string} nodeId
 * @property {string} shardId
 * @property {string} inputHash
 * @property {string} outputHash
 * @property {number} timestamp
 */

export class ProofAggregator {
    /** @type {Map<string, StageCommitment[]>} pipelineId → commitments */
    #pipelines = new Map();
    /** @type {number} */
    #totalVerified = 0;
    /** @type {number} */
    #totalFailed = 0;

    constructor() { }

    /**
     * Submit a stage commitment for a pipeline.
     * @param {string} pipelineId
     * @param {StageCommitment} commitment
     */
    addCommitment(pipelineId, commitment) {
        if (!commitment.nodeId || !commitment.outputHash) {
            throw new Error('Commitment requires nodeId and outputHash');
        }
        if (!this.#pipelines.has(pipelineId)) {
            this.#pipelines.set(pipelineId, []);
        }
        this.#pipelines.get(pipelineId).push({
            timestamp: Date.now(),
            ...commitment,
        });
    }

    /**
     * Verify pipeline commitment chain (each stage's output = next stage's input).
     * @param {string} pipelineId
     * @returns {{ valid: boolean, stages: number, errors: string[] }}
     */
    verifyPipeline(pipelineId) {
        const commits = this.#pipelines.get(pipelineId);
        if (!commits || commits.length === 0) {
            return { valid: false, stages: 0, errors: ['No commitments found'] };
        }

        const errors = [];

        // Check chain: stage[i].outputHash should match stage[i+1].inputHash
        for (let i = 0; i < commits.length - 1; i++) {
            if (commits[i].outputHash !== commits[i + 1].inputHash) {
                errors.push(
                    `Chain break: stage ${i} output (${commits[i].outputHash.slice(0, 8)}...) ≠ stage ${i + 1} input (${commits[i + 1].inputHash.slice(0, 8)}...)`
                );
            }
        }

        const valid = errors.length === 0;
        if (valid) this.#totalVerified++;
        else this.#totalFailed++;

        return { valid, stages: commits.length, errors };
    }

    /**
     * Generate a pipeline proof (aggregate commitment).
     * @param {string} pipelineId
     * @returns {{ proofHash: string, stageCount: number, nodeIds: string[] }|null}
     */
    generateProof(pipelineId) {
        const commits = this.#pipelines.get(pipelineId);
        if (!commits || commits.length === 0) return null;

        const combined = commits.map(c => `${c.nodeId}:${c.outputHash}`).join('|');
        const proofHash = createHash('sha256').update(combined).digest('hex');

        return {
            proofHash,
            stageCount: commits.length,
            nodeIds: commits.map(c => c.nodeId),
        };
    }

    /**
     * Get all commitments for a pipeline.
     * @param {string} pipelineId
     * @returns {StageCommitment[]}
     */
    getCommitments(pipelineId) {
        return this.#pipelines.get(pipelineId) || [];
    }

    /** @returns {number} */
    get totalVerified() { return this.#totalVerified; }
    /** @returns {number} */
    get totalFailed() { return this.#totalFailed; }
    /** @returns {number} */
    get pipelineCount() { return this.#pipelines.size; }
}
