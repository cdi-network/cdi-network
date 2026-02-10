/**
 * DynamicFeeOracle — Congestion-based inference fee pricing.
 *
 * Four tiers based on network utilization:
 *   < 50%  → discount (attract users)
 *   50-80% → normal
 *   80-95% → premium (congestion signal)
 *   > 95%  → surge (high demand)
 *
 * Fee is always clamped between minFee and maxFee.
 * Monotonically increasing with utilization.
 */

export interface FeeConfig {
    /** Base fee in CDI per inference (at normal utilization) */
    initialFee: number;
    /** Absolute minimum fee */
    minFee: number;
    /** Absolute maximum fee */
    maxFee: number;
}

const DEFAULT_FEE_CONFIG: FeeConfig = {
    initialFee: 0.1,
    minFee: 0.001,
    maxFee: 5.0,
};

/** Fee multipliers per utilization tier */
const TIER_MULTIPLIERS = {
    discount: 0.5,    // < 50% utilization
    normal: 1.0,      // 50-80%
    premium: 1.5,     // 80-95%
    surge: 2.0,       // > 95%
} as const;

export class DynamicFeeOracle {
    private config: FeeConfig;

    constructor(config: Partial<FeeConfig> = {}) {
        this.config = { ...DEFAULT_FEE_CONFIG, ...config };
    }

    /**
     * Calculate the inference fee based on network utilization.
     *
     * @param utilization - Current network utilization as fraction [0, 1]
     * @returns Fee in CDI, clamped between minFee and maxFee
     */
    calculateFee(utilization: number): number {
        const clampedUtil = Math.max(0, Math.min(utilization, 1.0));

        let multiplier: number;
        if (clampedUtil < 0.5) {
            multiplier = TIER_MULTIPLIERS.discount;
        } else if (clampedUtil < 0.8) {
            multiplier = TIER_MULTIPLIERS.normal;
        } else if (clampedUtil < 0.95) {
            multiplier = TIER_MULTIPLIERS.premium;
        } else {
            multiplier = TIER_MULTIPLIERS.surge;
        }

        const rawFee = this.config.initialFee * multiplier;
        return Math.max(this.config.minFee, Math.min(rawFee, this.config.maxFee));
    }

    /**
     * Get the current fee tier name for logging/diagnostics.
     */
    getTier(utilization: number): 'discount' | 'normal' | 'premium' | 'surge' {
        if (utilization < 0.5) return 'discount';
        if (utilization < 0.8) return 'normal';
        if (utilization < 0.95) return 'premium';
        return 'surge';
    }

    /**
     * Get the current fee configuration.
     */
    getConfig(): Readonly<FeeConfig> {
        return { ...this.config };
    }
}
