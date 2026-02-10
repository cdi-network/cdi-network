/**
 * HealthMonitor — Real-time network health monitoring.
 *
 * Tracks node heartbeats, shard availability, inference latencies,
 * and produces a health score for the network dashboard.
 *
 * @module browser/testnet/HealthMonitor
 */

/**
 * @typedef {Object} NodeHealth
 * @property {string} nodeId
 * @property {number} lastHeartbeat
 * @property {number} avgLatencyMs
 * @property {number} inferenceCount
 * @property {number} errorRate
 * @property {string} status - 'healthy' | 'degraded' | 'offline'
 */

const HEARTBEAT_INTERVAL_MS = 15_000;
const OFFLINE_THRESHOLD_MS = 45_000;
const DEGRADED_LATENCY_MS = 5_000;

export class HealthMonitor {
    /** @type {Map<string, NodeHealth>} */
    #nodes = new Map();
    /** @type {number[]} */
    #latencyHistory = [];
    /** @type {number} */
    #totalInferences = 0;
    /** @type {number} */
    #totalErrors = 0;
    /** @type {number|null} */
    #checkTimer = null;
    /** @type {Function|null} */
    #onAlert = null;
    /** @type {Array<{timestamp: number, type: string, message: string}>} */
    #alerts = [];

    constructor() { }

    /**
     * Record a node heartbeat.
     * @param {string} nodeId
     * @param {{ latencyMs?: number, inferenceCount?: number, errorRate?: number }} metrics
     */
    heartbeat(nodeId, metrics = {}) {
        const existing = this.#nodes.get(nodeId) || {
            nodeId,
            lastHeartbeat: 0,
            avgLatencyMs: 0,
            inferenceCount: 0,
            errorRate: 0,
            status: 'healthy',
        };

        existing.lastHeartbeat = Date.now();
        if (metrics.latencyMs != null) {
            // Exponential moving average
            existing.avgLatencyMs = existing.avgLatencyMs * 0.7 + metrics.latencyMs * 0.3;
            this.#latencyHistory.push(metrics.latencyMs);
            if (this.#latencyHistory.length > 1000) this.#latencyHistory.shift();
        }
        if (metrics.inferenceCount != null) {
            this.#totalInferences += metrics.inferenceCount;
            existing.inferenceCount += metrics.inferenceCount;
        }
        if (metrics.errorRate != null) {
            existing.errorRate = metrics.errorRate;
        }

        existing.status = this.#computeStatus(existing);
        this.#nodes.set(nodeId, existing);
    }

    /**
     * Record an inference result.
     * @param {{ latencyMs: number, success: boolean, nodeId: string }}
     */
    recordInference({ latencyMs, success, nodeId }) {
        this.#totalInferences++;
        if (!success) this.#totalErrors++;

        this.heartbeat(nodeId, { latencyMs, inferenceCount: 1 });
    }

    /**
     * Check all nodes and generate alerts for offline/degraded.
     * @returns {NodeHealth[]}
     */
    checkHealth() {
        const now = Date.now();
        const alerts = [];

        for (const [nodeId, node] of this.#nodes) {
            const prevStatus = node.status;
            node.status = this.#computeStatus(node);

            if (node.status !== prevStatus) {
                const alert = {
                    timestamp: now,
                    type: node.status === 'offline' ? 'critical' : 'warning',
                    message: `Node ${nodeId}: ${prevStatus} → ${node.status}`,
                };
                this.#alerts.push(alert);
                alerts.push(alert);
                if (this.#onAlert) this.#onAlert(alert);
            }
        }

        return [...this.#nodes.values()];
    }

    /**
     * Get overall network health score (0-100).
     * @returns {{ score: number, totalNodes: number, healthy: number, degraded: number, offline: number }}
     */
    getNetworkHealth() {
        const nodes = [...this.#nodes.values()];
        const healthy = nodes.filter(n => n.status === 'healthy').length;
        const degraded = nodes.filter(n => n.status === 'degraded').length;
        const offline = nodes.filter(n => n.status === 'offline').length;
        const total = nodes.length || 1;

        // Score: 100% if all healthy, -25 per degraded ratio, -50 per offline ratio
        const score = Math.max(0, Math.round(
            100 * (healthy / total) - 25 * (degraded / total) - 50 * (offline / total)
        ));

        return { score, totalNodes: nodes.length, healthy, degraded, offline };
    }

    /**
     * Get P50/P95/P99 latency percentiles.
     * @returns {{ p50: number, p95: number, p99: number }}
     */
    getLatencyPercentiles() {
        if (this.#latencyHistory.length === 0) {
            return { p50: 0, p95: 0, p99: 0 };
        }
        const sorted = [...this.#latencyHistory].sort((a, b) => a - b);
        const p = (pct) => sorted[Math.floor(sorted.length * pct)] || 0;
        return { p50: p(0.5), p95: p(0.95), p99: p(0.99) };
    }

    /**
     * Get throughput metrics.
     * @returns {{ totalInferences: number, totalErrors: number, errorRate: number }}
     */
    getThroughput() {
        return {
            totalInferences: this.#totalInferences,
            totalErrors: this.#totalErrors,
            errorRate: this.#totalInferences > 0
                ? this.#totalErrors / this.#totalInferences
                : 0,
        };
    }

    /** Start periodic health checks */
    startMonitoring(intervalMs = HEARTBEAT_INTERVAL_MS) {
        this.#checkTimer = setInterval(() => this.checkHealth(), intervalMs);
    }

    /** Stop monitoring */
    stopMonitoring() {
        if (this.#checkTimer) {
            clearInterval(this.#checkTimer);
            this.#checkTimer = null;
        }
    }

    /** Register alert handler */
    onAlert(handler) { this.#onAlert = handler; }

    /** @returns {Array} Alert history */
    get alerts() { return [...this.#alerts]; }
    /** @returns {number} Node count */
    get nodeCount() { return this.#nodes.size; }

    /** @private */
    #computeStatus(node) {
        const now = Date.now();
        if (now - node.lastHeartbeat > OFFLINE_THRESHOLD_MS) return 'offline';
        if (node.avgLatencyMs > DEGRADED_LATENCY_MS) return 'degraded';
        if (node.errorRate > 0.2) return 'degraded';
        return 'healthy';
    }
}
