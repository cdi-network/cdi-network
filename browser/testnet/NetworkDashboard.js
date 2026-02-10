/**
 * NetworkDashboard — Aggregated network stats for community dashboard.
 *
 * Combines data from HealthMonitor, LedgerStore, ShardRegistry,
 * and AutoBalancer into a single dashboard state.
 *
 * @module browser/testnet/NetworkDashboard
 */

/**
 * @typedef {Object} DashboardState
 * @property {number} nodeCount
 * @property {number} shardCount
 * @property {number} healthScore
 * @property {number} totalInferences
 * @property {number} circulatingSupply
 * @property {{ p50: number, p95: number, p99: number }} latency
 * @property {{ healthy: number, degraded: number, offline: number }} nodeStatus
 * @property {number} uptime         - Network uptime in seconds
 * @property {number} modelsAvailable
 */

export class NetworkDashboard {
    #healthMonitor;
    #ledgerStore;
    #shardRegistry;
    #startTime;

    /**
     * @param {Object} deps
     * @param {import('./HealthMonitor.js').HealthMonitor} deps.healthMonitor
     * @param {import('../storage/LedgerStore.js').LedgerStore} [deps.ledgerStore]
     * @param {import('../sharding/ShardRegistry.js').ShardRegistry} [deps.shardRegistry]
     */
    constructor({ healthMonitor, ledgerStore = null, shardRegistry = null } = {}) {
        if (!healthMonitor) throw new Error('NetworkDashboard requires healthMonitor');
        this.#healthMonitor = healthMonitor;
        this.#ledgerStore = ledgerStore;
        this.#shardRegistry = shardRegistry;
        this.#startTime = Date.now();
    }

    /**
     * Get full dashboard state snapshot.
     * @returns {DashboardState}
     */
    getState() {
        const health = this.#healthMonitor.getNetworkHealth();
        const throughput = this.#healthMonitor.getThroughput();
        const latency = this.#healthMonitor.getLatencyPercentiles();

        return {
            nodeCount: health.totalNodes,
            shardCount: this.#shardRegistry ? this.#shardRegistry.shardCount : 0,
            healthScore: health.score,
            totalInferences: throughput.totalInferences,
            circulatingSupply: this.#ledgerStore ? this.#ledgerStore.circulatingSupply : 0,
            latency,
            nodeStatus: {
                healthy: health.healthy,
                degraded: health.degraded,
                offline: health.offline,
            },
            uptime: Math.floor((Date.now() - this.#startTime) / 1000),
            modelsAvailable: this.#shardRegistry
                ? new Set(this.#shardRegistry.getAllManifests().map(m => m.modelId)).size
                : 0,
        };
    }

    /**
     * Get summary string for logging/display.
     * @returns {string}
     */
    getSummary() {
        const s = this.getState();
        return [
            `🌐 CDI Network Dashboard`,
            `  Nodes: ${s.nodeCount} (✅${s.nodeStatus.healthy} ⚠️${s.nodeStatus.degraded} ❌${s.nodeStatus.offline})`,
            `  Health: ${s.healthScore}/100`,
            `  Shards: ${s.shardCount} | Models: ${s.modelsAvailable}`,
            `  Inferences: ${s.totalInferences} | P50: ${s.latency.p50}ms | P95: ${s.latency.p95}ms`,
            `  CDI Supply: ${s.circulatingSupply.toLocaleString()}`,
            `  Uptime: ${s.uptime}s`,
        ].join('\n');
    }
}
