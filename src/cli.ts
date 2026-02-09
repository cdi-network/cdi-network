#!/usr/bin/env node

import fs from 'fs';
import { SwarmNode } from './node/SwarmNode.js';
import type { NodeConfig } from './types/index.js';

const DEFAULT_CONFIG: NodeConfig = {
    ollamaHost: '127.0.0.1',
    ollamaPort: 11434,
    orbitDbDirectory: './orbitdb',
    bootstrapPeers: [],
    listenAddresses: ['/ip4/0.0.0.0/tcp/0'],
    models: ['tinyllama'],
    maxConcurrentTasks: 2,
    logLevel: 'info',
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
Usage:
  swarm start [--config config.json]       Start a swarm node
  swarm submit "prompt text" [--model m]   Submit inference task
  swarm status <taskId>                    Check task status
  swarm result <taskId>                    Get result
        `.trim());
        process.exit(0);
    }

    if (command === 'start') {
        const configIdx = args.indexOf('--config');
        const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;
        const config = loadConfig(configPath);

        const node = await SwarmNode.create(config);
        console.log(`Swarm node started. PeerId: ${node.getPeerId()}`);

        // Keep alive
        process.on('SIGINT', async () => {
            console.log('\nShutting down...');
            await node.shutdown();
            process.exit(0);
        });

        process.on('SIGTERM', async () => {
            await node.shutdown();
            process.exit(0);
        });

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

    if (command === 'status' || command === 'result') {
        console.error(`Command '${command}' requires a running node. Use 'swarm start' first.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
