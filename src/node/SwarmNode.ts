import type { NodeConfig } from '../types/index.js';
import type { SubmitOptions } from '../swarm/SwarmOrchestrator.js';
import { createLogger } from '../utils/logger.js';
import { OrbitDbManagerBuilder } from '../core/OrbitDbManager.js';
import type { OrbitDbManager } from '../core/OrbitDbManager.js';
import { OllamaClientBuilder } from '../llm/OllamaClient.js';
import type { OllamaClient } from '../llm/OllamaClient.js';
import { CryptoManager } from '../crypto/CryptoManager.js';
import { TaskStore } from '../store/TaskStore.js';
import { OrbitDbStore, InMemoryStore } from '../store/OrbitDbStore.js';
import { Worker } from '../swarm/Worker.js';
import { SwarmOrchestrator } from '../swarm/SwarmOrchestrator.js';
import { LocalWallet } from '../identity/LocalWallet.js';
import { ModelRegistry } from '../registry/ModelRegistry.js';
import { ModelRouter } from '../routing/ModelRouter.js';
import { ContributionTracker } from '../token/ContributionTracker.js';
import { TokenLedger } from '../token/TokenLedger.js';
import { AutoBalancer } from '../routing/AutoBalancer.js';
import type winston from 'winston';

/**
 * SwarmNode — composes all modules into a single running P2P inference node.
 * Acts as both Producer (submits tasks) and Consumer (runs inference).
 *
 * Integrates:
 *   - OrbitDB (P2P persistence)
 *   - Ollama (local inference)
 *   - LocalWallet (Ed25519 identity + CDI earnings)
 *   - ModelRegistry (model catalog, persistent)
 *   - ModelRouter (load-aware routing)
 *   - ContributionTracker (85/15 reward split)
 *   - AutoBalancer (network self-balancing)
 *   - TokenLedger (CDI balances, persistent)
 */
export class SwarmNode {
    private constructor(
        private readonly orbitDbManager: OrbitDbManager,
        private readonly ollamaClient: OllamaClient,
        private readonly cryptoManager: CryptoManager,
        private readonly taskStore: TaskStore,
        private readonly worker: Worker,
        private readonly orchestrator: SwarmOrchestrator,
        private readonly _wallet: LocalWallet,
        private readonly _modelRegistry: ModelRegistry,
        private readonly _modelRouter: ModelRouter,
        private readonly _contributionTracker: ContributionTracker,
        private readonly _ledger: TokenLedger,
        private readonly _autoBalancer: AutoBalancer,
        private readonly logger: winston.Logger,
    ) { }

    /** Wallet identity for this node */
    get wallet(): LocalWallet { return this._wallet; }
    /** Model catalog */
    get modelRegistry(): ModelRegistry { return this._modelRegistry; }
    /** Load-aware router */
    get modelRouter(): ModelRouter { return this._modelRouter; }
    /** Contribution tracker (royalties) */
    get contributionTracker(): ContributionTracker { return this._contributionTracker; }
    /** CDI ledger */
    get ledger(): TokenLedger { return this._ledger; }
    /** Auto-balancer */
    get autoBalancer(): AutoBalancer { return this._autoBalancer; }

    /**
     * Factory: wires up all dependencies and returns a running node.
     */
    static async create(config: NodeConfig): Promise<SwarmNode> {
        const logger = createLogger(config.logLevel, config.nodeId ?? 'swarm-node');

        // 1. LocalWallet — load or generate identity
        const walletDir = config.walletDir; // optional: defaults to ~/.cdi
        const wallet = LocalWallet.loadOrGenerate(walletDir);
        const peerId = wallet.peerId;
        logger.info(`Wallet loaded`, { peerId: peerId.slice(0, 16) + '...' });

        // 2. OrbitDB + Helia + libp2p
        const builder = new OrbitDbManagerBuilder().withDirectory(config.orbitDbDirectory);
        if (config.listenAddresses?.length) {
            builder.withListenAddresses(config.listenAddresses);
        }
        if (config.bootstrapPeers?.length) {
            builder.withBootstrapPeers(config.bootstrapPeers);
        }
        const orbitDbManager = await builder.build();

        // 3. Persistent stores via OrbitDB
        const ledgerStore = await OrbitDbStore.create(orbitDbManager, 'cdi-ledger');
        const registryStore = await OrbitDbStore.create(orbitDbManager, 'model-registry');

        // 4. Core components
        const ollamaClient = new OllamaClientBuilder()
            .withHost(config.ollamaHost)
            .withPort(config.ollamaPort)
            .build();

        const cryptoManager = new CryptoManager();
        const taskStore = new TaskStore(orbitDbManager);
        await taskStore.initialize();

        // 5. Model management
        const modelRegistry = new ModelRegistry(registryStore);
        const modelRouter = new ModelRouter();
        const contributionTracker = new ContributionTracker(modelRegistry);
        const autoBalancer = new AutoBalancer();

        // 6. Token economy
        const ledger = new TokenLedger(ledgerStore);

        // 7. Worker
        const worker = new Worker(taskStore as any, ollamaClient as any, {
            peerId,
            models: config.models,
            maxConcurrent: config.maxConcurrentTasks,
        });

        // 8. SwarmOrchestrator
        const orchestrator = new SwarmOrchestrator(taskStore as any, cryptoManager as any, {
            peerId,
            defaultModel: config.models[0],
        });

        // Start the worker
        worker.start();

        logger.info(`SwarmNode ready`, {
            peerId: peerId.slice(0, 16) + '...',
            models: config.models,
            listenAddresses: config.listenAddresses,
        });

        return new SwarmNode(
            orbitDbManager,
            ollamaClient,
            cryptoManager,
            taskStore,
            worker,
            orchestrator,
            wallet,
            modelRegistry,
            modelRouter,
            contributionTracker,
            ledger,
            autoBalancer,
            logger,
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
     * Get the peer ID (wallet address) of this node.
     */
    getPeerId(): string {
        return this._wallet.peerId;
    }

    /**
     * Get CDI balance for this node.
     */
    async getBalance(): Promise<number> {
        return this.ledger.getBalance(this._wallet.peerId);
    }

    /**
     * Gracefully shuts down all subsystems.
     */
    async shutdown(): Promise<void> {
        this.logger.info('Shutting down...');
        this.worker.stop();
        await this.taskStore.close();
        await this.orbitDbManager.stop();
        this.logger.info('SwarmNode stopped');
    }
}
