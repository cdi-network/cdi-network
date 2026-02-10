/**
 * ContributionTracker — TDD tests
 *
 * Tests CDI royalty distribution for model contributors:
 * fine-tuning, LoRA, quantization, distillation.
 */
import { ContributionTracker, Contribution, RoyaltyDistribution } from '../../src/token/ContributionTracker';
import { ModelRegistry } from '../../src/registry/ModelRegistry';

function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: async (entry: any) => { data.set(entry._id, entry); },
        get: async (id: string) => data.get(id) ?? null,
        del: async (id: string) => { data.delete(id); },
        all: async () => [...data.entries()].map(([key, value]) => ({ key, value })),
    };
}

describe('ContributionTracker', () => {
    let registry: ModelRegistry;
    let tracker: ContributionTracker;

    beforeEach(async () => {
        registry = new ModelRegistry(createMockStore());
        tracker = new ContributionTracker(registry);

        // Seed: base model
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            contributorId: 'meta',
        });
    });

    // ── Registration ────────────────────────────────────

    test('register a fine-tune contribution', async () => {
        await registry.register({
            modelId: 'llama3:8b-medical', family: 'llama3', variant: '8b-medical',
            capabilities: ['chat', 'medical'],
            parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b',
            contributorId: 'dr-smith',
        });

        const contribution = await tracker.registerContribution({
            contributorId: 'dr-smith',
            modelId: 'llama3:8b-medical',
            parentModelId: 'llama3:8b',
            type: 'fine-tune',
        });

        expect(contribution.contributorId).toBe('dr-smith');
        expect(contribution.type).toBe('fine-tune');
        expect(contribution.royaltyRate).toBeGreaterThan(0);
    });

    // ── Royalty Calculation ─────────────────────────────

    test('calculate royalties for single contributor', async () => {
        await registry.register({
            modelId: 'llama3:8b-code', family: 'llama3', variant: '8b-code',
            capabilities: ['chat', 'code'],
            parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b',
            contributorId: 'alice',
        });

        await tracker.registerContribution({
            contributorId: 'alice',
            modelId: 'llama3:8b-code',
            parentModelId: 'llama3:8b',
            type: 'fine-tune',
        });

        const inferenceFeeCDI = 1.0;
        const distribution = await tracker.calculateRoyalties('llama3:8b-code', inferenceFeeCDI);

        expect(distribution.length).toBeGreaterThan(0);

        // Alice should get a share
        const aliceShare = distribution.find(d => d.contributorId === 'alice');
        expect(aliceShare).toBeDefined();
        expect(aliceShare!.amount).toBeGreaterThan(0);

        // Total royalties must not exceed the fee
        const totalRoyalties = distribution.reduce((sum, d) => sum + d.amount, 0);
        expect(totalRoyalties).toBeLessThanOrEqual(inferenceFeeCDI);
    });

    test('cascading royalties: base → fine-tune → LoRA', async () => {
        // Fine-tune on top of base
        await registry.register({
            modelId: 'llama3:8b-code', family: 'llama3', variant: '8b-code',
            capabilities: ['chat', 'code'],
            parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b',
            contributorId: 'alice',
        });

        // LoRA on top of fine-tune
        await registry.register({
            modelId: 'llama3:8b-code-sql', family: 'llama3', variant: '8b-code-sql',
            capabilities: ['chat', 'code', 'sql'],
            parameterCount: 8e9, vramRequired: 6100, layerCount: 32,
            parentModelId: 'llama3:8b-code',
            contributorId: 'bob',
        });

        await tracker.registerContribution({
            contributorId: 'alice',
            modelId: 'llama3:8b-code',
            parentModelId: 'llama3:8b',
            type: 'fine-tune',
        });

        await tracker.registerContribution({
            contributorId: 'bob',
            modelId: 'llama3:8b-code-sql',
            parentModelId: 'llama3:8b-code',
            type: 'lora',
        });

        const distribution = await tracker.calculateRoyalties('llama3:8b-code-sql', 1.0);

        // Both alice and bob should get royalties
        const aliceShare = distribution.find(d => d.contributorId === 'alice');
        const bobShare = distribution.find(d => d.contributorId === 'bob');

        expect(aliceShare).toBeDefined();
        expect(bobShare).toBeDefined();

        // Latest contributor (bob) should get more than upstream (alice)
        expect(bobShare!.amount).toBeGreaterThan(aliceShare!.amount);

        // Total ≤ fee
        const total = distribution.reduce((sum, d) => sum + d.amount, 0);
        expect(total).toBeLessThanOrEqual(1.0);
    });

    // ── Royalty Rates by Type ───────────────────────────

    test('different contribution types have different royalty rates', async () => {
        // Fine-tune
        await registry.register({
            modelId: 'ft-model', family: 'test', variant: 'ft',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'alice',
        });
        const ftContrib = await tracker.registerContribution({
            contributorId: 'alice', modelId: 'ft-model',
            parentModelId: 'llama3:8b', type: 'fine-tune',
        });

        // Quantization
        await registry.register({
            modelId: 'quant-model', family: 'test', variant: 'quant',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 3000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'charlie',
        });
        const quantContrib = await tracker.registerContribution({
            contributorId: 'charlie', modelId: 'quant-model',
            parentModelId: 'llama3:8b', type: 'quantization',
        });

        // Fine-tune should have higher royalty than quantization
        expect(ftContrib.royaltyRate).toBeGreaterThan(quantContrib.royaltyRate);
    });

    // ── No Royalties for Base Model ─────────────────────

    test('base model with no contributions returns empty royalties', async () => {
        const distribution = await tracker.calculateRoyalties('llama3:8b', 1.0);
        expect(distribution).toHaveLength(0);
    });

    // ── Contribution Lookup ─────────────────────────────

    test('get contributions for a specific model', async () => {
        await registry.register({
            modelId: 'llama3:8b-code', family: 'llama3', variant: '8b-code',
            capabilities: ['chat', 'code'],
            parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'alice',
        });

        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'llama3:8b-code',
            parentModelId: 'llama3:8b', type: 'fine-tune',
        });

        const contribs = tracker.getContributionsForModel('llama3:8b-code');
        expect(contribs).toHaveLength(1);
        expect(contribs[0].contributorId).toBe('alice');
    });

    test('get all contributions by a contributor', async () => {
        await registry.register({
            modelId: 'model-a', family: 'test', variant: 'a',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'alice',
        });
        await registry.register({
            modelId: 'model-b', family: 'test', variant: 'b',
            capabilities: ['code'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'alice',
        });

        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'model-a',
            parentModelId: 'llama3:8b', type: 'fine-tune',
        });
        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'model-b',
            parentModelId: 'llama3:8b', type: 'lora',
        });

        const contribs = tracker.getContributionsByContributor('alice');
        expect(contribs).toHaveLength(2);
    });
});
