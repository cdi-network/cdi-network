/**
 * ModelRouter — Load-aware routing per model.
 *
 * Routes inference requests to the best node for a given model based on
 * a weighted score combining: load (60%), latency (30%), free VRAM (10%).
 *
 * Also detects when auto-scaling is needed (all nodes > 90% load).
 */

export interface NodeLoad {
    nodeId: string;
    modelId: string;
    currentLoad: number;       // 0.0 - 1.0
    queueDepth: number;
    avgLatencyMs: number;      // rolling average
    vramFree: number;          // MB of free VRAM
}

/** Scoring weights */
const WEIGHT_LOAD = 0.6;
const WEIGHT_LATENCY = 0.3;
const WEIGHT_VRAM = 0.1;

/** Auto-scale threshold: if ALL nodes above this, signal scale-up */
const OVERLOAD_THRESHOLD = 0.9;

export class ModelRouter {
    /** model → nodeId → NodeLoad */
    private readonly loads = new Map<string, Map<string, NodeLoad>>();

    /**
     * Report (or update) a node's load for a specific model.
     */
    reportLoad(load: NodeLoad): void {
        if (!this.loads.has(load.modelId)) {
            this.loads.set(load.modelId, new Map());
        }
        this.loads.get(load.modelId)!.set(load.nodeId, load);
    }

    /**
     * Select the best node for inference on a given model.
     * Returns null if no nodes serve this model.
     */
    selectBestNode(modelId: string): NodeLoad | null {
        const modelLoads = this.loads.get(modelId);
        if (!modelLoads || modelLoads.size === 0) return null;

        let bestNode: NodeLoad | null = null;
        let bestScore = -Infinity;

        for (const load of modelLoads.values()) {
            const score = this.computeScore(load);
            if (score > bestScore) {
                bestScore = score;
                bestNode = load;
            }
        }

        return bestNode;
    }

    /**
     * Compute routing score for a node.
     * Higher = better candidate.
     */
    private computeScore(load: NodeLoad): number {
        // Load score: prefer low load (invert: 1.0 - load)
        const loadScore = 1.0 - load.currentLoad;

        // Latency score: prefer low latency (inverse, normalized)
        // Guard against zero latency
        const latencyScore = 1.0 / Math.max(load.avgLatencyMs, 1);

        // VRAM score: prefer more free VRAM (normalized to 0-1 range, assuming max 48GB)
        const vramScore = Math.min(load.vramFree / 48000, 1.0);

        return (
            WEIGHT_LOAD * loadScore +
            WEIGHT_LATENCY * latencyScore +
            WEIGHT_VRAM * vramScore
        );
    }

    /**
     * Check if a model needs auto-scaling (all nodes overloaded).
     */
    needsAutoScale(modelId: string): boolean {
        const modelLoads = this.loads.get(modelId);
        if (!modelLoads || modelLoads.size === 0) return false;

        for (const load of modelLoads.values()) {
            if (load.currentLoad < OVERLOAD_THRESHOLD) {
                return false;
            }
        }
        return true;
    }

    /**
     * Get load reports for all nodes serving a model.
     */
    getLoadsForModel(modelId: string): NodeLoad[] {
        const modelLoads = this.loads.get(modelId);
        if (!modelLoads) return [];
        return [...modelLoads.values()];
    }

    /**
     * Remove a node from routing for a specific model.
     */
    removeNode(nodeId: string, modelId: string): void {
        this.loads.get(modelId)?.delete(nodeId);
    }

    /**
     * List all models that have at least one node reporting load.
     */
    getAvailableModels(): string[] {
        const models: string[] = [];
        for (const [modelId, nodes] of this.loads) {
            if (nodes.size > 0) {
                models.push(modelId);
            }
        }
        return models;
    }
}
