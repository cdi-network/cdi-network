/**
 * AutoBalancer — Network self-balancing engine.
 *
 * Monitors model usage patterns and node loads, then produces
 * BalanceActions to keep the network optimally distributed:
 *
 *   - Replicate: popular model on overloaded node → copy to idle node
 *   - Evict: unused model → free VRAM for popular models
 *   - Migrate: least-popular model from overloaded node → idle node
 *
 * Also tracks progressive model pulls (download progress).
 */

/** Action types for network rebalancing */
export interface BalanceAction {
    type: 'replicate' | 'evict' | 'migrate';
    modelId: string;
    fromNode?: string;
    toNode: string;
    reason: string;
}

export interface ModelUsageStats {
    modelId: string;
    totalInferences: number;
    nodeDistribution: Map<string, number>; // nodeId → count
}

/** Thresholds */
const OVERLOAD_THRESHOLD = 0.8;
const EVICTION_MIN_INFERENCES = 1;   // models with 0 usage → evict candidates

/** Internal: node load per model */
interface NodeModelLoad {
    nodeId: string;
    modelId: string;
    load: number;
}

/** Internal: pull tracking */
interface PullState {
    progress: number;  // 0.0 - 1.0
    startedAt: number;
}

export class AutoBalancer {
    /** Usage counters per model */
    private readonly usage = new Map<string, ModelUsageStats>();
    /** Node loads: nodeId → modelId → load */
    private readonly nodeLoads = new Map<string, Map<string, number>>();
    /** Active pulls: "nodeId:modelId" → PullState */
    private readonly pulls = new Map<string, PullState>();

    /**
     * Record an inference on a model by a node.
     */
    recordUsage(modelId: string, nodeId: string): void {
        if (!this.usage.has(modelId)) {
            this.usage.set(modelId, {
                modelId,
                totalInferences: 0,
                nodeDistribution: new Map(),
            });
        }
        const stats = this.usage.get(modelId)!;
        stats.totalInferences++;
        stats.nodeDistribution.set(
            nodeId,
            (stats.nodeDistribution.get(nodeId) ?? 0) + 1,
        );
    }

    /**
     * Report a node's load for a specific model.
     */
    reportNodeLoad(nodeId: string, modelId: string, load: number): void {
        if (!this.nodeLoads.has(nodeId)) {
            this.nodeLoads.set(nodeId, new Map());
        }
        this.nodeLoads.get(nodeId)!.set(modelId, load);
    }

    /**
     * Get usage stats for a model.
     */
    getUsageStats(modelId: string): ModelUsageStats | null {
        return this.usage.get(modelId) ?? null;
    }

    /**
     * Evaluate the current network state and produce balance actions.
     */
    evaluate(): BalanceAction[] {
        const actions: BalanceAction[] = [];

        // Collect all node-model loads
        const allLoads: NodeModelLoad[] = [];
        for (const [nodeId, models] of this.nodeLoads) {
            for (const [modelId, load] of models) {
                allLoads.push({ nodeId, modelId, load });
            }
        }

        // Find idle nodes (average load < OVERLOAD_THRESHOLD)
        const nodeAvgLoad = new Map<string, number>();
        for (const [nodeId, models] of this.nodeLoads) {
            const loads = [...models.values()];
            const avg = loads.reduce((s, l) => s + l, 0) / loads.length;
            nodeAvgLoad.set(nodeId, avg);
        }

        const idleNodes = [...nodeAvgLoad.entries()]
            .filter(([, load]) => load < OVERLOAD_THRESHOLD)
            .sort((a, b) => a[1] - b[1])  // least loaded first
            .map(([nodeId]) => nodeId);

        // 1. REPLICATION: overloaded models → copy to idle nodes
        for (const nml of allLoads) {
            if (nml.load > OVERLOAD_THRESHOLD) {
                const stats = this.usage.get(nml.modelId);
                if (stats && stats.totalInferences > 0) {
                    // Find an idle node that doesn't already serve this model
                    const target = idleNodes.find(n => {
                        const models = this.nodeLoads.get(n);
                        return n !== nml.nodeId && (!models || !models.has(nml.modelId));
                    });
                    if (target) {
                        actions.push({
                            type: 'replicate',
                            modelId: nml.modelId,
                            fromNode: nml.nodeId,
                            toNode: target,
                            reason: `Model "${nml.modelId}" overloaded (${(nml.load * 100).toFixed(0)}%) on ${nml.nodeId}`,
                        });
                    }
                }
            }
        }

        // 2. EVICTION: unused models → free resources
        for (const nml of allLoads) {
            const stats = this.usage.get(nml.modelId);
            if (!stats || stats.totalInferences < EVICTION_MIN_INFERENCES) {
                actions.push({
                    type: 'evict',
                    modelId: nml.modelId,
                    toNode: nml.nodeId,
                    reason: `Model "${nml.modelId}" has 0 inferences, candidate for eviction`,
                });
            }
        }

        // 3. MIGRATION: overloaded node → move least-popular model to idle node
        for (const [nodeId, avgLoad] of nodeAvgLoad) {
            if (avgLoad >= 0.9) {
                const models = this.nodeLoads.get(nodeId)!;
                // Find least-popular model on this node
                let leastPopular: string | null = null;
                let leastUsage = Infinity;

                for (const modelId of models.keys()) {
                    const stats = this.usage.get(modelId);
                    const count = stats?.totalInferences ?? 0;
                    if (count < leastUsage) {
                        leastUsage = count;
                        leastPopular = modelId;
                    }
                }

                if (leastPopular && idleNodes.length > 0) {
                    const target = idleNodes.find(n => n !== nodeId);
                    if (target) {
                        // Avoid duplicating replication actions
                        const alreadyReplicated = actions.some(
                            a => a.modelId === leastPopular && a.type === 'replicate',
                        );
                        if (!alreadyReplicated) {
                            actions.push({
                                type: 'migrate',
                                modelId: leastPopular,
                                fromNode: nodeId,
                                toNode: target,
                                reason: `Node ${nodeId} overloaded (avg ${(avgLoad * 100).toFixed(0)}%), migrating least-popular model "${leastPopular}"`,
                            });
                        }
                    }
                }
            }
        }

        return actions;
    }

    // ── Progressive Model Pull Tracking ──────────────────

    startModelPull(nodeId: string, modelId: string): void {
        this.pulls.set(`${nodeId}:${modelId}`, { progress: 0, startedAt: Date.now() });
    }

    updatePullProgress(nodeId: string, modelId: string, progress: number): void {
        const state = this.pulls.get(`${nodeId}:${modelId}`);
        if (state) {
            state.progress = Math.min(progress, 1.0);
        }
    }

    completePull(nodeId: string, modelId: string): void {
        this.pulls.delete(`${nodeId}:${modelId}`);
    }

    isPulling(nodeId: string, modelId: string): boolean {
        return this.pulls.has(`${nodeId}:${modelId}`);
    }

    getPullProgress(nodeId: string, modelId: string): number {
        return this.pulls.get(`${nodeId}:${modelId}`)?.progress ?? 0;
    }
}
