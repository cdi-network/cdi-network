/**
 * ContributionTracker — CDI royalties for model uploaders and improvers.
 *
 * Tracks who uploaded/contributed to a model and calculates
 * usage-proportional royalties from inference fees.
 *
 * Economics:
 *   - Provider gets 85% of fee (sustains the network)
 *   - 15% goes to Model Ecosystem Pool:
 *     - 60% to uploader (who loaded the model)
 *     - 40% to improvers (fine-tune, LoRA, quant, distill) with cascade decay
 *   - Proportional to usage: each inference pays out
 */

import type { ModelRegistry } from '../registry/ModelRegistry';

/** Reward split constants */
export const PROVIDER_SHARE = 0.85;      // 85% to inference providers
export const ECOSYSTEM_SHARE = 0.15;      // 15% to model ecosystem
export const UPLOADER_SHARE = 0.60;       // 60% of ecosystem → uploader
export const IMPROVER_SHARE = 0.40;       // 40% of ecosystem → improvers

/** Improver sub-split (within the 40% improver share) */
const IMPROVER_WEIGHTS: Record<string, number> = {
    'fine-tune': 0.50,       // 50% of improver share
    'lora': 0.30,            // 30% of improver share
    'quantization': 0.10,    // 10% of improver share
    'distillation': 0.10,    // 10% of improver share
};

/** Upstream decay: each ancestor gets this fraction of the next contributor's rate */
const UPSTREAM_DECAY = 0.5;

export type ContributionType = 'upload' | 'fine-tune' | 'lora' | 'quantization' | 'distillation';

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
    category: 'provider' | 'uploader' | 'improver';
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
        const rate = input.royaltyRate ?? (IMPROVER_WEIGHTS[input.type] ?? 0);

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
     * Calculate the full reward distribution for an inference.
     *
     * Returns provider share + uploader share + improver shares.
     * Provider share is returned as a single entry (to be split among nodes by caller).
     *
     * @param modelId - model used for inference
     * @param inferenceFee - total CDI fee paid by requester
     * @param providerNodeIds - nodes that provided inference
     */
    async calculateRoyalties(
        modelId: string,
        inferenceFee: number,
        providerNodeIds?: string[],
    ): Promise<RoyaltyDistribution[]> {
        const distributions: RoyaltyDistribution[] = [];

        const providerAmount = inferenceFee * PROVIDER_SHARE;
        const ecosystemAmount = inferenceFee * ECOSYSTEM_SHARE;

        // 1. Provider share — distributed by caller to nodes
        if (providerNodeIds && providerNodeIds.length > 0) {
            const perNode = providerAmount / providerNodeIds.length;
            for (const nodeId of providerNodeIds) {
                distributions.push({
                    contributorId: nodeId,
                    modelId,
                    amount: perNode,
                    type: 'upload', // use 'upload' type as placeholder for provider
                    category: 'provider',
                });
            }
        }

        // 2. Uploader share — 60% of ecosystem
        const uploaderAmount = ecosystemAmount * UPLOADER_SHARE;
        const model = await this.registry.getModel(modelId);
        // Find uploader contribution
        const uploaderContrib = (this.byModel.get(modelId) ?? [])
            .find(c => c.type === 'upload');

        if (uploaderContrib) {
            distributions.push({
                contributorId: uploaderContrib.contributorId,
                modelId,
                amount: uploaderAmount,
                type: 'upload',
                category: 'uploader',
            });
        }

        // 3. Improver shares — 40% of ecosystem, cascading
        const improverPool = ecosystemAmount * IMPROVER_SHARE;
        const lineage = await this.registry.getLineage(modelId);

        // Collect improver contributions along lineage (not upload type)
        const improverContributions: Contribution[] = [];
        for (const m of lineage) {
            const contribs = (this.byModel.get(m.modelId) ?? [])
                .filter(c => c.type !== 'upload');
            improverContributions.push(...contribs);
        }

        if (improverContributions.length > 0) {
            // Newest first, with exponential decay
            const ordered = [...improverContributions].reverse();
            let remaining = improverPool;
            let decayMultiplier = 1.0;

            for (const contrib of ordered) {
                const weight = IMPROVER_WEIGHTS[contrib.type] ?? 0.1;
                const amount = Math.min(improverPool * weight * decayMultiplier, remaining);

                if (amount > 0) {
                    distributions.push({
                        contributorId: contrib.contributorId,
                        modelId: contrib.modelId,
                        amount,
                        type: contrib.type,
                        category: 'improver',
                    });
                    remaining -= amount;
                }

                decayMultiplier *= UPSTREAM_DECAY;
                if (remaining <= 0) break;
            }
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
