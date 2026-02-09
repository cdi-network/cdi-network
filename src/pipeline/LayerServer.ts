import type { PipelineStage } from './types.js';

export type ComputeFn = (input: Float32Array, layerIdx: number) => Float32Array;

interface LayerServerConfig {
    nodeId: string;
    startLayer: number;
    endLayer: number;
    computeFn: ComputeFn;
}

/**
 * LayerServer — serves a contiguous range of transformer layers.
 * Each call to forward() runs the input through [startLayer..endLayer].
 */
export class LayerServer implements PipelineStage {
    readonly nodeId: string;
    private readonly startLayer: number;
    private readonly endLayer: number;
    private readonly computeFn: ComputeFn;

    constructor(config: LayerServerConfig) {
        this.nodeId = config.nodeId;
        this.startLayer = config.startLayer;
        this.endLayer = config.endLayer;
        this.computeFn = config.computeFn;
    }

    async forward(input: Float32Array): Promise<Float32Array> {
        let current = input;
        for (let layer = this.startLayer; layer <= this.endLayer; layer++) {
            current = this.computeFn(current, layer);
        }
        return current;
    }
}
