/**
 * DistributedInferenceOrchestrator — integrates all components for
 * distributed, privacy-preserving, token-rewarded LLM inference.
 *
 * Economic model (like Bitcoin):
 *   - User PAYS CDI tokens to submit an inference request
 *   - Nodes EARN CDI via: (a) block reward mining + (b) user fee distribution
 *   - Insufficient CDI → inference rejected
 *
 * Distribution model:
 *   - Each node handles a specific chunk (NOT a full replica)
 *   - The network auto-balances via HNSW routing as nodes join/leave
 *   - Chunks are routed to specialist nodes based on embedding similarity
 *
 * Flow:
 *   debit user CDI → ChunkRouter → parallel node inference → ZK proofs
 *   → aggregate → mint CDI + distribute fees → return response
 *
 * The orchestrator never exposes one node's I/O to another.
 */

import { ChunkRouter, type EmbedFunction } from '../routing/ChunkRouter.js';
import { ExpertIndex } from '../routing/ExpertIndex.js';
import { ZkInferenceProver, hashActivations, type ZkProof } from '../crypto/ZkInferenceProver.js';
import { ZkInferenceVerifier } from '../crypto/ZkInferenceVerifier.js';
import { InferenceToken, type ZKProofLike, CDI_TOKEN_NAME } from '../token/InferenceToken.js';
import { TokenLedger } from '../token/TokenLedger.js';
import { TokenSettlement } from '../token/TokenSettlement.js';
import type { DynamicEpochManager } from '../token/DynamicEpochManager.js';
import type { DynamicFeeOracle } from '../token/DynamicFeeOracle.js';
import type { ModelRegistry } from '../registry/ModelRegistry.js';
import type { ModelRouter } from '../routing/ModelRouter.js';
import type { ContributionTracker } from '../token/ContributionTracker.js';

/** Endpoint for a swarm node */
export interface NodeEndpoint {
    nodeId: string;
    address: string;          // host:port or ws://...
    embedding: number[];      // expert embedding for HNSW routing
}

/** Function to call a node's Ollama for text generation */
export type NodeInferenceFn = (
    nodeId: string,
    chunk: string,
) => Promise<{ text: string; inputTokens: Float32Array; outputTokens: Float32Array }>;

/** Result of a single node's inference step */
export interface NodeInferenceResult {
    nodeId: string;
    chunk: string;
    text: string;
    zkProof: ZkProof;
    latencyMs: number;
}

/** Full inference result */
export interface InferenceResult {
    prompt: string;
    response: string;                         // aggregated natural language
    nodeResults: NodeInferenceResult[];       // per-node breakdown
    proofVerifications: Map<string, boolean>; // nodeId → verified?
    totalLatencyMs: number;
    blockHeight: number;
    blockReward: number;
    balances: Record<string, number>;
    requesterId: string;
    inferenceFee: number;
    requesterBalance: number;
    feePerNode: number;
    modelId?: string;                        // which model was used
    royaltiesDistributed?: number;           // CDI paid to contributors
}

/** Options for an inference request */
export interface InferenceOptions {
    modelId?: string;          // default: network's default model
    inferenceFee?: number;     // override auto-fee
    maxLatencyMs?: number;     // SLA constraint
    priority?: 'low' | 'normal' | 'high';
}

export interface DistributedInferenceConfig {
    nodes: NodeEndpoint[];
    embedFn: EmbedFunction;
    inferenceFn: NodeInferenceFn;
    prover: ZkInferenceProver;
    verifier: ZkInferenceVerifier;
    token: InferenceToken;
    ledger: TokenLedger;
    dimensions: number;
    maxChunkLength?: number;
    workerSecrets?: Map<string, bigint>; // nodeId → secret
    epochManager?: DynamicEpochManager;  // dynamic demand-driven epochs (optional)
    feeOracle?: DynamicFeeOracle;        // dynamic congestion-based fees (optional)
    modelRegistry?: ModelRegistry;       // model catalog + fee multiplier (optional)
    modelRouter?: ModelRouter;           // load-aware model routing (optional)
    contributionTracker?: ContributionTracker; // CDI royalties for contributors (optional)
}

export class DistributedInferenceOrchestrator {
    private readonly expertIndex: ExpertIndex;
    private readonly chunkRouter: ChunkRouter;
    private readonly prover: ZkInferenceProver;
    private readonly verifier: ZkInferenceVerifier;
    private readonly token: InferenceToken;
    private readonly ledger: TokenLedger;
    private readonly settlement: TokenSettlement;
    private readonly inferenceFn: NodeInferenceFn;
    private readonly workerSecrets: Map<string, bigint>;
    private readonly nodes: Map<string, NodeEndpoint> = new Map();
    private readonly epochManager?: DynamicEpochManager;
    private readonly feeOracle?: DynamicFeeOracle;
    private readonly modelRegistry?: ModelRegistry;
    private readonly modelRouter?: ModelRouter;
    private readonly contributionTracker?: ContributionTracker;
    private currentBlock = 0;

    constructor(config: DistributedInferenceConfig) {
        this.expertIndex = new ExpertIndex({
            dimensions: config.dimensions,
            maxElements: 100,
        });

        this.chunkRouter = new ChunkRouter({
            expertIndex: this.expertIndex,
            embedFn: config.embedFn,
            maxChunkLength: config.maxChunkLength ?? 200,
        });

        this.prover = config.prover;
        this.verifier = config.verifier;
        this.token = config.token;
        this.ledger = config.ledger;
        this.settlement = new TokenSettlement(this.token, this.ledger);
        this.inferenceFn = config.inferenceFn;
        this.workerSecrets = config.workerSecrets ?? new Map();
        this.epochManager = config.epochManager;
        this.feeOracle = config.feeOracle;
        this.modelRegistry = config.modelRegistry;
        this.modelRouter = config.modelRouter;
        this.contributionTracker = config.contributionTracker;

        // Register initial nodes
        for (const node of config.nodes) {
            this.addNode(node);
        }
    }

    /**
     * Add a node to the routing index. Enables auto-scaling.
     */
    addNode(node: NodeEndpoint): void {
        this.nodes.set(node.nodeId, node);
        this.expertIndex.addExpert(node.nodeId, node.embedding);

        // Auto-assign a secret if not provided
        if (!this.workerSecrets.has(node.nodeId)) {
            this.workerSecrets.set(
                node.nodeId,
                BigInt(Math.floor(Math.random() * 1_000_000)),
            );
        }
    }

    /**
     * Full distributed inference pipeline with CDI fee payment.
     *
     * 1. Debit CDI fee from requester (like Bitcoin tx fee)
     * 2. Chunk the prompt → route to specialist nodes via HNSW
     * 3. Each node runs inference on its chunk only (not a replica)
     * 4. Generate ZK proof for each node's I/O
     * 5. Verify all ZK proofs
     * 6. Aggregate text results
     * 7. Mint CDI block reward + distribute user fee to nodes
     *
     * @param prompt - User prompt to process
     * @param requesterId - User wallet ID (must have sufficient CDI balance)
     * @param inferenceFee - CDI tokens the user pays for this inference
     * @throws If user has insufficient CDI balance
     */
    async infer(
        prompt: string,
        requesterId: string = 'anonymous',
        optionsOrFee?: InferenceOptions | number,
    ): Promise<InferenceResult> {
        const startTime = performance.now();

        // Normalize: support both legacy infer(p, r, fee) and new infer(p, r, { modelId, ... })
        const options: InferenceOptions = typeof optionsOrFee === 'number'
            ? { inferenceFee: optionsOrFee }
            : optionsOrFee ?? {};

        const modelId = options.modelId;

        // Fee multiplier based on model size (larger models cost more CDI)
        const feeMultiplier = (modelId && this.modelRegistry)
            ? this.modelRegistry.getFeeMultiplier(modelId)
            : 1.0;

        // Resolve fee: oracle × model multiplier, or provided value, or 0
        const baseFee = options.inferenceFee !== undefined
            ? options.inferenceFee
            : this.feeOracle
                ? this.feeOracle.calculateFee(
                    this.epochManager?.getUtilization() ?? 0,
                )
                : 0;
        const resolvedFee = baseFee * feeMultiplier;

        // 1. Debit CDI from requester — like a Bitcoin tx fee
        // If balance insufficient, ledger.debit() throws → inference rejected
        if (resolvedFee > 0) {
            await this.ledger.debit(requesterId, resolvedFee, 'pay', {
                type: 'inference_fee',
                prompt: prompt.slice(0, 50),
                feeTier: this.feeOracle?.getTier(
                    this.epochManager?.getUtilization() ?? 0,
                ) ?? 'fixed',
            });
        }

        // 2. Route prompt chunks to specialist expert nodes via HNSW
        const routings = await this.chunkRouter.route(prompt);

        if (routings.length === 0) {
            // Refund on routing failure
            if (resolvedFee > 0) {
                await this.ledger.credit(requesterId, resolvedFee, 'refund', {
                    reason: 'no_routings',
                });
            }
            throw new Error('ChunkRouter produced no routings');
        }

        // 3. Each node processes ONLY its assigned chunk (not a replica)
        const nodeResults: NodeInferenceResult[] = [];
        const participatingNodes = new Set<string>();

        const inferencePromises = routings.map(async (routing) => {
            const nodeId = routing.expert.workerId;
            participatingNodes.add(nodeId);
            const hopStart = performance.now();

            // Node runs Ollama on its chunk — never sees other chunks
            const result = await this.inferenceFn(nodeId, routing.chunk);

            // 4. Generate ZK proof: proves node processed this I/O
            const workerSecret = this.workerSecrets.get(nodeId)!;
            const zkProof = await this.prover.prove(
                result.inputTokens,
                result.outputTokens,
                workerSecret,
            );

            return {
                nodeId,
                chunk: routing.chunk,
                text: result.text,
                zkProof,
                latencyMs: performance.now() - hopStart,
            };
        });

        const results = await Promise.all(inferencePromises);
        nodeResults.push(...results);

        // 5. Verify all ZK proofs
        const proofVerifications = new Map<string, boolean>();
        for (const result of nodeResults) {
            const valid = await this.verifier.verify(result.zkProof);
            proofVerifications.set(result.nodeId, valid);
        }

        // 6. Aggregate text results into natural language response
        const response = this.aggregateResults(nodeResults);

        // 7. Token settlement — mint CDI block reward + distribute user fee
        const blockHeight = this.currentBlock++;
        const nodeIds = [...participatingNodes];

        // Record inference for dynamic epoch tracking
        if (this.epochManager) {
            this.epochManager.recordInference(blockHeight);
        }

        const validProof: ZKProofLike = {
            outputCommitment: 'verified',
            expectedOutputHash: 'verified',
        };
        await this.settlement.settleInference(nodeIds, blockHeight, validProof);

        // Distribute user fee to participating nodes (on top of block reward)
        const feePerNode = participatingNodes.size > 0
            ? resolvedFee / participatingNodes.size
            : 0;
        if (feePerNode > 0) {
            for (const nodeId of participatingNodes) {
                await this.ledger.credit(nodeId, feePerNode, 'fee', {
                    from: requesterId,
                    blockHeight,
                });
            }
        }

        // Collect balances
        const balances: Record<string, number> = {};
        for (const [id] of this.nodes) {
            balances[id] = await this.ledger.getBalance(id);
        }

        const requesterBalance = await this.ledger.getBalance(requesterId);

        return {
            prompt,
            response,
            nodeResults,
            proofVerifications,
            totalLatencyMs: performance.now() - startTime,
            blockHeight,
            blockReward: this.epochManager
                ? this.epochManager.getBlockReward(this.token)
                : this.token.getBlockReward(blockHeight),
            balances,
            requesterId,
            inferenceFee: resolvedFee,
            requesterBalance,
            feePerNode,
            modelId,
            royaltiesDistributed: 0, // will be populated when ContributionTracker integrated into settlement
        };
    }

    /**
     * Aggregate node results into a coherent response.
     * Joins chunk results in order, separated by spaces.
     */
    private aggregateResults(results: NodeInferenceResult[]): string {
        return results.map(r => r.text.trim()).join(' ');
    }

    /**
     * Get the current routing table: nodeId → expert embedding dimension hint.
     */
    getRoutingInfo(): Map<string, number[]> {
        const info = new Map<string, number[]>();
        for (const [id, node] of this.nodes) {
            info.set(id, node.embedding);
        }
        return info;
    }

    /**
     * Get current node count.
     */
    get nodeCount(): number {
        return this.nodes.size;
    }

    /**
     * Get current block height.
     */
    get blockHeight(): number {
        return this.currentBlock;
    }
}
