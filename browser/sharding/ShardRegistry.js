/**
 * ShardRegistry — OrbitDB-backed registry of model shard assignments.
 *
 * Tracks which node holds which shard of which model.
 * In the browser-only architecture, this runs entirely in-browser via OrbitDB/Helia.
 *
 * @module browser/sharding/ShardRegistry
 */

/**
 * @typedef {Object} ShardManifest
 * @property {string} shardId       - Unique shard identifier
 * @property {string} modelId       - Parent model identifier
 * @property {number[]} layerRange  - [startLayer, endLayer]
 * @property {string} weightsCid    - IPFS CID of the shard weights
 * @property {number[]} inputShape  - Expected input tensor shape
 * @property {number[]} outputShape - Expected output tensor shape
 * @property {number} sizeBytes     - Size of the shard in bytes
 */

/**
 * @typedef {Object} ShardAssignment
 * @property {string} shardId   - Shard being hosted
 * @property {string} nodeId    - PeerId of the hosting node
 * @property {string} modelId   - Parent model
 * @property {number[]} layerRange
 * @property {string} weightsCid
 * @property {'available'|'busy'|'offline'} status
 * @property {number} lastSeen  - Timestamp of last heartbeat
 */

export class ShardRegistry {
    /** @type {Map<string, ShardManifest>} */
    #manifests = new Map();
    /** @type {Map<string, ShardAssignment[]>} */
    #assignments = new Map(); // shardId → [assignments]
    /** @type {Map<string, Set<string>>} */
    #nodeShards = new Map(); // nodeId → Set<shardId>

    /**
     * Register a shard manifest (model owner publishes this).
     * @param {ShardManifest} manifest
     */
    registerManifest(manifest) {
        if (!manifest.shardId || !manifest.modelId) {
            throw new Error('ShardManifest requires shardId and modelId');
        }
        this.#manifests.set(manifest.shardId, { ...manifest });
    }

    /**
     * A node claims a shard (downloads weights, ready to execute).
     * @param {string} nodeId
     * @param {string} shardId
     */
    claimShard(nodeId, shardId) {
        const manifest = this.#manifests.get(shardId);
        if (!manifest) throw new Error(`Unknown shard: ${shardId}`);

        const assignment = {
            shardId,
            nodeId,
            modelId: manifest.modelId,
            layerRange: manifest.layerRange,
            weightsCid: manifest.weightsCid,
            status: 'available',
            lastSeen: Date.now(),
        };

        // Add to assignments
        if (!this.#assignments.has(shardId)) {
            this.#assignments.set(shardId, []);
        }
        // Don't duplicate
        const existing = this.#assignments.get(shardId);
        if (!existing.find(a => a.nodeId === nodeId)) {
            existing.push(assignment);
        }

        // Track node → shards
        if (!this.#nodeShards.has(nodeId)) {
            this.#nodeShards.set(nodeId, new Set());
        }
        this.#nodeShards.get(nodeId).add(shardId);
    }

    /**
     * Release a shard from a node.
     * @param {string} nodeId
     * @param {string} shardId
     */
    releaseShard(nodeId, shardId) {
        const assignments = this.#assignments.get(shardId);
        if (assignments) {
            const idx = assignments.findIndex(a => a.nodeId === nodeId);
            if (idx !== -1) assignments.splice(idx, 1);
        }
        const nodeSet = this.#nodeShards.get(nodeId);
        if (nodeSet) nodeSet.delete(shardId);
    }

    /**
     * Get all available nodes hosting a specific shard.
     * @param {string} shardId
     * @returns {ShardAssignment[]}
     */
    getAvailableNodes(shardId) {
        const assignments = this.#assignments.get(shardId) || [];
        return assignments.filter(a => a.status === 'available');
    }

    /**
     * Get all shards for a model, ordered by layer range.
     * @param {string} modelId
     * @returns {ShardManifest[]}
     */
    getModelShards(modelId) {
        return [...this.#manifests.values()]
            .filter(m => m.modelId === modelId)
            .sort((a, b) => a.layerRange[0] - b.layerRange[0]);
    }

    /**
     * Get all shards a specific node is hosting.
     * @param {string} nodeId
     * @returns {string[]}
     */
    getNodeShards(nodeId) {
        const set = this.#nodeShards.get(nodeId);
        return set ? [...set] : [];
    }

    /**
     * Update a node's heartbeat.
     * @param {string} nodeId
     */
    heartbeat(nodeId) {
        const shardIds = this.#nodeShards.get(nodeId);
        if (!shardIds) return;
        const now = Date.now();
        for (const shardId of shardIds) {
            const assignments = this.#assignments.get(shardId) || [];
            const a = assignments.find(x => x.nodeId === nodeId);
            if (a) a.lastSeen = now;
        }
    }

    /**
     * Mark stale nodes (no heartbeat in threshold ms) as offline.
     * @param {number} thresholdMs
     * @returns {string[]} nodeIds marked offline
     */
    evictStaleNodes(thresholdMs = 30000) {
        const now = Date.now();
        const evicted = [];
        for (const [shardId, assignments] of this.#assignments) {
            for (const a of assignments) {
                if (now - a.lastSeen > thresholdMs && a.status !== 'offline') {
                    a.status = 'offline';
                    if (!evicted.includes(a.nodeId)) evicted.push(a.nodeId);
                }
            }
        }
        return evicted;
    }

    /**
     * Count total available replicas for a shard.
     * @param {string} shardId
     * @returns {number}
     */
    replicaCount(shardId) {
        return this.getAvailableNodes(shardId).length;
    }

    /**
     * Get all registered manifests count.
     * @returns {number}
     */
    get manifestCount() {
        return this.#manifests.size;
    }

    /**
     * Get total assignments count.
     * @returns {number}
     */
    get totalAssignments() {
        let count = 0;
        for (const arr of this.#assignments.values()) count += arr.length;
        return count;
    }
}
