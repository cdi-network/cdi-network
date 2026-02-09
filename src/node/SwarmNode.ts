import type { NodeConfig } from '../types/index.js';
import type { SubmitOptions } from '../swarm/SwarmOrchestrator.js';
import { createLogger } from '../utils/logger.js';
import { OrbitDbManagerBuilder } from '../core/OrbitDbManager.js';
import type { OrbitDbManager } from '../core/OrbitDbManager.js';
import { OllamaClientBuilder } from '../llm/OllamaClient.js';
import type { OllamaClient } from '../llm/OllamaClient.js';
import { CryptoManager } from '../crypto/CryptoManager.js';
import { TaskStore } from '../store/TaskStore.js';
import { Worker } from '../swarm/Worker.js';
import { SwarmOrchestrator } from '../swarm/SwarmOrchestrator.js';

/**
 * SwarmNode — composes all modules into a single running P2P inference node.
 * Acts as both Producer (submits tasks) and Consumer (runs inference).
 */
export class SwarmNode {
    private constructor(
        private readonly orbitDbManager: OrbitDbManager,
        private readonly ollamaClient: OllamaClient,
        private readonly cryptoManager: CryptoManager,
        private readonly taskStore: TaskStore,
        private readonly worker: Worker,
        private readonly orchestrator: SwarmOrchestrator,
        private readonly peerId: string,
    ) { }

    /**
     * Factory: wires up all dependencies and returns a running node.
     */
    static async create(config: NodeConfig): Promise<SwarmNode> {
        const logger = createLogger(config.logLevel, config.nodeId ?? 'swarm-node');

        // 1. OrbitDB + Helia + libp2p
        const builder = new OrbitDbManagerBuilder().withDirectory(config.orbitDbDirectory);
        if (config.listenAddresses?.length) {
            builder.withListenAddresses(config.listenAddresses);
        }
        if (config.bootstrapPeers?.length) {
            builder.withBootstrapPeers(config.bootstrapPeers);
        }
        const orbitDbManager = await builder.build();

        // 2. OllamaClient
        const ollamaClient = new OllamaClientBuilder()
            .withHost(config.ollamaHost)
            .withPort(config.ollamaPort)
            .build();

        // 3. CryptoManager
        const cryptoManager = new CryptoManager();

        // 4. TaskStore
        const taskStore = new TaskStore(orbitDbManager);
        await taskStore.initialize();

        const peerId = orbitDbManager.getPeerId();

        // 5. Worker
        const worker = new Worker(taskStore as any, ollamaClient as any, {
            peerId,
            models: config.models,
            maxConcurrent: config.maxConcurrentTasks,
        });

        // 6. SwarmOrchestrator
        const orchestrator = new SwarmOrchestrator(taskStore as any, cryptoManager as any, {
            peerId,
            defaultModel: config.models[0],
        });

        // Start the worker
        worker.start();

        logger.info(`SwarmNode ready`, { peerId, models: config.models });

        return new SwarmNode(
            orbitDbManager,
            ollamaClient,
            cryptoManager,
            taskStore,
            worker,
            orchestrator,
            peerId,
        );
    }

    /**
     * Submit a prompt for inference.
     */
    async submitPrompt(prompt: string, opts?: SubmitOptions): Promise<string> {
        return this.orchestrator.submitPrompt(prompt, opts);
    }

    /**
     * Get the aggregated result for a task.
     */
    async getResult(taskId: string): Promise<string> {
        return this.orchestrator.getResult(taskId);
    }

    /**
     * Get the peer ID of this node.
     */
    getPeerId(): string {
        return this.peerId;
    }

    /**
     * Gracefully shuts down all subsystems.
     */
    async shutdown(): Promise<void> {
        this.worker.stop();
        await this.taskStore.close();
        await this.orbitDbManager.stop();
    }
}
