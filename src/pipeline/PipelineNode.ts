/**
 * PipelineNode — Docker-ready standalone process that:
 * 1. Creates a LayerServer with a simulated compute function
 * 2. Wraps it in an ActivationRelayServer for WebSocket access
 * 3. Registers itself with a PipelineRegistry
 * 4. Responds to health checks
 *
 * Config via constructor or env vars:
 *   NODE_ID, START_LAYER, END_LAYER, LISTEN_PORT, HMAC_SECRET
 */

import { LayerServer, type ComputeFn } from './LayerServer.js';
import { ActivationRelayServer } from './ActivationRelay.js';
import type { NodeRegistration } from './PipelineRegistry.js';

export interface PipelineNodeConfig {
    nodeId: string;
    startLayer: number;
    endLayer: number;
    port: number;
    hmacSecret: string;
    computeFn?: ComputeFn;
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

    constructor(config: PipelineNodeConfig) {
        this.config = config;

        this.layerServer = new LayerServer({
            nodeId: config.nodeId,
            startLayer: config.startLayer,
            endLayer: config.endLayer,
            computeFn: config.computeFn ?? defaultComputeFn,
        });

        this.registration = {
            nodeId: config.nodeId,
            peerId: config.nodeId, // In Docker, use nodeId as peerId
            host: '0.0.0.0',
            port: config.port,
            startLayer: config.startLayer,
            endLayer: config.endLayer,
            model: 'simulated',
            status: 'offline' as const,
        };
    }

    /**
     * Start the relay server and register with the pipeline.
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

        return this.address;
    }

    /**
     * Gracefully stop the node.
     */
    async stop(): Promise<void> {
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
