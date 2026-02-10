/**
 * ModelRegistry — TDD tests
 *
 * Tests model catalog: registration, querying, versioning, lineage,
 * and node-model mapping.
 */
import { ModelRegistry, ModelEntry, ModelQuery } from '../../src/registry/ModelRegistry';

// Helper: create a minimal in-memory store
function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: async (entry: any) => { data.set(entry._id, entry); },
        get: async (id: string) => data.get(id) ?? null,
        del: async (id: string) => { data.delete(id); },
        all: async () => [...data.entries()].map(([key, value]) => ({ key, value })),
    };
}

describe('ModelRegistry', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
        registry = new ModelRegistry(createMockStore());
    });

    // ── Registration ────────────────────────────────────

    test('register a model and retrieve it by ID', async () => {
        const entry = await registry.register({
            modelId: 'llama3:8b',
            family: 'llama3',
            variant: '8b',
            capabilities: ['chat', 'code'],
            parameterCount: 8_000_000_000,
            vramRequired: 6_000,
            layerCount: 32,
        });

        expect(entry.modelId).toBe('llama3:8b');
        expect(entry.version).toBe(1);

        const retrieved = await registry.getModel('llama3:8b');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.family).toBe('llama3');
    });

    test('registering duplicate modelId throws', async () => {
        await registry.register({
            modelId: 'llama3:8b',
            family: 'llama3',
            variant: '8b',
            capabilities: ['chat'],
            parameterCount: 8e9,
            vramRequired: 6000,
            layerCount: 32,
        });

        await expect(
            registry.register({
                modelId: 'llama3:8b',
                family: 'llama3',
                variant: '8b',
                capabilities: ['chat'],
                parameterCount: 8e9,
                vramRequired: 6000,
                layerCount: 32,
            }),
        ).rejects.toThrow(/already registered/);
    });

    // ── Querying ────────────────────────────────────────

    test('query by capability', async () => {
        await registry.register({
            modelId: 'llama3:8b',
            family: 'llama3',
            variant: '8b',
            capabilities: ['chat', 'code'],
            parameterCount: 8e9,
            vramRequired: 6000,
            layerCount: 32,
        });

        await registry.register({
            modelId: 'nomic-embed:latest',
            family: 'nomic',
            variant: 'latest',
            capabilities: ['embedding'],
            parameterCount: 137_000_000,
            vramRequired: 500,
            layerCount: 12,
        });

        const chatModels = await registry.query({ capability: 'chat' });
        expect(chatModels).toHaveLength(1);
        expect(chatModels[0].modelId).toBe('llama3:8b');

        const embedModels = await registry.query({ capability: 'embedding' });
        expect(embedModels).toHaveLength(1);
        expect(embedModels[0].modelId).toBe('nomic-embed:latest');
    });

    test('query by family', async () => {
        await registry.register({
            modelId: 'deepseek-r1:7b', family: 'deepseek-r1', variant: '7b',
            capabilities: ['chat'], parameterCount: 7e9, vramRequired: 5000, layerCount: 28,
        });
        await registry.register({
            modelId: 'deepseek-r1:70b', family: 'deepseek-r1', variant: '70b',
            capabilities: ['chat', 'code'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80,
        });
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        const deepseekModels = await registry.query({ family: 'deepseek-r1' });
        expect(deepseekModels).toHaveLength(2);
    });

    test('query by maxVram filters out large models', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });
        await registry.register({
            modelId: 'llama3:70b', family: 'llama3', variant: '70b',
            capabilities: ['chat'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80,
        });

        const small = await registry.query({ maxVram: 10000 });
        expect(small).toHaveLength(1);
        expect(small[0].modelId).toBe('llama3:8b');
    });

    // ── Versioning ──────────────────────────────────────

    test('update model bumps version', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        const updated = await registry.updateModel('llama3:8b', {
            capabilities: ['chat', 'code', 'math'],
            quantization: 'q4_K_M',
        });

        expect(updated.version).toBe(2);
        expect(updated.capabilities).toContain('math');
        expect(updated.quantization).toBe('q4_K_M');
    });

    // ── Lineage ─────────────────────────────────────────

    test('register derived model with parent lineage', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        const derived = await registry.register({
            modelId: 'llama3:8b-medical', family: 'llama3', variant: '8b-medical',
            capabilities: ['chat', 'medical'],
            parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
            parentModelId: 'llama3:8b',
            contributorId: 'dr-smith',
        });

        expect(derived.parentModelId).toBe('llama3:8b');
        expect(derived.contributorId).toBe('dr-smith');

        const lineage = await registry.getLineage('llama3:8b-medical');
        expect(lineage).toHaveLength(2);
        expect(lineage[0].modelId).toBe('llama3:8b');       // ancestor first
        expect(lineage[1].modelId).toBe('llama3:8b-medical');
    });

    test('lineage of root model returns single entry', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        const lineage = await registry.getLineage('llama3:8b');
        expect(lineage).toHaveLength(1);
        expect(lineage[0].modelId).toBe('llama3:8b');
    });

    // ── Node-Model Mapping ──────────────────────────────

    test('track which nodes serve which models', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        await registry.assignNodeModel('node-1', 'llama3:8b');
        await registry.assignNodeModel('node-2', 'llama3:8b');

        const nodes = await registry.getNodesForModel('llama3:8b');
        expect(nodes).toContain('node-1');
        expect(nodes).toContain('node-2');
        expect(nodes).toHaveLength(2);
    });

    test('get models available on a specific node', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });
        await registry.register({
            modelId: 'nomic-embed:latest', family: 'nomic', variant: 'latest',
            capabilities: ['embedding'], parameterCount: 137e6, vramRequired: 500, layerCount: 12,
        });

        await registry.assignNodeModel('node-1', 'llama3:8b');
        await registry.assignNodeModel('node-1', 'nomic-embed:latest');

        const models = await registry.getModelsForNode('node-1');
        expect(models).toHaveLength(2);
    });

    test('unassign node-model removes mapping', async () => {
        await registry.register({
            modelId: 'llama3:8b', family: 'llama3', variant: '8b',
            capabilities: ['chat'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32,
        });

        await registry.assignNodeModel('node-1', 'llama3:8b');
        await registry.unassignNodeModel('node-1', 'llama3:8b');

        const nodes = await registry.getNodesForModel('llama3:8b');
        expect(nodes).toHaveLength(0);
    });

    // ── Fee Multiplier ──────────────────────────────────

    test('fee multiplier scales with model size', async () => {
        await registry.register({
            modelId: 'tiny:1b', family: 'tiny', variant: '1b',
            capabilities: ['chat'], parameterCount: 1e9, vramRequired: 1000, layerCount: 12,
        });
        await registry.register({
            modelId: 'large:70b', family: 'large', variant: '70b',
            capabilities: ['chat'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80,
        });

        const tinyMul = registry.getFeeMultiplier('tiny:1b');
        const largeMul = registry.getFeeMultiplier('large:70b');

        expect(tinyMul).toBe(1.0);             // base tier (≤7B)
        expect(largeMul).toBe(5.0);             // large tier (≤70B)
        expect(largeMul).toBeGreaterThan(tinyMul);
    });

    // ── List all models ─────────────────────────────────

    test('listAll returns all registered models', async () => {
        await registry.register({
            modelId: 'a:1b', family: 'a', variant: '1b',
            capabilities: ['chat'], parameterCount: 1e9, vramRequired: 1000, layerCount: 12,
        });
        await registry.register({
            modelId: 'b:7b', family: 'b', variant: '7b',
            capabilities: ['code'], parameterCount: 7e9, vramRequired: 5000, layerCount: 28,
        });

        const all = await registry.listAll();
        expect(all).toHaveLength(2);
    });
});
