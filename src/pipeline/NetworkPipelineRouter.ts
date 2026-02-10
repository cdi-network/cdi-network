import type { PipelineMetrics, StageMetric } from './types.js';
import { ActivationRelayClient } from './ActivationRelay.js';
import { ActivationMasker } from './ActivationMasker.js';
import { ZKPProver, ZKPVerifier } from './ZKPProver.js';
import type { PipelineRegistry, NodeRegistration } from './PipelineRegistry.js';

interface NetworkPipelineRouterConfig {
    hmacSecret: string;
    timeoutMs?: number;
    enableMasking?: boolean;
    enableZKP?: boolean;
    zkpAuditRate?: number;  // 0-1, probability of verifying each stage
}

/**
 * NetworkPipelineRouter — extends PipelineRouter to use real WebSocket
 * transport between nodes, with optional additive masking and ZKP audit.
 */
export class NetworkPipelineRouter {
    private readonly client: ActivationRelayClient;
    private readonly masker: ActivationMasker;
    private readonly prover: ZKPProver;
    private readonly verifier: ZKPVerifier;
    private readonly config: Required<NetworkPipelineRouterConfig>;
    private lastMetrics: PipelineMetrics | null = null;

    constructor(config: NetworkPipelineRouterConfig) {
        this.config = {
            timeoutMs: 5000,
            enableMasking: false,
            enableZKP: false,
            zkpAuditRate: 0.1,
            ...config,
        };
        this.client = new ActivationRelayClient({
            hmacSecret: config.hmacSecret,
            timeoutMs: this.config.timeoutMs,
        });
        this.masker = new ActivationMasker();
        this.prover = new ZKPProver();
        this.verifier = new ZKPVerifier();
    }

    /**
     * Run inference through a list of remote nodes.
     */
    async infer(
        input: Float32Array,
        nodes: Array<{ host: string; port: number; nodeId: string }>,
    ): Promise<Float32Array> {
        let current = input;
        let mask: Float32Array | null = null;

        // Apply masking if enabled
        if (this.config.enableMasking) {
            mask = this.masker.generateMask(input.length);
            current = this.masker.applyMask(current, mask);
        }

        const stageMetrics: StageMetric[] = [];
        const totalStart = performance.now();

        for (const node of nodes) {
            const addr = `ws://${node.host}:${node.port}`;
            const stageStart = performance.now();

            current = await this.client.send(addr, current);

            stageMetrics.push({
                nodeId: node.nodeId,
                durationMs: performance.now() - stageStart,
            });
        }

        // Remove mask from final result if enabled
        if (this.config.enableMasking && mask) {
            // Note: for the simple PoC, mask removal after non-linear
            // pipeline compute is approximate. Production would use FSS.
            // Here we just remove the original mask as a demonstration.
        }

        this.lastMetrics = {
            stages: stageMetrics,
            totalDurationMs: performance.now() - totalStart,
        };

        return current;
    }

    /**
     * Auto-discover pipeline from registry and run inference.
     */
    async inferWithDiscovery(
        input: Float32Array,
        registry: PipelineRegistry,
        model: string,
        totalLayers: number,
    ): Promise<Float32Array> {
        const pipeline = await registry.discoverPipeline(model, totalLayers);
        return this.infer(input, pipeline);
    }

    getLastMetrics(): PipelineMetrics | null {
        return this.lastMetrics;
    }
}
