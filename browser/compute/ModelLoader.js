/**
 * ModelLoader — Parse model manifests, split into shards, upload to IPFS.
 *
 * @module browser/compute/ModelLoader
 */

/**
 * @typedef {Object} ModelManifest
 * @property {string} modelId
 * @property {string} name
 * @property {string} family         - e.g. 'llama', 'mistral', 'qwen'
 * @property {number} paramCount     - Total parameters (e.g. 7_000_000_000)
 * @property {number} hiddenDim      - Hidden dimension
 * @property {number} numLayers      - Total transformer layers
 * @property {number} numHeads       - Attention heads
 * @property {string} format         - 'safetensors' | 'onnx' | 'gguf'
 */

/**
 * @typedef {Object} ShardSpec
 * @property {string} shardId
 * @property {string} modelId
 * @property {number[]} layerRange
 * @property {number} sizeBytes
 * @property {string|null} cid       - Assigned after upload
 */

export class ModelLoader {
    /** @type {number} Target shard size in bytes */
    #targetShardSize;

    /**
     * @param {Object} opts
     * @param {number} [opts.targetShardSizeBytes=500_000_000] - ~500MB per shard
     */
    constructor({ targetShardSizeBytes = 500_000_000 } = {}) {
        this.#targetShardSize = targetShardSizeBytes;
    }

    /**
     * Split a model into shard specifications based on layer ranges.
     *
     * @param {ModelManifest} manifest
     * @returns {ShardSpec[]}
     */
    createShardPlan(manifest) {
        if (!manifest.modelId || !manifest.numLayers) {
            throw new Error('ModelManifest requires modelId and numLayers');
        }

        const bytesPerLayer = this.#estimateBytesPerLayer(manifest);
        const layersPerShard = Math.max(1, Math.floor(this.#targetShardSize / bytesPerLayer));

        const shards = [];
        let layerIdx = 0;
        let shardIdx = 0;

        while (layerIdx < manifest.numLayers) {
            const startLayer = layerIdx;
            const endLayer = Math.min(layerIdx + layersPerShard - 1, manifest.numLayers - 1);
            const layerCount = endLayer - startLayer + 1;

            shards.push({
                shardId: `${manifest.modelId}-shard-${shardIdx}`,
                modelId: manifest.modelId,
                layerRange: [startLayer, endLayer],
                sizeBytes: layerCount * bytesPerLayer,
                cid: null,
            });

            layerIdx = endLayer + 1;
            shardIdx++;
        }

        return shards;
    }

    /**
     * Upload shard data to Helia and register in ShardRegistry.
     *
     * @param {ShardSpec} shard
     * @param {Uint8Array} weightData
     * @param {import('../storage/HeliaManager.js').HeliaManager} helia
     * @param {import('../sharding/ShardRegistry.js').ShardRegistry} registry
     * @returns {Promise<string>} CID
     */
    async uploadShard(shard, weightData, helia, registry) {
        const cid = await helia.addShard(weightData);
        shard.cid = cid;

        registry.registerManifest({
            shardId: shard.shardId,
            modelId: shard.modelId,
            layerRange: shard.layerRange,
            cid,
            sizeBytes: shard.sizeBytes,
        });

        return cid;
    }

    /**
     * Estimate bytes per transformer layer.
     * @private
     * @param {ModelManifest} manifest
     * @returns {number}
     */
    #estimateBytesPerLayer(manifest) {
        // Rough estimate: each layer has 4 * hidden_dim^2 params (Q, K, V, O) + FFN (8 * hidden_dim^2)
        // Total per layer ≈ 12 * hidden_dim^2 * 2 bytes (fp16) or 4 bytes (fp32)
        const dim = manifest.hiddenDim || 4096;
        const paramsPerLayer = 12 * dim * dim;
        return paramsPerLayer * 2; // fp16
    }

    /** @returns {number} Target shard size in bytes */
    get targetShardSize() { return this.#targetShardSize; }
}
