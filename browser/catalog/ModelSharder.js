/**
 * ModelSharder — Split model files into CDI network shards.
 *
 * Supports SafeTensors, ONNX, and GGUF formats.
 * Produces shard specs with CIDs after upload to Helia.
 *
 * @module browser/catalog/ModelSharder
 */

import { createHash } from '../crypto-browser.js';

/**
 * @typedef {Object} ShardOutput
 * @property {string} shardId
 * @property {string} modelId
 * @property {number[]} layerRange
 * @property {number} sizeBytes
 * @property {string|null} cid
 * @property {string} checksum - SHA-256 of shard data
 */

const FORMAT_SIGNATURES = {
    safetensors: { magic: [0x7B], headerKey: '__metadata__' },
    onnx: { magic: [0x08, 0x00], headerKey: 'ir_version' },
    gguf: { magic: [0x47, 0x47, 0x55, 0x46], headerKey: 'gguf' },
};

export class ModelSharder {
    /** @type {number} Target bytes per shard */
    #targetShardSize;
    /** @type {string} */
    #format;

    /**
     * @param {Object} opts
     * @param {number} [opts.targetShardSizeBytes=256_000_000] - ~256MB per shard
     * @param {'safetensors'|'onnx'|'gguf'|'auto'} [opts.format='auto']
     */
    constructor({ targetShardSizeBytes = 256_000_000, format = 'auto' } = {}) {
        this.#targetShardSize = targetShardSizeBytes;
        this.#format = format;
    }

    /**
     * Detect model format from file header.
     * @param {Uint8Array} data - First bytes of file
     * @returns {'safetensors'|'onnx'|'gguf'|'unknown'}
     */
    detectFormat(data) {
        if (data[0] === 0x47 && data[1] === 0x47 && data[2] === 0x55 && data[3] === 0x46) {
            return 'gguf';
        }
        if (data[0] === 0x08) return 'onnx';
        if (data[0] === 0x7B) return 'safetensors'; // JSON header
        return 'unknown';
    }

    /**
     * Create a sharding plan for a model.
     *
     * @param {Object} manifest
     * @param {string} manifest.modelId
     * @param {number} manifest.totalSizeBytes
     * @param {number} manifest.numLayers
     * @param {number} [manifest.hiddenDim=4096]
     * @returns {ShardOutput[]}
     */
    createPlan(manifest) {
        if (!manifest.modelId || !manifest.numLayers) {
            throw new Error('Manifest requires modelId and numLayers');
        }

        const totalSize = manifest.totalSizeBytes || (manifest.numLayers * this.#estimateLayerSize(manifest));
        const bytesPerLayer = totalSize / manifest.numLayers;
        const layersPerShard = Math.max(1, Math.floor(this.#targetShardSize / bytesPerLayer));

        const shards = [];
        let layerIdx = 0;
        let shardIdx = 0;

        while (layerIdx < manifest.numLayers) {
            const startLayer = layerIdx;
            const endLayer = Math.min(layerIdx + layersPerShard - 1, manifest.numLayers - 1);
            const layerCount = endLayer - startLayer + 1;

            shards.push({
                shardId: `${manifest.modelId}-shard-${String(shardIdx).padStart(3, '0')}`,
                modelId: manifest.modelId,
                layerRange: [startLayer, endLayer],
                sizeBytes: Math.round(layerCount * bytesPerLayer),
                cid: null,
                checksum: null,
            });

            layerIdx = endLayer + 1;
            shardIdx++;
        }

        return shards;
    }

    /**
     * Compute checksum for a shard data blob.
     * @param {Uint8Array} data
     * @returns {string} SHA-256 hex
     */
    computeChecksum(data) {
        return createHash('sha256').update(data).digest('hex');
    }

    /**
     * @private
     * @param {Object} manifest
     * @returns {number} estimated bytes per layer
     */
    #estimateLayerSize(manifest) {
        const dim = manifest.hiddenDim || 4096;
        return 12 * dim * dim * 2; // fp16: Q,K,V,O + FFN ≈ 12 * d^2 * 2 bytes
    }

    /** @returns {number} */
    get targetShardSize() { return this.#targetShardSize; }
}
