/**
 * ContributionTracker — TDD tests (Redesigned)
 *
 * Tests CDI reward distribution with 85/15 provider/ecosystem split:
 * - Upload contribution type
 * - Usage-proportional rewards
 * - Provider-first economics
 * - Cascading improver shares
 */
import {
    ContributionTracker,
    PROVIDER_SHARE,
    ECOSYSTEM_SHARE,
    UPLOADER_SHARE,
    IMPROVER_SHARE,
} from '../../src/token/ContributionTracker';
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

        // Seed: base model with uploader
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            contributorId: 'meta',
        });

        // Register upload contribution
        await tracker.registerContribution({
            contributorId: 'meta',
            modelId: 'llama3:8b',
            parentModelId: 'llama3:8b',
            type: 'upload',
        });
    });

    // ── Constants ────────────────────────────────────────

    test('reward split constants sum correctly', () => {
        expect(PROVIDER_SHARE + ECOSYSTEM_SHARE).toBeCloseTo(1.0);
        expect(UPLOADER_SHARE + IMPROVER_SHARE).toBeCloseTo(1.0);
        expect(PROVIDER_SHARE).toBe(0.85);
        expect(ECOSYSTEM_SHARE).toBe(0.15);
    });

    // ── Upload Contribution ─────────────────────────────

    test('register an upload contribution', async () => {
        const contribs = tracker.getContributionsForModel('llama3:8b');
        expect(contribs).toHaveLength(1);
        expect(contribs[0].type).toBe('upload');
        expect(contribs[0].contributorId).toBe('meta');
    });

    // ── 85/15 Split ─────────────────────────────────────

    test('85% goes to providers, 15% to ecosystem', async () => {
        const fee = 1.0;
        const dist = await tracker.calculateRoyalties(
            'llama3:8b',
            fee,
            ['node-1', 'node-2'],
        );

        const providerTotal = dist
            .filter(d => d.category === 'provider')
            .reduce((sum, d) => sum + d.amount, 0);

        const uploaderTotal = dist
            .filter(d => d.category === 'uploader')
            .reduce((sum, d) => sum + d.amount, 0);

        expect(providerTotal).toBeCloseTo(0.85);
        expect(uploaderTotal).toBeCloseTo(0.15 * 0.60); // 15% × 60% = 0.09
    });

    test('provider share split equally among nodes', async () => {
        const dist = await tracker.calculateRoyalties(
            'llama3:8b',
            1.0,
            ['node-1', 'node-2'],
        );

        const providerEntries = dist.filter(d => d.category === 'provider');
        expect(providerEntries).toHaveLength(2);
        expect(providerEntries[0].amount).toBeCloseTo(0.425); // 0.85 / 2
        expect(providerEntries[1].amount).toBeCloseTo(0.425);
    });

    // ── Uploader Gets Usage-Proportional Reward ─────────

    test('uploader earns on every inference', async () => {
        // Simulate 10 inferences
        let totalUploaderReward = 0;
        for (let i = 0; i < 10; i++) {
            const dist = await tracker.calculateRoyalties('llama3:8b', 0.5, ['node-1']);
            const uploaderShare = dist.find(d => d.category === 'uploader');
            if (uploaderShare) totalUploaderReward += uploaderShare.amount;
        }

        // 10 × 0.5 × 0.15 × 0.60 = 0.45 CDI
        expect(totalUploaderReward).toBeCloseTo(0.45);
    });

    // ── Improver Cascade ────────────────────────────────

    test('improvers get share from ecosystem pool with cascade', async () => {
        // Fine-tune on base
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
        // Upload contribution for derived model
        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'llama3:8b-code',
            parentModelId: 'llama3:8b', type: 'upload',
        });

        const dist = await tracker.calculateRoyalties('llama3:8b-code', 1.0, ['node-1']);

        // Provider
        const providerTotal = dist
            .filter(d => d.category === 'provider')
            .reduce((sum, d) => sum + d.amount, 0);
        expect(providerTotal).toBeCloseTo(0.85);

        // Improver (alice for fine-tune)
        const improverEntries = dist.filter(d => d.category === 'improver');
        expect(improverEntries.length).toBeGreaterThan(0);

        // Total must not exceed fee
        const total = dist.reduce((sum, d) => sum + d.amount, 0);
        expect(total).toBeLessThanOrEqual(1.0);
    });

    // ── No Uploader = No Ecosystem Payout ───────────────

    test('model with no upload contribution gets no uploader reward', async () => {
        await registry.register({
            modelId: 'orphan:1b', family: 'orphan', variant: '1b',
            capabilities: ['chat'], parameterCount: 1e9, vramRequired: 1000, layerCount: 12,
        });
        // No upload contribution registered!

        const dist = await tracker.calculateRoyalties('orphan:1b', 1.0, ['node-1']);

        const uploaderEntries = dist.filter(d => d.category === 'uploader');
        expect(uploaderEntries).toHaveLength(0);

        // But providers still get their 85%
        const providerTotal = dist
            .filter(d => d.category === 'provider')
            .reduce((sum, d) => sum + d.amount, 0);
        expect(providerTotal).toBeCloseTo(0.85);
    });

    // ── Different Contribution Types ────────────────────

    test('different contribution types have different improver weights', async () => {
        // LoRA on base
        await registry.register({
            modelId: 'lora-model', family: 'test', variant: 'lora',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6100, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'bob',
        });

        const ftContrib = await tracker.registerContribution({
            contributorId: 'bob', modelId: 'lora-model',
            parentModelId: 'llama3:8b', type: 'fine-tune',
        });

        const loraContrib = await tracker.registerContribution({
            contributorId: 'charlie', modelId: 'lora-model',
            parentModelId: 'llama3:8b', type: 'lora',
        });

        // fine-tune weight (0.50) > lora weight (0.30)
        expect(ftContrib.royaltyRate).toBeGreaterThan(loraContrib.royaltyRate);
    });

    // ── Contributor Lookup ───────────────────────────────

    test('get all contributions by a contributor', async () => {
        await registry.register({
            modelId: 'model-a', family: 'test', variant: 'a',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b', contributorId: 'alice',
        });

        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'model-a',
            parentModelId: 'llama3:8b', type: 'fine-tune',
        });
        await tracker.registerContribution({
            contributorId: 'alice', modelId: 'model-a',
            parentModelId: 'llama3:8b', type: 'upload',
        });

        const contribs = tracker.getContributionsByContributor('alice');
        expect(contribs).toHaveLength(2);
        expect(contribs.map(c => c.type)).toContain('upload');
        expect(contribs.map(c => c.type)).toContain('fine-tune');
    });
});
