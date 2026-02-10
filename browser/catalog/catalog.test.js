/**
 * Tests for P5: Open-Weight Model Catalog.
 * Run: node --test browser/catalog/catalog.test.js
 */

import { ModelSharder } from './ModelSharder.js';
import { ModelCatalog } from './ModelCatalog.js';
import { GenesisUpload, GENESIS_MODELS } from './GenesisUpload.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── ModelSharder Tests ────────────────────────────────────────────────

describe('ModelSharder', () => {
    it('should create shard plan for 32-layer model', () => {
        const sharder = new ModelSharder({ targetShardSizeBytes: 500_000_000 });
        const plan = sharder.createPlan({
            modelId: 'test-7b',
            numLayers: 32,
            hiddenDim: 4096,
            totalSizeBytes: 3_500_000_000, // ~3.5GB
        });

        assert.ok(plan.length >= 2, `Should split into multiple shards, got ${plan.length}`);
        assert.equal(plan[0].modelId, 'test-7b');
        assert.ok(plan[0].shardId.includes('shard-000'));
        // All layers covered
        assert.equal(plan[0].layerRange[0], 0);
        assert.equal(plan[plan.length - 1].layerRange[1], 31);
    });

    it('should produce more shards for larger models', () => {
        const sharder = new ModelSharder({ targetShardSizeBytes: 500_000_000 });
        const small = sharder.createPlan({ modelId: 's', numLayers: 16, hiddenDim: 2048 });
        const large = sharder.createPlan({ modelId: 'l', numLayers: 80, hiddenDim: 8192 });
        assert.ok(large.length > small.length);
    });

    it('should detect model format', () => {
        const sharder = new ModelSharder();
        assert.equal(sharder.detectFormat(new Uint8Array([0x47, 0x47, 0x55, 0x46])), 'gguf');
        assert.equal(sharder.detectFormat(new Uint8Array([0x7B, 0x22])), 'safetensors');
        assert.equal(sharder.detectFormat(new Uint8Array([0x08, 0x00])), 'onnx');
        assert.equal(sharder.detectFormat(new Uint8Array([0xFF, 0xFF])), 'unknown');
    });

    it('should compute SHA-256 checksum', () => {
        const sharder = new ModelSharder();
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const hash = sharder.computeChecksum(data);
        assert.equal(hash.length, 64);
        // Deterministic
        assert.equal(hash, sharder.computeChecksum(data));
    });

    it('should throw on invalid manifest', () => {
        const sharder = new ModelSharder();
        assert.throws(() => sharder.createPlan({ name: 'no-id' }), /requires modelId/);
    });
});

// ── ModelCatalog Tests ────────────────────────────────────────────────

describe('ModelCatalog', () => {
    it('should register and retrieve models', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({
            modelId: 'llama-8b',
            name: 'Llama 3.1 8B',
            family: 'llama',
            paramCount: 8e9,
            tags: ['chat', 'reasoning'],
        });

        const model = catalog.getModel('llama-8b');
        assert.ok(model);
        assert.equal(model.name, 'Llama 3.1 8B');
        assert.equal(catalog.modelCount, 1);
    });

    it('should search by name and tags', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({ modelId: 'm1', name: 'Code Llama 7B', family: 'llama', paramCount: 7e9, tags: ['code'] });
        catalog.registerModel({ modelId: 'm2', name: 'Mistral 7B', family: 'mistral', paramCount: 7e9, tags: ['chat'] });
        catalog.registerModel({ modelId: 'm3', name: 'DeepSeek Coder', family: 'deepseek', paramCount: 16e9, tags: ['code'] });

        const codeModels = catalog.search('code');
        assert.equal(codeModels.length, 2);

        const mistral = catalog.search('mistral');
        assert.equal(mistral.length, 1);
    });

    it('should filter by family', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({ modelId: 'm1', name: 'A', family: 'llama', paramCount: 1e9 });
        catalog.registerModel({ modelId: 'm2', name: 'B', family: 'llama', paramCount: 7e9 });
        catalog.registerModel({ modelId: 'm3', name: 'C', family: 'mistral', paramCount: 7e9 });

        assert.equal(catalog.filterByFamily('llama').length, 2);
        assert.equal(catalog.filterByFamily('mistral').length, 1);
    });

    it('should rank popular models', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({ modelId: 'm1', name: 'A', family: 'x', paramCount: 1e9 });
        catalog.registerModel({ modelId: 'm2', name: 'B', family: 'x', paramCount: 1e9 });

        // m2 gets more inferences
        catalog.incrementInferences('m2');
        catalog.incrementInferences('m2');
        catalog.incrementInferences('m2');
        catalog.incrementInferences('m1');

        const popular = catalog.getPopular(2);
        assert.equal(popular[0].modelId, 'm2');
    });

    it('should attach shards and update count', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({ modelId: 'm1', name: 'A', family: 'x', paramCount: 1e9 });
        catalog.attachShards('m1', [
            { shardId: 's0', layerRange: [0, 7] },
            { shardId: 's1', layerRange: [8, 15] },
        ]);

        assert.equal(catalog.getModel('m1').shardCount, 2);
        assert.equal(catalog.getShards('m1').length, 2);
    });

    it('should export as JSON', () => {
        const catalog = new ModelCatalog();
        catalog.registerModel({ modelId: 'm1', name: 'A', family: 'x', paramCount: 1e9 });
        const json = catalog.toJSON();
        assert.equal(json.totalModels, 1);
        assert.ok(json.exportedAt > 0);
    });
});

// ── GenesisUpload Tests ───────────────────────────────────────────────

describe('GenesisUpload', () => {
    it('should have 40+ genesis models defined', () => {
        assert.ok(GENESIS_MODELS.length >= 40, `Expected 40+, got ${GENESIS_MODELS.length}`);
    });

    it('should register all genesis models in catalog', () => {
        const catalog = new ModelCatalog();
        const sharder = new ModelSharder({ targetShardSizeBytes: 500_000_000 });
        const uploader = new GenesisUpload({ catalog, sharder });

        const result = uploader.registerAll();
        assert.equal(result.modelsRegistered, GENESIS_MODELS.length);
        assert.ok(result.totalShards > GENESIS_MODELS.length, 'Should have more shards than models');
        assert.ok(result.families.length >= 10, `At least 10 families, got ${result.families.length}`);
    });

    it('should cover diverse model families', () => {
        const stats = GenesisUpload.getStats();
        assert.ok(stats.families.includes('llama'));
        assert.ok(stats.families.includes('mistral'));
        assert.ok(stats.families.includes('qwen'));
        assert.ok(stats.families.includes('deepseek'));
        assert.ok(stats.families.includes('phi'));
        assert.ok(stats.families.includes('gemma'));
    });

    it('should include code, vision, audio, and reasoning models', () => {
        const tags = GENESIS_MODELS.flatMap(m => m.tags);
        assert.ok(tags.includes('code'));
        assert.ok(tags.includes('vision'));
        assert.ok(tags.includes('audio'));
        assert.ok(tags.includes('reasoning'));
    });

    it('should search registered genesis models', () => {
        const catalog = new ModelCatalog();
        const sharder = new ModelSharder();
        const uploader = new GenesisUpload({ catalog, sharder });
        uploader.registerAll();

        const codeModels = catalog.search('code');
        assert.ok(codeModels.length >= 4, `Expected 4+ code models, got ${codeModels.length}`);

        const deepseek = catalog.filterByFamily('deepseek');
        assert.ok(deepseek.length >= 3);
    });
});
