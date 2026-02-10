/**
 * TestOrchestrator v2 — automated test harness for Docker swarm testing.
 *
 * Connects to N running PipelineNode containers, runs inference,
 * verifies results, and reports metrics + token settlement.
 *
 * v2: Supports optional real OrbitDB store for TokenLedger instead of in-memory mock.
 * Also supports configurable local compute function for Ollama mode verification.
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

export type LedgerStoreProvider = {
    put: (entry: any) => Promise<void>;
    get: (id: string) => Promise<any>;
    del: (id: string) => Promise<void>;
    all: () => Promise<Array<{ key: string; value: any }>>;
};

export type LocalComputeFn = (input: Float32Array, layerIdx: number) => Float32Array;

/**
 * Default compute function mirror — must match PipelineNode's simulated default.
 */
const defaultLocalCompute: LocalComputeFn = (input: Float32Array, layerIdx: number): Float32Array => {
    const scale = 1 + layerIdx * 0.01;
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * scale;
    }
    return output;
};

/**
 * Create an in-memory store (backwards compatible default).
 */
function createInMemoryStore(): LedgerStoreProvider {
    const data = new Map<string, any>();
    return {
        put: async (entry: any) => { data.set(entry._id, entry); },
        get: async (id: string) => data.get(id) ?? null,
        del: async (id: string) => { data.delete(id); },
        all: async () => Array.from(data.entries()).map(([key, value]) => ({ key, value })),
    };
}

export interface TestOrchestratorConfig {
    hmacSecret: string;
    timeoutMs?: number;
    /** Optional: provide a real store (e.g. OrbitDB KV) instead of in-memory */
    ledgerStore?: LedgerStoreProvider;
    /** Optional: provide a custom local compute function for verification */
    localComputeFn?: LocalComputeFn;
    /** Whether to skip local verification (useful for Ollama mode where output is non-deterministic) */
    skipLocalVerification?: boolean;
}

export class TestOrchestrator {
    private readonly client: ActivationRelayClient;
    private readonly token: InferenceToken;
    private readonly ledger: TokenLedger;
    private readonly settlement: TokenSettlement;
    private readonly localComputeFn: LocalComputeFn;
    private readonly skipLocalVerification: boolean;
    private readonly storeType: 'in-memory' | 'external';

    constructor(config: TestOrchestratorConfig) {
        this.client = new ActivationRelayClient({ hmacSecret: config.hmacSecret, timeoutMs: config.timeoutMs ?? 5000 });
        this.token = new InferenceToken();

        const store = config.ledgerStore ?? createInMemoryStore();
        this.storeType = config.ledgerStore ? 'external' : 'in-memory';
        this.ledger = new TokenLedger(store as any);
        this.settlement = new TokenSettlement(this.token, this.ledger);
        this.localComputeFn = config.localComputeFn ?? defaultLocalCompute;
        this.skipLocalVerification = config.skipLocalVerification ?? false;
    }

    /** For backward compat: simple constructor */
    static simulated(hmacSecret: string, timeoutMs = 5000): TestOrchestrator {
        return new TestOrchestrator({ hmacSecret, timeoutMs });
    }

    /** Factory: real OrbitDB-backed store */
    static withStore(hmacSecret: string, store: LedgerStoreProvider, timeoutMs = 5000): TestOrchestrator {
        return new TestOrchestrator({ hmacSecret, timeoutMs, ledgerStore: store });
    }

    /** Factory: Ollama mode (skip local verification) */
    static ollamaMode(hmacSecret: string, timeoutMs = 30000): TestOrchestrator {
        return new TestOrchestrator({ hmacSecret, timeoutMs, skipLocalVerification: true });
    }

    getStoreType(): string {
        return this.storeType;
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
            current = this.localComputeFn(current, layer);
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
     * Verify pipeline output:
     * - In simulated mode: matches local reference within tolerance
     * - In ollama mode: just checks output is non-empty and finite
     */
    verifyResult(
        actual: Float32Array,
        expected: Float32Array,
        tolerance = 1e-4,
    ): boolean {
        if (this.skipLocalVerification) {
            // Ollama mode: output should be non-empty with valid numbers
            return actual.length > 0 && actual.every(v => Number.isFinite(v));
        }
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
