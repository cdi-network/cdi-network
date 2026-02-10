#!/usr/bin/env node

import fs from 'fs';
import { SwarmNode } from './node/SwarmNode.js';
import { ApiServer } from './api/ApiServer.js';
import type { NodeConfig } from './types/index.js';

const DEFAULT_CONFIG: NodeConfig = {
    ollamaHost: process.env.OLLAMA_HOST ?? '127.0.0.1',
    ollamaPort: parseInt(process.env.OLLAMA_PORT ?? '11434'),
    orbitDbDirectory: process.env.ORBITDB_DIR ?? './orbitdb',
    bootstrapPeers: process.env.BOOTSTRAP_PEERS?.split(',').filter(Boolean) ?? [],
    listenAddresses: ['/ip4/0.0.0.0/tcp/' + (process.env.LISTEN_PORT ?? '0')],
    models: (process.env.MODELS ?? 'tinyllama').split(','),
    maxConcurrentTasks: parseInt(process.env.MAX_CONCURRENT ?? '2'),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as NodeConfig['logLevel'],
    walletDir: process.env.WALLET_DIR,
    apiPort: parseInt(process.env.API_PORT ?? '3000'),
    nodeId: process.env.NODE_ID,
};

function loadConfig(configPath?: string): NodeConfig {
    if (!configPath) return DEFAULT_CONFIG;
    const raw = fs.readFileSync(configPath, 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    if (!command || command === 'help' || command === '--help') {
        console.log(`
CDI Network — Collaborative Distributed Inference

Usage:
  cdi start [--config config.json]       Start a swarm node + API server
  cdi submit "prompt text" [--model m]   Submit inference task
  cdi wallet                             Show wallet info
  cdi seed                               Seed genesis models (run once)
        `.trim());
        process.exit(0);
    }

    if (command === 'start') {
        const configIdx = args.indexOf('--config');
        const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
        const config = loadConfig(configPath);

        const node = await SwarmNode.create(config);
        const api = new ApiServer(node);
        await api.start(config.apiPort ?? 3000);

        console.log(`\n🚀 CDI Node started`);
        console.log(`   PeerId:  ${node.getPeerId().slice(0, 16)}...`);
        console.log(`   API:     http://localhost:${config.apiPort ?? 3000}`);
        console.log(`   Models:  ${config.models.join(', ')}`);

        // Graceful shutdown
        const shutdown = async () => {
            console.log('\n⏹️  Shutting down...');
            await api.stop();
            await node.shutdown();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);

        // Block forever
        await new Promise(() => { });
    }

    if (command === 'submit') {
        const prompt = args[1];
        if (!prompt) {
            console.error('Error: prompt text required');
            process.exit(1);
        }

        const modelIdx = args.indexOf('--model');
        const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;

        const configIdx = args.indexOf('--config');
        const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
        const config = loadConfig(configPath);

        const node = await SwarmNode.create(config);
        const taskId = await node.submitPrompt(prompt, model ? { model } : undefined);
        console.log(`Task submitted: ${taskId}`);

        await node.shutdown();
    }

    if (command === 'wallet') {
        const { LocalWallet } = await import('./identity/LocalWallet.js');
        const wallet = LocalWallet.loadOrGenerate(DEFAULT_CONFIG.walletDir);
        console.log(`\n🔑 CDI Wallet`);
        console.log(`   Address:  ${wallet.peerId}`);
        console.log(`   Saved at: ~/.cdi/wallet.json`);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
