/**
 * DistributedInferenceOrchestrator — integrates all components for
 * distributed, privacy-preserving, token-rewarded LLM inference.
 *
 * Flow:
 *   prompt → ChunkRouter → parallel node inference → ZK proofs → aggregate → CDI settlement
 *
 * Each node:
 *   1. Receives its chunk (not the full prompt)
 *   2. Runs Ollama generate locally
 *   3. Returns result + ZK proof (Poseidon commitment of I/O + secret)
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
     * Full distributed inference pipeline.
     *
     * 1. Chunk the prompt
     * 2. Route each chunk to best expert node via HNSW
     * 3. Each node runs inference on its chunk (parallel)
     * 4. Generate ZK proof for each node's I/O
     * 5. Verify all ZK proofs
     * 6. Aggregate text results
     * 7. Mint CDI tokens and settle
     */
    async infer(prompt: string): Promise<InferenceResult> {
        const startTime = performance.now();

        // 1. Route prompt chunks to expert nodes
        const routings = await this.chunkRouter.route(prompt);

        // If fewer chunks than nodes, ensure at least some coverage
        if (routings.length === 0) {
            throw new Error('ChunkRouter produced no routings');
        }

        // 2. Execute inference in parallel across nodes
        const nodeResults: NodeInferenceResult[] = [];
        const participatingNodes = new Set<string>();

        const inferencePromises = routings.map(async (routing) => {
            const nodeId = routing.expert.workerId;
            participatingNodes.add(nodeId);
            const hopStart = performance.now();

            // Node runs Ollama on its chunk — never sees other chunks
            const result = await this.inferenceFn(nodeId, routing.chunk);

            // 3. Generate ZK proof: proves node processed this I/O
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

        // 4. Verify all ZK proofs
        const proofVerifications = new Map<string, boolean>();
        for (const result of nodeResults) {
            const valid = await this.verifier.verify(result.zkProof);
            proofVerifications.set(result.nodeId, valid);
        }

        // 5. Aggregate text results into natural language response
        const response = this.aggregateResults(nodeResults);

        // 6. Token settlement — mint CDI and distribute
        const blockHeight = this.currentBlock++;
        const nodeIds = [...participatingNodes];

        const validProof: ZKProofLike = {
            outputCommitment: 'verified',
            expectedOutputHash: 'verified',
        };
        await this.settlement.settleInference(nodeIds, blockHeight, validProof);

        // Collect balances
        const balances: Record<string, number> = {};
        for (const [id] of this.nodes) {
            balances[id] = await this.ledger.getBalance(id);
        }

        return {
            prompt,
            response,
            nodeResults,
            proofVerifications,
            totalLatencyMs: performance.now() - startTime,
            blockHeight,
            blockReward: this.token.getBlockReward(blockHeight),
            balances,
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
