/**
 * PipelineNode v2 — Docker-ready standalone process that supports:
 *
 * COMPUTE_MODE:
 *   - 'simulated' (default): deterministic scale-factor computation
 *   - 'ollama': real LLM inference via OllamaComputeAdapter
 *
 * REGISTRY_MODE:
 *   - 'none' (default): no peer discovery
 *   - 'orbitdb': real P2P registry via OrbitDB + libp2p
 *
 * Config via constructor or env vars:
 *   NODE_ID, START_LAYER, END_LAYER, LISTEN_PORT, HMAC_SECRET,
 *   COMPUTE_MODE, OLLAMA_HOST, OLLAMA_PORT, OLLAMA_MODEL,
 *   REGISTRY_MODE, ORBITDB_DIR, BOOTSTRAP_PEERS
 */

import { LayerServer, type ComputeFn } from './LayerServer.js';
import { ActivationRelayServer } from './ActivationRelay.js';
import { OllamaComputeAdapter } from './OllamaComputeAdapter.js';
import type { NodeRegistration } from './PipelineRegistry.js';

export type ComputeMode = 'simulated' | 'ollama';
export type RegistryMode = 'none' | 'orbitdb';

export interface PipelineNodeConfig {
    nodeId: string;
    startLayer: number;
    endLayer: number;
    port: number;
    hmacSecret: string;
    computeFn?: ComputeFn;
    computeMode?: ComputeMode;
    registryMode?: RegistryMode;
    ollamaHost?: string;
    ollamaPort?: number;
    ollamaModel?: string;
    orbitDbDir?: string;
    bootstrapPeers?: string[];
}

/**
 * Default compute function: simulates layer processing by scaling
 * each value by (1 + layerIdx * 0.01). Deterministic and verifiable.
 */
const defaultComputeFn: ComputeFn = (input: Float32Array, layerIdx: number): Float32Array => {
    const scale = 1 + layerIdx * 0.01;
    const output = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
        output[i] = input[i] * scale;
    }
    return output;
};

export class PipelineNode {
    private readonly config: PipelineNodeConfig;
    private relayServer: ActivationRelayServer | null = null;
    private layerServer: LayerServer;
    private running = false;
    private address = '';
    private registration: NodeRegistration;
    private orbitDbManager: any = null; // Lazy loaded for orbitdb mode
    private pipelineRegistry: any = null;

    constructor(config: PipelineNodeConfig) {
        this.config = config;

        const computeMode = config.computeMode ?? 'simulated';
        const computeFn = config.computeFn ?? this.resolveComputeFn(computeMode);

        this.layerServer = new LayerServer({
            nodeId: config.nodeId,
            startLayer: config.startLayer,
            endLayer: config.endLayer,
            computeFn,
        });

        this.registration = {
            nodeId: config.nodeId,
            peerId: config.nodeId,
            host: '0.0.0.0',
            port: config.port,
            startLayer: config.startLayer,
            endLayer: config.endLayer,
            model: computeMode === 'ollama' ? (config.ollamaModel ?? 'tinyllama') : 'simulated',
            status: 'offline' as const,
        };
    }

    /**
     * Resolve the ComputeFn based on COMPUTE_MODE.
     */
    private resolveComputeFn(mode: ComputeMode): ComputeFn {
        if (mode === 'ollama') {
            const adapter = new OllamaComputeAdapter({
                host: this.config.ollamaHost ?? '127.0.0.1',
                port: this.config.ollamaPort ?? 11434,
                model: this.config.ollamaModel ?? 'tinyllama',
            });
            return adapter.toComputeFn();
        }
        return defaultComputeFn;
    }

    /**
     * Start the relay server and optionally register with OrbitDB.
     * Returns the WebSocket address.
     */
    async start(): Promise<string> {
        this.relayServer = new ActivationRelayServer({
            port: this.config.port,
            layerServer: this.layerServer,
            hmacSecret: this.config.hmacSecret,
        });

        this.address = await this.relayServer.listen();
        this.running = true;

        // Parse actual assigned port from address
        const portMatch = this.address.match(/:(\d+)$/);
        if (portMatch) {
            this.registration.port = parseInt(portMatch[1], 10);
        }
        this.registration.host = '127.0.0.1';
        this.registration.status = 'online';

        // OrbitDB self-registration
        const registryMode = this.config.registryMode ?? 'none';
        if (registryMode === 'orbitdb') {
            await this.initOrbitDbRegistry();
        }

        return this.address;
    }

    /**
     * Initialize OrbitDB and self-register with the PipelineRegistry.
     */
    private async initOrbitDbRegistry(): Promise<void> {
        const { OrbitDbManagerBuilder } = await import('../core/OrbitDbManager.js');
        const { PipelineRegistry } = await import('./PipelineRegistry.js');

        const builder = new OrbitDbManagerBuilder()
            .withDirectory(this.config.orbitDbDir ?? `./orbitdb/${this.config.nodeId}`);

        if (this.config.bootstrapPeers?.length) {
            builder.withBootstrapPeers(this.config.bootstrapPeers);
        }

        this.orbitDbManager = await builder.build();
        const registryStore = await this.orbitDbManager.openKeyValueDb('pipeline-registry');

        // Adapt OrbitDB KV store to RegistryStore interface
        const storeAdapter = {
            put: async (entry: any) => await registryStore.put(entry._id ?? entry.nodeId, entry),
            get: async (id: string) => await registryStore.get(id),
            del: async (id: string) => await registryStore.del(id),
            all: async () => {
                const entries: any[] = [];
                for await (const entry of registryStore.iterator()) {
                    entries.push({ key: entry.key, value: entry.value });
                }
                return entries;
            },
        };

        this.pipelineRegistry = new PipelineRegistry(storeAdapter);

        // Self-register
        const peerId = this.orbitDbManager.getPeerId();
        this.registration.peerId = peerId;

        await this.pipelineRegistry.registerNode({
            nodeId: this.config.nodeId,
            peerId,
            host: this.registration.host,
            port: this.registration.port,
            startLayer: this.config.startLayer,
            endLayer: this.config.endLayer,
            model: this.registration.model,
        });

        console.log(JSON.stringify({
            event: 'orbitdb_registered',
            nodeId: this.config.nodeId,
            peerId,
        }));
    }

    /**
     * Gracefully stop the node.
     */
    async stop(): Promise<void> {
        // Unregister from OrbitDB if active
        if (this.pipelineRegistry) {
            try {
                await this.pipelineRegistry.unregisterNode(this.config.nodeId);
            } catch { /* best effort */ }
        }
        if (this.orbitDbManager) {
            try {
                await this.orbitDbManager.stop();
            } catch { /* best effort */ }
            this.orbitDbManager = null;
            this.pipelineRegistry = null;
        }

        if (this.relayServer) {
            await this.relayServer.close();
            this.relayServer = null;
        }
        this.running = false;
        this.registration.status = 'offline';
    }

    isRunning(): boolean {
        return this.running;
    }

    getAddress(): string {
        return this.address;
    }

    getRegistration(): NodeRegistration {
        return { ...this.registration };
    }

    getComputeMode(): ComputeMode {
        return this.config.computeMode ?? 'simulated';
    }

    getRegistryMode(): RegistryMode {
        return this.config.registryMode ?? 'none';
    }

    /**
     * Create a PipelineNode from environment variables.
     */
    static fromEnv(): PipelineNode {
        return new PipelineNode({
            nodeId: process.env.NODE_ID ?? `node-${process.pid}`,
            startLayer: parseInt(process.env.START_LAYER ?? '0', 10),
            endLayer: parseInt(process.env.END_LAYER ?? '9', 10),
            port: parseInt(process.env.LISTEN_PORT ?? '9000', 10),
            hmacSecret: process.env.HMAC_SECRET ?? 'default-secret',
            computeMode: (process.env.COMPUTE_MODE as ComputeMode) ?? 'simulated',
            registryMode: (process.env.REGISTRY_MODE as RegistryMode) ?? 'none',
            ollamaHost: process.env.OLLAMA_HOST,
            ollamaPort: process.env.OLLAMA_PORT ? parseInt(process.env.OLLAMA_PORT, 10) : undefined,
            ollamaModel: process.env.OLLAMA_MODEL,
            orbitDbDir: process.env.ORBITDB_DIR,
            bootstrapPeers: process.env.BOOTSTRAP_PEERS
                ? process.env.BOOTSTRAP_PEERS.split(',')
                : [],
        });
    }
}

/**
 * Standalone entry point for Docker containers.
 * Run with: node dist/pipeline/PipelineNode.js
 */
if (process.argv[1]?.endsWith('PipelineNode.js')) {
    const node = PipelineNode.fromEnv();
    node.start().then((addr) => {
        const reg = node.getRegistration();
        console.log(JSON.stringify({
            event: 'node_started',
            address: addr,
            nodeId: reg.nodeId,
            layers: `${reg.startLayer}-${reg.endLayer}`,
            computeMode: node.getComputeMode(),
            registryMode: node.getRegistryMode(),
            model: reg.model,
        }));
    }).catch((err) => {
        console.error('Failed to start PipelineNode:', err);
        process.exit(1);
    });

    process.on('SIGTERM', async () => {
        console.log(JSON.stringify({ event: 'node_stopping', nodeId: process.env.NODE_ID }));
        await node.stop();
        process.exit(0);
    });

    process.on('SIGINT', async () => {
        await node.stop();
        process.exit(0);
    });
}
