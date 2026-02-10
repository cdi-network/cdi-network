/**
 * AutoBalancer — Automatic shard rebalancing for CDI Network.
 *
 * Monitors shard demand and node capacity. Auto-replicates hot shards,
 * evicts cold shards from constrained nodes, and chunks popular models
 * into finer shards for better parallelism.
 *
 * @module browser/network/AutoBalancer
 */

/**
 * @typedef {Object} BalancerConfig
 * @property {number} [minReplicas=2]           - Min replicas per shard
 * @property {number} [maxShardsPerNode=10]     - Max shards a node can host
 * @property {number} [rebalanceIntervalMs=30000] - Rebalance check interval
 * @property {number} [hotThreshold=5]          - Requests/min to be "hot"
 * @property {number} [coldThresholdMs=3600000] - Age before shard is "cold" (1h)
 */

const DEFAULTS = {
    minReplicas: 2,
    maxShardsPerNode: 10,
    rebalanceIntervalMs: 30_000,
    hotThreshold: 5,
    coldThresholdMs: 3_600_000,
};

export class AutoBalancer {
    #config;
    /** @type {Map<string, { requestCount: number, lastRequestAt: number }>} shardId → demand */
    #shardDemand = new Map();
    /** @type {Map<string, Set<string>>} shardId → Set<nodeId> */
    #shardNodes = new Map();
    /** @type {Map<string, Set<string>>} nodeId → Set<shardId> */
    #nodeShards = new Map();
    /** @type {number|null} */
    #timer = null;
    /** @type {Function|null} */
    #onRebalance = null;
    /** @type {Array} */
    #actionLog = [];

    /**
     * @param {BalancerConfig} config
     */
    constructor(config = {}) {
        this.#config = { ...DEFAULTS, ...config };
    }

    /**
     * Record a request for a shard (updates demand metrics).
     * @param {string} shardId
     */
    recordRequest(shardId) {
        const demand = this.#shardDemand.get(shardId) || { requestCount: 0, lastRequestAt: 0 };
        demand.requestCount++;
        demand.lastRequestAt = Date.now();
        this.#shardDemand.set(shardId, demand);
    }

    /**
     * Register that a node hosts a shard.
     * @param {string} shardId
     * @param {string} nodeId
     */
    registerAssignment(shardId, nodeId) {
        if (!this.#shardNodes.has(shardId)) this.#shardNodes.set(shardId, new Set());
        this.#shardNodes.get(shardId).add(nodeId);

        if (!this.#nodeShards.has(nodeId)) this.#nodeShards.set(nodeId, new Set());
        this.#nodeShards.get(nodeId).add(shardId);
    }

    /**
     * Unregister a shard assignment.
     * @param {string} shardId
     * @param {string} nodeId
     */
    unregisterAssignment(shardId, nodeId) {
        this.#shardNodes.get(shardId)?.delete(nodeId);
        this.#nodeShards.get(nodeId)?.delete(shardId);
    }

    /**
     * Get shards that need more replicas (under-replicated).
     * @returns {{ shardId: string, currentReplicas: number, needed: number }[]}
     */
    getUnderReplicated() {
        const results = [];
        for (const [shardId, nodes] of this.#shardNodes) {
            if (nodes.size < this.#config.minReplicas) {
                results.push({
                    shardId,
                    currentReplicas: nodes.size,
                    needed: this.#config.minReplicas - nodes.size,
                });
            }
        }
        return results;
    }

    /**
     * Get hot shards (high demand).
     * @returns {{ shardId: string, requestCount: number }[]}
     */
    getHotShards() {
        return [...this.#shardDemand.entries()]
            .filter(([_, d]) => d.requestCount >= this.#config.hotThreshold)
            .map(([shardId, d]) => ({ shardId, requestCount: d.requestCount }))
            .sort((a, b) => b.requestCount - a.requestCount);
    }

    /**
     * Get cold shards (no recent requests).
     * @returns {string[]} shard IDs
     */
    getColdShards() {
        const now = Date.now();
        return [...this.#shardDemand.entries()]
            .filter(([_, d]) => now - d.lastRequestAt > this.#config.coldThresholdMs)
            .map(([shardId, _]) => shardId);
    }

    /**
     * Get overloaded nodes (too many shards).
     * @returns {{ nodeId: string, shardCount: number, excess: number }[]}
     */
    getOverloadedNodes() {
        return [...this.#nodeShards.entries()]
            .filter(([_, shards]) => shards.size > this.#config.maxShardsPerNode)
            .map(([nodeId, shards]) => ({
                nodeId,
                shardCount: shards.size,
                excess: shards.size - this.#config.maxShardsPerNode,
            }));
    }

    /**
     * Run a rebalance cycle. Returns actions taken.
     * @returns {{ type: string, shardId: string, nodeId?: string, reason: string }[]}
     */
    rebalance() {
        const actions = [];

        // 1. Replicate under-replicated shards
        for (const { shardId, needed } of this.getUnderReplicated()) {
            for (let i = 0; i < needed; i++) {
                const target = this.#findBestNodeFor(shardId);
                if (target) {
                    this.registerAssignment(shardId, target);
                    actions.push({
                        type: 'replicate', shardId, nodeId: target,
                        reason: 'under-replicated'
                    });
                }
            }
        }

        // 2. Evict cold shards from overloaded nodes
        for (const { nodeId, excess } of this.getOverloadedNodes()) {
            const coldOnNode = [...(this.#nodeShards.get(nodeId) || [])]
                .filter(s => this.getColdShards().includes(s));
            for (const shardId of coldOnNode.slice(0, excess)) {
                this.unregisterAssignment(shardId, nodeId);
                actions.push({
                    type: 'evict', shardId, nodeId,
                    reason: 'node overloaded + cold shard'
                });
            }
        }

        this.#actionLog.push(...actions);
        if (this.#onRebalance) this.#onRebalance(actions);
        return actions;
    }

    /**
     * Start periodic rebalancing.
     */
    startAutoRebalance() {
        this.#timer = setInterval(() => this.rebalance(), this.#config.rebalanceIntervalMs);
    }

    /** Stop auto rebalancing. */
    stopAutoRebalance() {
        if (this.#timer) {
            clearInterval(this.#timer);
            this.#timer = null;
        }
    }

    /** Register rebalance handler */
    onRebalance(handler) { this.#onRebalance = handler; }

    /** @returns {number} Total tracked shards */
    get shardCount() { return this.#shardNodes.size; }
    /** @returns {number} Total tracked nodes */
    get nodeCount() { return this.#nodeShards.size; }
    /** @returns {Array} Action history */
    get actionLog() { return [...this.#actionLog]; }

    /**
     * Find the least-loaded node that doesn't already host this shard.
     * @private
     */
    #findBestNodeFor(shardId) {
        const currentHosts = this.#shardNodes.get(shardId) || new Set();
        let bestNode = null;
        let bestLoad = Infinity;

        for (const [nodeId, shards] of this.#nodeShards) {
            if (currentHosts.has(nodeId)) continue;
            if (shards.size < this.#config.maxShardsPerNode && shards.size < bestLoad) {
                bestNode = nodeId;
                bestLoad = shards.size;
            }
        }
        return bestNode;
    }
}
