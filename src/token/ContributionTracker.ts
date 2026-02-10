/**
 * ContributionTracker — CDI royalties for model improvers.
 *
 * Tracks who contributed to a model (fine-tune, LoRA, quantization,
 * distillation) and calculates cascading royalties from inference fees.
 *
 * Economics:
 *   - Each contribution type has a default royalty rate
 *   - Cascading: base → fine-tune → LoRA each get a share
 *   - Latest contributor gets the largest share (geometric decay upstream)
 *   - Total royalties never exceed the inference fee
 */

import type { ModelRegistry } from '../registry/ModelRegistry';

/** Royalty rates by contribution type (fraction of inference fee) */
const DEFAULT_ROYALTY_RATES: Record<ContributionType, number> = {
    'fine-tune': 0.05,       // 5% — most valuable
    'lora': 0.03,            // 3% — adapter layers
    'quantization': 0.01,    // 1% — compression
    'distillation': 0.04,    // 4% — knowledge transfer
};

/** Upstream decay: each ancestor gets this fraction of the next contributor's rate */
const UPSTREAM_DECAY = 0.5;

export type ContributionType = 'fine-tune' | 'lora' | 'quantization' | 'distillation';

export interface ContributionInput {
    contributorId: string;
    modelId: string;
    parentModelId: string;
    type: ContributionType;
    royaltyRate?: number;     // override default rate
}

export interface Contribution {
    contributorId: string;
    modelId: string;
    parentModelId: string;
    type: ContributionType;
    royaltyRate: number;
    timestamp: number;
}

export interface RoyaltyDistribution {
    contributorId: string;
    modelId: string;
    amount: number;
    type: ContributionType;
}

export class ContributionTracker {
    /** All contributions indexed by modelId */
    private readonly byModel = new Map<string, Contribution[]>();
    /** All contributions indexed by contributorId */
    private readonly byContributor = new Map<string, Contribution[]>();

    constructor(private readonly registry: ModelRegistry) { }

    /**
     * Register a contribution for CDI royalty tracking.
     */
    async registerContribution(input: ContributionInput): Promise<Contribution> {
        const rate = input.royaltyRate ?? DEFAULT_ROYALTY_RATES[input.type];

        const contribution: Contribution = {
            contributorId: input.contributorId,
            modelId: input.modelId,
            parentModelId: input.parentModelId,
            type: input.type,
            royaltyRate: rate,
            timestamp: Date.now(),
        };

        // Index by model
        if (!this.byModel.has(input.modelId)) {
            this.byModel.set(input.modelId, []);
        }
        this.byModel.get(input.modelId)!.push(contribution);

        // Index by contributor
        if (!this.byContributor.has(input.contributorId)) {
            this.byContributor.set(input.contributorId, []);
        }
        this.byContributor.get(input.contributorId)!.push(contribution);

        return contribution;
    }

    /**
     * Calculate royalty distribution for an inference on a given model.
     *
     * Walks the lineage chain and distributes royalties:
     *   - Direct contributor gets their full royaltyRate × fee
     *   - Each upstream contributor gets decayed share
     *   - Total capped at fee
     */
    async calculateRoyalties(
        modelId: string,
        inferenceFee: number,
    ): Promise<RoyaltyDistribution[]> {
        const lineage = await this.registry.getLineage(modelId);
        if (lineage.length <= 1) {
            // Base model with no contributions → no royalties
            return [];
        }

        // Collect contributions along the lineage (newest first for decay)
        const lineageContributions: Contribution[] = [];
        for (const model of lineage) {
            const contribs = this.byModel.get(model.modelId) ?? [];
            lineageContributions.push(...contribs);
        }

        if (lineageContributions.length === 0) {
            return [];
        }

        // Calculate shares: latest contributor gets full rate,
        // each upstream gets decayed rate
        const distributions: RoyaltyDistribution[] = [];
        let remaining = inferenceFee;

        // Process from newest to oldest (reverse order)
        const ordered = [...lineageContributions].reverse();

        let decayMultiplier = 1.0;
        for (const contrib of ordered) {
            const amount = Math.min(
                inferenceFee * contrib.royaltyRate * decayMultiplier,
                remaining,
            );

            if (amount > 0) {
                distributions.push({
                    contributorId: contrib.contributorId,
                    modelId: contrib.modelId,
                    amount,
                    type: contrib.type,
                });
                remaining -= amount;
            }

            decayMultiplier *= UPSTREAM_DECAY;

            if (remaining <= 0) break;
        }

        return distributions;
    }

    /**
     * Get all contributions for a specific model.
     */
    getContributionsForModel(modelId: string): Contribution[] {
        return this.byModel.get(modelId) ?? [];
    }

    /**
     * Get all contributions by a specific contributor.
     */
    getContributionsByContributor(contributorId: string): Contribution[] {
        return this.byContributor.get(contributorId) ?? [];
    }
}
