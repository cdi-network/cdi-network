/**
 * DistributedPipeline — Orchestrate multi-node inference via TabMesh encrypted relay.
 *
 * Creates a pipeline of stages, each assigned to a node.
 * Local stages execute via ShardedInferenceEngine.
 * Remote stages relay activations via TabMesh E2E encrypted channels.
 *
 * @module browser/llm/DistributedPipeline
 */

interface PipelineStage {
    nodeId: string;
    layerRange: [number, number];
}

interface TabMeshLike {
    nodeId: string;
    sendEncrypted(peerId: string, type: string, payload: any): Promise<void>;
    onMessage(type: string, handler: (payload: any, fromPeer: string) => void): void;
}

interface ShardedEngineLike {
    forward(input: Float32Array): Promise<Float32Array>;
    isReady: boolean;
}

interface DistributedPipelineOpts {
    mesh: TabMeshLike;
    localEngine?: ShardedEngineLike;
}

export class DistributedPipeline {
    private mesh: TabMeshLike;
    private localEngine: ShardedEngineLike | null;
    private _stages: PipelineStage[] = [];
    private activationHandlers: Array<(activations: Float32Array) => Promise<void>> = [];

    constructor(opts: DistributedPipelineOpts) {
        this.mesh = opts.mesh;
        this.localEngine = opts.localEngine || null;

        // Listen for incoming activations from remote peers
        this.mesh.onMessage('activations', async (payload: any, fromPeer: string) => {
            const activations = new Float32Array(payload.data);
            for (const handler of this.activationHandlers) {
                await handler(activations);
            }
        });
    }

    /** Add a pipeline stage (node + layer range). Stages execute in order. */
    addStage(stage: PipelineStage): void {
        this._stages.push(stage);
    }

    /** Execute a specific stage. If local, use ShardedInferenceEngine. */
    async executeStage(stageIdx: number, input: Float32Array): Promise<Float32Array | null> {
        const stage = this._stages[stageIdx];
        if (!stage) throw new Error(`Stage ${stageIdx} not found`);

        if (stage.nodeId === this.mesh.nodeId && this.localEngine) {
            // Local execution
            return await this.localEngine.forward(input);
        }

        // Remote: send activations and wait for response
        await this.sendActivations(stage.nodeId, input);
        return null; // Async — result comes via activation handler
    }

    /** Send activation tensor to a remote peer via encrypted relay */
    async sendActivations(peerId: string, activations: Float32Array): Promise<void> {
        await this.mesh.sendEncrypted(peerId, 'activations', {
            data: Array.from(activations),
            timestamp: Date.now(),
        });
    }

    /** Register handler for incoming activations from remote peers */
    onActivationsReceived(handler: (activations: Float32Array) => Promise<void>): void {
        this.activationHandlers.push(handler);
    }

    get stages(): PipelineStage[] { return [...this._stages]; }
    get stageCount(): number { return this._stages.length; }
}
