/**
 * DynamicEpochManager — Demand-driven epoch transitions.
 *
 * Instead of fixed halving intervals (Bitcoin-style), epochs change
 * when inference demand crosses a dynamically adjusted threshold.
 *
 * High demand → threshold increases → epoch lasts longer → more CDI minted
 * Low demand  → threshold decreases → epoch changes faster → less CDI minted
 *
 * This creates a self-regulating supply that tracks real network activity.
 */
import type { InferenceToken } from './InferenceToken.js';
import { INITIAL_REWARD, MIN_REWARD } from './InferenceToken.js';

export interface EpochConfig {
    /** Base number of inferences per epoch (before demand adjustment) */
    baseEpochThreshold: number;
    /** Target inferences per second — the "ideal" network velocity */
    targetIPS: number;
    /** Maximum number of epochs (halvings) before rewards reach zero */
    maxEpochs: number;
}

export interface EpochState {
    currentEpoch: number;
    epochStartBlock: number;
    epochStartTime: number;
    inferenceCount: number;
    cumulativeBlocks: number;
}

const DEFAULT_CONFIG: EpochConfig = {
    baseEpochThreshold: 1_000,
    targetIPS: 10,
    maxEpochs: 64,
};

/**
 * Minimum adjustment factor to prevent threshold from going to zero.
 * Even at very low demand, threshold is at least 10% of base.
 */
const MIN_ADJUSTMENT = 0.1;

/**
 * Maximum adjustment factor to prevent threshold from growing unbounded.
 * Even at extreme demand, threshold is at most 10x base.
 */
const MAX_ADJUSTMENT = 10.0;

export class DynamicEpochManager {
    private state: EpochState;
    private readonly config: EpochConfig;

    constructor(config: Partial<EpochConfig> = {}, startTime?: number) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.state = {
            currentEpoch: 0,
            epochStartBlock: 0,
            epochStartTime: startTime ?? Date.now(),
            inferenceCount: 0,
            cumulativeBlocks: 0,
        };
    }

    /**
     * Record a completed inference and check for epoch transition.
     *
     * @param blockHeight - The block height of the inference
     * @param timestamp - Optional timestamp (defaults to Date.now())
     * @returns true if an epoch transition occurred
     */
    recordInference(blockHeight: number, timestamp?: number): boolean {
        this.state.inferenceCount++;
        this.state.cumulativeBlocks = blockHeight + 1;

        const now = timestamp ?? Date.now();
        const adjustedThreshold = this.getAdjustedThreshold(now);

        if (this.state.inferenceCount >= adjustedThreshold) {
            return this.transitionEpoch(blockHeight, now);
        }

        return false;
    }

    /**
     * Get block reward for the current dynamic epoch.
     * Delegates halving math to InferenceToken but uses dynamic epoch number.
     */
    getBlockReward(token: InferenceToken): number {
        const epoch = this.state.currentEpoch;
        if (epoch >= this.config.maxEpochs) return 0;

        const reward = INITIAL_REWARD / Math.pow(2, epoch);
        return reward < MIN_REWARD ? 0 : reward;
    }

    /**
     * Get current epoch state (read-only copy).
     */
    getState(): Readonly<EpochState> {
        return { ...this.state };
    }

    /**
     * Get the current utilization as a fraction [0, 1].
     * Utilization = inferenceCount / adjustedThreshold
     */
    getUtilization(timestamp?: number): number {
        const now = timestamp ?? Date.now();
        const threshold = this.getAdjustedThreshold(now);
        return Math.min(this.state.inferenceCount / threshold, 1.0);
    }

    /**
     * Calculate the demand-adjusted epoch threshold.
     *
     * adjustmentFactor = clamp(actualIPS / targetIPS, MIN, MAX)
     * adjustedThreshold = baseThreshold * adjustmentFactor
     *
     * High IPS → larger threshold → epoch lasts longer → more CDI minted
     * Low IPS  → smaller threshold → epoch ends sooner → less CDI minted
     */
    private getAdjustedThreshold(now: number): number {
        const elapsedMs = now - this.state.epochStartTime;
        const elapsedSec = Math.max(elapsedMs / 1000, 0.001); // avoid division by zero

        const actualIPS = this.state.inferenceCount / elapsedSec;
        const rawAdjustment = actualIPS / this.config.targetIPS;

        // Clamp to prevent extreme values
        const adjustment = Math.max(MIN_ADJUSTMENT, Math.min(rawAdjustment, MAX_ADJUSTMENT));

        return Math.ceil(this.config.baseEpochThreshold * adjustment);
    }

    /**
     * Transition to the next epoch.
     */
    private transitionEpoch(blockHeight: number, now: number): boolean {
        this.state.currentEpoch++;
        this.state.epochStartBlock = blockHeight + 1;
        this.state.epochStartTime = now;
        this.state.inferenceCount = 0;
        return true;
    }
}
