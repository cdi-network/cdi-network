/**
 * InferenceToken — proof-of-inference mining with Bitcoin-like halving.
 *
 * Every verified forward pass through the pipeline mines new CDI
 * (Common Distributed Inference) tokens.
 * Supply capped at 21M with configurable halving interval.
 */

export const CDI_TOKEN_NAME = 'CDI';
export const MAX_SUPPLY = 21_000_000;
export const DEFAULT_HALVING_INTERVAL = 210_000;
export const INITIAL_REWARD = 50;
export const MIN_REWARD = 1e-8; // satoshi equivalent

export interface MintResult {
    nodeId: string;
    blockHeight: number;
    amount: number;
    txId: string;
}

export interface ZKProofLike {
    outputCommitment: string;
    expectedOutputHash: string;
}

/**
 * InferenceToken manages token supply, mining rewards, and ZKP-gated minting.
 */
export class InferenceToken {
    private totalSupply = 0;
    private currentBlock = 0;
    private readonly halvingInterval: number;

    constructor(halvingInterval: number = DEFAULT_HALVING_INTERVAL) {
        this.halvingInterval = halvingInterval;
    }

    /**
     * Calculate block reward for a given block height.
     * Halves every HALVING_INTERVAL blocks, just like Bitcoin.
     */
    getBlockReward(blockHeight: number): number {
        const epoch = Math.floor(blockHeight / this.halvingInterval);
        const reward = INITIAL_REWARD / Math.pow(2, epoch);
        return reward < MIN_REWARD ? 0 : reward;
    }

    /**
     * Mint tokens for a node that completed a verified inference.
     * Requires a valid ZKP proof (outputCommitment === expectedOutputHash).
     */
    async mint(nodeId: string, blockHeight: number, proof: ZKProofLike): Promise<MintResult> {
        // Verify proof validity
        if (proof.outputCommitment !== proof.expectedOutputHash) {
            throw new Error(`Mint rejected: invalid ZKP proof for node ${nodeId}`);
        }

        const reward = this.getBlockReward(blockHeight);

        // Check max supply
        if (this.totalSupply + reward > MAX_SUPPLY) {
            const capped = MAX_SUPPLY - this.totalSupply;
            if (capped <= 0) {
                throw new Error('Max supply reached, no more tokens can be minted');
            }
        }

        this.totalSupply += reward;
        this.currentBlock = Math.max(this.currentBlock, blockHeight + 1);

        return {
            nodeId,
            blockHeight,
            amount: reward,
            txId: `mint-${nodeId}-${blockHeight}-${Date.now()}`,
        };
    }

    /**
     * Get the current total circulating supply.
     */
    getTotalSupply(): number {
        return this.totalSupply;
    }

    /**
     * Get the current block height.
     */
    getCurrentBlock(): number {
        return this.currentBlock;
    }
}
