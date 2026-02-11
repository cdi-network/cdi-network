/**
 * ShardedInferenceEngine — Execute partial transformer layers via WebGPU.
 *
 * Each node loads only its assigned layers from a parsed GGUF file,
 * then executes forward passes through those layers sequentially.
 *
 * @module browser/llm/ShardedInferenceEngine
 */

interface TensorInfo {
    name: string;
    nDims: number;
    shape: number[];
    type: number;
    offset: number;
    byteSize: number;
}

interface ShardExecutor {
    execute(input: Float32Array, weights: Map<string, Uint8Array>): Promise<Float32Array>;
}

interface GGUFParserLike {
    getLayerTensors(idx: number): TensorInfo[];
    getTensorData(name: string): Uint8Array | null;
    layerCount: number;
}

interface ShardedEngineOpts {
    executor: ShardExecutor;
}

interface LayerWeights {
    layerIdx: number;
    weights: Map<string, Uint8Array>;
}

export class ShardedInferenceEngine {
    private executor: ShardExecutor;
    private layers: LayerWeights[] = [];
    private _layerRange: [number, number] | null = null;
    private _vramUsageBytes = 0;

    constructor(opts: ShardedEngineOpts) {
        this.executor = opts.executor;
    }

    /**
     * Load layers [startLayer, endLayer] (inclusive) from a parsed GGUF file.
     */
    async loadLayers(parser: GGUFParserLike, startLayer: number, endLayer: number): Promise<void> {
        this.layers = [];
        this._vramUsageBytes = 0;

        for (let idx = startLayer; idx <= endLayer; idx++) {
            const tensorInfos = parser.getLayerTensors(idx);
            const weights = new Map<string, Uint8Array>();

            for (const t of tensorInfos) {
                const data = parser.getTensorData(t.name);
                if (data) {
                    weights.set(t.name, data);
                    this._vramUsageBytes += data.byteLength;
                }
            }

            this.layers.push({ layerIdx: idx, weights });
        }

        this._layerRange = [startLayer, endLayer];
    }

    /**
     * Execute forward pass through all loaded layers sequentially.
     * Input activations flow through each layer in order.
     */
    async forward(input: Float32Array): Promise<Float32Array> {
        if (this.layers.length === 0) {
            throw new Error('No layers loaded');
        }

        let activations = input;

        for (const layer of this.layers) {
            activations = await this.executor.execute(activations, layer.weights);
        }

        return activations;
    }

    get layerRange(): [number, number] | null { return this._layerRange; }
    get loadedLayerCount(): number { return this.layers.length; }
    get isReady(): boolean { return this.layers.length > 0; }
    get vramUsageBytes(): number { return this._vramUsageBytes; }
}
