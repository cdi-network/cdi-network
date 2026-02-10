/**
 * TestOrchestrator — automated test harness for Docker swarm testing.
 *
 * Connects to N running PipelineNode containers, runs inference,
 * verifies results, and reports metrics + token settlement.
 */

import { ActivationRelayClient } from './ActivationRelay.js';
import { InferenceToken, type ZKProofLike } from '../token/InferenceToken.js';
import { TokenLedger } from '../token/TokenLedger.js';
import { TokenSettlement } from '../token/TokenSettlement.js';

export interface HopMetric {
    address: string;
    latencyMs: number;
}

export interface PipelineResult {
    output: Float32Array;
    metrics: {
        hops: HopMetric[];
        totalLatencyMs: number;
    };
}

export interface SettlementReport {
    blockReward: number;
    rewardPerNode: number;
    balances: Record<string, number>;
}

/**
 * Default compute function mirror — must match PipelineNode's default.
 */
function defaultLocalCompute(input: Float32Array, layerIdx: number): Float32Array {
    const scale = 1 + layerIdx * 0.01;
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * scale;
    }
    return output;
}

export class TestOrchestrator {
    private readonly client: ActivationRelayClient;
    private readonly token: InferenceToken;
    private readonly ledger: TokenLedger;
    private readonly settlement: TokenSettlement;

    constructor(hmacSecret: string, timeoutMs = 5000) {
        this.client = new ActivationRelayClient({ hmacSecret, timeoutMs });
        this.token = new InferenceToken();

        // In-memory mock store for testing
        const data = new Map<string, any>();
        const mockStore = {
            put: async (entry: any) => { data.set(entry._id, entry); },
            get: async (id: string) => data.get(id) ?? null,
            del: async (id: string) => { data.delete(id); },
            all: async () => Array.from(data.entries()).map(([key, value]) => ({ key, value })),
        };
        this.ledger = new TokenLedger(mockStore as any);
        this.settlement = new TokenSettlement(this.token, this.ledger);
    }

    /**
     * Check if nodes are healthy by sending a small activation.
     */
    async checkHealth(addresses: string[]): Promise<boolean[]> {
        const results: boolean[] = [];
        const probe = new Float32Array([1.0]);

        for (const addr of addresses) {
            try {
                await this.client.send(addr, probe);
                results.push(true);
            } catch {
                results.push(false);
            }
        }

        return results;
    }

    /**
     * Compute the expected output locally (reference implementation).
     */
    computeLocalReference(
        input: Float32Array,
        startLayer: number,
        endLayer: number,
    ): Float32Array {
        let current = input;
        for (let layer = startLayer; layer <= endLayer; layer++) {
            current = defaultLocalCompute(current, layer);
        }
        return current;
    }

    /**
     * Run inference through a chain of remote nodes, collecting metrics.
     */
    async runPipeline(
        input: Float32Array,
        addresses: string[],
    ): Promise<PipelineResult> {
        let current = input;
        const hops: HopMetric[] = [];
        const totalStart = performance.now();

        for (const addr of addresses) {
            const hopStart = performance.now();
            current = await this.client.send(addr, current);
            hops.push({
                address: addr,
                latencyMs: performance.now() - hopStart,
            });
        }

        return {
            output: current,
            metrics: {
                hops,
                totalLatencyMs: performance.now() - totalStart,
            },
        };
    }

    /**
     * Verify pipeline output matches local reference within tolerance.
     */
    verifyResult(
        actual: Float32Array,
        expected: Float32Array,
        tolerance = 1e-4,
    ): boolean {
        if (actual.length !== expected.length) return false;
        for (let i = 0; i < actual.length; i++) {
            if (Math.abs(actual[i] - expected[i]) > tolerance) return false;
        }
        return true;
    }

    /**
     * Settle tokens for a completed pipeline inference and report balances.
     */
    async settleAndReport(
        nodeIds: string[],
        blockHeight: number,
    ): Promise<SettlementReport> {
        const validProof: ZKProofLike = {
            outputCommitment: 'verified',
            expectedOutputHash: 'verified',
        };

        await this.settlement.settleInference(nodeIds, blockHeight, validProof);

        const balances: Record<string, number> = {};
        for (const id of nodeIds) {
            balances[id] = await this.ledger.getBalance(id);
        }

        const blockReward = this.token.getBlockReward(blockHeight);

        return {
            blockReward,
            rewardPerNode: blockReward / nodeIds.length,
            balances,
        };
    }
}
