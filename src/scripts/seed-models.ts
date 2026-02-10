#!/usr/bin/env node

/**
 * seed-models.ts — Genesis model seeder.
 *
 * At testnet/mainnet launch, this script runs on the founder's local PC
 * to upload ALL popular open-weight models into the ModelRegistry.
 *
 * The local wallet becomes the "genesis uploader" and earns 9% royalties
 * on every inference against these models, forever.
 *
 * Usage:
 *   npx ts-node src/scripts/seed-models.ts [--wallet-dir ~/.cdi]
 */

import { LocalWallet } from '../identity/LocalWallet.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import { ContributionTracker } from '../token/ContributionTracker.js';
import { InMemoryStore } from '../store/OrbitDbStore.js';

/**
 * Open-weight models to seed as genesis.
 * These cover the major model families used by the community.
 */
const GENESIS_MODELS = [
    // ── Meta Llama ──────────────────
    { modelId: 'llama3.3:70b', family: 'llama3', variant: '70b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80 },
    { modelId: 'llama3.2:3b', family: 'llama3', variant: '3b', capabilities: ['chat'], parameterCount: 3e9, vramRequired: 2500, layerCount: 28 },
    { modelId: 'llama3.2:1b', family: 'llama3', variant: '1b', capabilities: ['chat'], parameterCount: 1e9, vramRequired: 1200, layerCount: 16 },
    { modelId: 'llama3.1:8b', family: 'llama3', variant: '8b', capabilities: ['chat', 'code'], parameterCount: 8e9, vramRequired: 6000, layerCount: 32 },
    { modelId: 'llama3.1:70b', family: 'llama3', variant: '70b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80 },
    { modelId: 'llama3.1:405b', family: 'llama3', variant: '405b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 405e9, vramRequired: 240000, layerCount: 126 },

    // ── DeepSeek ────────────────────
    { modelId: 'deepseek-r1:7b', family: 'deepseek', variant: '7b', capabilities: ['chat', 'reasoning'], parameterCount: 7e9, vramRequired: 5000, layerCount: 28 },
    { modelId: 'deepseek-r1:14b', family: 'deepseek', variant: '14b', capabilities: ['chat', 'reasoning'], parameterCount: 14e9, vramRequired: 10000, layerCount: 40 },
    { modelId: 'deepseek-r1:32b', family: 'deepseek', variant: '32b', capabilities: ['chat', 'reasoning', 'code'], parameterCount: 32e9, vramRequired: 20000, layerCount: 64 },
    { modelId: 'deepseek-r1:70b', family: 'deepseek', variant: '70b', capabilities: ['chat', 'reasoning', 'code'], parameterCount: 70e9, vramRequired: 40000, layerCount: 80 },
    { modelId: 'deepseek-r1:671b', family: 'deepseek', variant: '671b', capabilities: ['chat', 'reasoning', 'code', 'math'], parameterCount: 671e9, vramRequired: 400000, layerCount: 160 },
    { modelId: 'deepseek-v3:671b', family: 'deepseek', variant: '671b-v3', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 671e9, vramRequired: 400000, layerCount: 160 },

    // ── Qwen ────────────────────────
    { modelId: 'qwen2.5:0.5b', family: 'qwen', variant: '0.5b', capabilities: ['chat'], parameterCount: 0.5e9, vramRequired: 500, layerCount: 24 },
    { modelId: 'qwen2.5:7b', family: 'qwen', variant: '7b', capabilities: ['chat', 'code'], parameterCount: 7e9, vramRequired: 5000, layerCount: 28 },
    { modelId: 'qwen2.5:14b', family: 'qwen', variant: '14b', capabilities: ['chat', 'code'], parameterCount: 14e9, vramRequired: 10000, layerCount: 40 },
    { modelId: 'qwen2.5:32b', family: 'qwen', variant: '32b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 32e9, vramRequired: 20000, layerCount: 64 },
    { modelId: 'qwen2.5:72b', family: 'qwen', variant: '72b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 72e9, vramRequired: 42000, layerCount: 80 },
    { modelId: 'qwen2.5-coder:7b', family: 'qwen', variant: 'coder-7b', capabilities: ['code'], parameterCount: 7e9, vramRequired: 5000, layerCount: 28 },
    { modelId: 'qwen2.5-coder:32b', family: 'qwen', variant: 'coder-32b', capabilities: ['code'], parameterCount: 32e9, vramRequired: 20000, layerCount: 64 },
    { modelId: 'qwq:32b', family: 'qwen', variant: 'qwq-32b', capabilities: ['chat', 'reasoning', 'math'], parameterCount: 32e9, vramRequired: 20000, layerCount: 64 },

    // ── Mistral / Mixtral ───────────
    { modelId: 'mistral:7b', family: 'mistral', variant: '7b', capabilities: ['chat', 'code'], parameterCount: 7e9, vramRequired: 5000, layerCount: 32 },
    { modelId: 'mistral-small:24b', family: 'mistral', variant: 'small-24b', capabilities: ['chat', 'code'], parameterCount: 24e9, vramRequired: 16000, layerCount: 40 },
    { modelId: 'mixtral:8x7b', family: 'mixtral', variant: '8x7b', capabilities: ['chat', 'code'], parameterCount: 47e9, vramRequired: 28000, layerCount: 32 },
    { modelId: 'mixtral:8x22b', family: 'mixtral', variant: '8x22b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 141e9, vramRequired: 80000, layerCount: 56 },
    { modelId: 'codestral:22b', family: 'mistral', variant: 'codestral-22b', capabilities: ['code'], parameterCount: 22e9, vramRequired: 14000, layerCount: 40 },

    // ── Gemma (Google) ──────────────
    { modelId: 'gemma3:1b', family: 'gemma', variant: '1b', capabilities: ['chat'], parameterCount: 1e9, vramRequired: 1200, layerCount: 18 },
    { modelId: 'gemma3:4b', family: 'gemma', variant: '4b', capabilities: ['chat', 'vision'], parameterCount: 4e9, vramRequired: 3200, layerCount: 26 },
    { modelId: 'gemma3:12b', family: 'gemma', variant: '12b', capabilities: ['chat', 'vision'], parameterCount: 12e9, vramRequired: 8000, layerCount: 36 },
    { modelId: 'gemma3:27b', family: 'gemma', variant: '27b', capabilities: ['chat', 'vision', 'reasoning'], parameterCount: 27e9, vramRequired: 18000, layerCount: 46 },

    // ── Phi (Microsoft) ─────────────
    { modelId: 'phi4:14b', family: 'phi', variant: '14b', capabilities: ['chat', 'code', 'reasoning'], parameterCount: 14e9, vramRequired: 10000, layerCount: 40 },
    { modelId: 'phi3:3.8b', family: 'phi', variant: '3.8b', capabilities: ['chat'], parameterCount: 3.8e9, vramRequired: 3000, layerCount: 32 },

    // ── Small / Edge ────────────────
    { modelId: 'tinyllama:1.1b', family: 'tinyllama', variant: '1.1b', capabilities: ['chat'], parameterCount: 1.1e9, vramRequired: 1000, layerCount: 22 },
    { modelId: 'smollm2:135m', family: 'smollm', variant: '135m', capabilities: ['chat'], parameterCount: 135e6, vramRequired: 200, layerCount: 12 },
    { modelId: 'smollm2:1.7b', family: 'smollm', variant: '1.7b', capabilities: ['chat'], parameterCount: 1.7e9, vramRequired: 1400, layerCount: 24 },

    // ── Code Specialist ─────────────
    { modelId: 'starcoder2:3b', family: 'starcoder', variant: '3b', capabilities: ['code'], parameterCount: 3e9, vramRequired: 2500, layerCount: 30 },
    { modelId: 'starcoder2:7b', family: 'starcoder', variant: '7b', capabilities: ['code'], parameterCount: 7e9, vramRequired: 5000, layerCount: 32 },
    { modelId: 'starcoder2:15b', family: 'starcoder', variant: '15b', capabilities: ['code'], parameterCount: 15e9, vramRequired: 10000, layerCount: 40 },

    // ── Embedding ───────────────────
    { modelId: 'nomic-embed-text:v1.5', family: 'nomic', variant: 'embed-v1.5', capabilities: ['embedding'], parameterCount: 137e6, vramRequired: 300, layerCount: 12 },
    { modelId: 'mxbai-embed-large:335m', family: 'mxbai', variant: 'embed-large', capabilities: ['embedding'], parameterCount: 335e6, vramRequired: 500, layerCount: 24 },

    // ── Vision ──────────────────────
    { modelId: 'llava:7b', family: 'llava', variant: '7b', capabilities: ['chat', 'vision'], parameterCount: 7e9, vramRequired: 5500, layerCount: 32 },
    { modelId: 'llava:13b', family: 'llava', variant: '13b', capabilities: ['chat', 'vision'], parameterCount: 13e9, vramRequired: 9000, layerCount: 40 },
];

async function main() {
    const args = process.argv.slice(2);
    const walletDirIdx = args.indexOf('--wallet-dir');
    const walletDir = walletDirIdx !== -1 ? args[walletDirIdx + 1] : undefined;

    // Load or generate genesis wallet
    const wallet = LocalWallet.loadOrGenerate(walletDir);
    console.log(`\n🔑 Genesis wallet: ${wallet.peerId.slice(0, 16)}...`);
    console.log(`   Full address: ${wallet.peerId}`);

    // In-memory store for now (will be OrbitDB when run via SwarmNode)
    const store = new InMemoryStore();
    const registry = new ModelRegistry(store);
    const tracker = new ContributionTracker(registry);

    console.log(`\n📦 Seeding ${GENESIS_MODELS.length} open-weight models...\n`);

    let seeded = 0;
    for (const model of GENESIS_MODELS) {
        await registry.register({
            ...model,
            contributorId: wallet.peerId,
        });

        await tracker.registerContribution({
            contributorId: wallet.peerId,
            modelId: model.modelId,
            parentModelId: model.modelId,
            type: 'upload',
        });

        seeded++;
        const bar = '█'.repeat(Math.floor(seeded / GENESIS_MODELS.length * 30));
        const empty = '░'.repeat(30 - bar.length);
        process.stdout.write(`\r   [${bar}${empty}] ${seeded}/${GENESIS_MODELS.length} ${model.modelId}`);
    }

    console.log(`\n\n✅ ${seeded} models registered with genesis uploader ${wallet.peerId.slice(0, 16)}...`);
    console.log(`\n💰 Earnings: 9% of every inference fee on these models.`);
    console.log(`   (15% ecosystem × 60% uploader = 9% per inference)`);

    // Summary
    console.log(`\n📊 Model families seeded:`);
    const families = new Set(GENESIS_MODELS.map(m => m.family));
    for (const family of families) {
        const count = GENESIS_MODELS.filter(m => m.family === family).length;
        console.log(`   • ${family}: ${count} models`);
    }

    console.log(`\n🚀 Ready. Start a SwarmNode to make these models available on the network.`);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
