import type { InferenceToken, ZKProofLike } from './InferenceToken.js';
import type { TokenLedger } from './TokenLedger.js';

/**
 * TokenSettlement — handles the economic settlement of pipeline inference.
 *
 * Flow:
 * 1. Before inference: escrow tokens from requester
 * 2. After verified inference: mint reward + distribute payment proportionally
 * 3. On failure: refund escrowed tokens
 */
export class TokenSettlement {
    constructor(
        private readonly token: InferenceToken,
        private readonly ledger: TokenLedger,
    ) { }

    /**
     * Settle a successful inference: mint reward and distribute to nodes.
     */
    async settleInference(
        nodeIds: string[],
        blockHeight: number,
        proof: ZKProofLike,
    ): Promise<void> {
        // Mint the block reward
        const mintResult = await this.token.mint(nodeIds[0], blockHeight, proof);
        const rewardPerNode = mintResult.amount / nodeIds.length;

        // Distribute reward proportionally to all pipeline nodes
        for (const nodeId of nodeIds) {
            await this.ledger.credit(nodeId, rewardPerNode, 'mine', {
                blockHeight,
                txId: mintResult.txId,
            });
        }
    }

    /**
     * Refund escrowed tokens to requester on failed inference.
     */
    async refund(
        requesterId: string,
        amount: number,
        inferenceId: string,
    ): Promise<void> {
        await this.ledger.credit(requesterId, amount, 'refund', {
            inferenceId,
            reason: 'inference_failed',
        });
    }
}
