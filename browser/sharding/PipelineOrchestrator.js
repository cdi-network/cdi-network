/**
 * PipelineOrchestrator — Manages distributed inference pipelines.
 *
 * For a given inference request:
 * 1. Looks up model shards from ShardRegistry
 * 2. Selects available nodes for each shard (with failover)
 * 3. Routes activations through the pipeline: shard-0 → shard-1 → ... → shard-N
 * 4. Collects and returns the final output
 * 5. Distributes CDI rewards proportionally
 *
 * @module browser/sharding/PipelineOrchestrator
 */

/**
 * @typedef {Object} PipelineStage
 * @property {string} shardId
 * @property {string} nodeId
 * @property {number[]} layerRange
 * @property {'pending'|'running'|'done'|'failed'} status
 * @property {number} startTime
 * @property {number} endTime
 * @property {number} computeWeight - Relative compute cost (proportional to layers)
 */

/**
 * @typedef {Object} InferenceRequest
 * @property {string} requestId
 * @property {string} modelId
 * @property {string} prompt
 * @property {string} requesterId - PeerId of the requester
 * @property {number} fee - CDI fee for this inference
 */

/**
 * @typedef {Object} InferenceResult
 * @property {string} requestId
 * @property {string} modelId
 * @property {string} output
 * @property {PipelineStage[]} pipeline
 * @property {number} totalTimeMs
 * @property {Object[]} rewards - { nodeId, amount }
 */

export class PipelineOrchestrator {
    #registry;
    #rewardCalculator;

    /**
     * @param {import('./ShardRegistry.js').ShardRegistry} registry
     * @param {function(number, number, number): number} rewardCalculator - (fee, shardWeight, totalWeight) → reward
     */
    constructor(registry, rewardCalculator = null) {
        this.#registry = registry;
        this.#rewardCalculator = rewardCalculator || ((fee, w, total) => (fee * 0.85) * (w / total));
    }

    /**
     * Build a pipeline for a model: ordered sequence of shard stages.
     * @param {string} modelId
     * @returns {PipelineStage[]}
     */
    buildPipeline(modelId) {
        const shards = this.#registry.getModelShards(modelId);
        if (shards.length === 0) {
            throw new Error(`No shards registered for model: ${modelId}`);
        }

        const stages = [];
        for (const shard of shards) {
            const nodes = this.#registry.getAvailableNodes(shard.shardId);
            if (nodes.length === 0) {
                throw new Error(`No available nodes for shard: ${shard.shardId}`);
            }
            // Pick the first available node (round-robin or load-balancing can be added)
            const selected = nodes[0];
            stages.push({
                shardId: shard.shardId,
                nodeId: selected.nodeId,
                layerRange: shard.layerRange,
                status: 'pending',
                startTime: 0,
                endTime: 0,
                computeWeight: shard.layerRange[1] - shard.layerRange[0] + 1,
            });
        }
        return stages;
    }

    /**
     * Execute the pipeline (simulated for now — real impl uses WebRTC activation relay).
     * @param {InferenceRequest} request
     * @param {function(PipelineStage, any): Promise<any>} executeStage - Callback to run a single stage
     * @returns {Promise<InferenceResult>}
     */
    async executePipeline(request, executeStage) {
        const startTime = Date.now();
        const pipeline = this.buildPipeline(request.modelId);
        let activations = { prompt: request.prompt };

        for (const stage of pipeline) {
            stage.status = 'running';
            stage.startTime = Date.now();
            try {
                activations = await executeStage(stage, activations);
                stage.status = 'done';
                stage.endTime = Date.now();
            } catch (err) {
                stage.status = 'failed';
                stage.endTime = Date.now();
                // Try failover to replica
                const replicas = this.#registry.getAvailableNodes(stage.shardId)
                    .filter(n => n.nodeId !== stage.nodeId);
                if (replicas.length > 0) {
                    stage.nodeId = replicas[0].nodeId;
                    stage.status = 'running';
                    stage.startTime = Date.now();
                    activations = await executeStage(stage, activations);
                    stage.status = 'done';
                    stage.endTime = Date.now();
                } else {
                    throw new Error(`Pipeline failed at shard ${stage.shardId}: ${err.message}`);
                }
            }
        }

        // Calculate rewards
        const totalWeight = pipeline.reduce((sum, s) => sum + s.computeWeight, 0);
        const rewards = pipeline
            .filter(s => s.status === 'done')
            .map(s => ({
                nodeId: s.nodeId,
                amount: this.#rewardCalculator(request.fee, s.computeWeight, totalWeight),
            }));

        return {
            requestId: request.requestId,
            modelId: request.modelId,
            output: activations,
            pipeline,
            totalTimeMs: Date.now() - startTime,
            rewards,
        };
    }

    /**
     * Check if a model has a complete pipeline (all shards have available nodes).
     * @param {string} modelId
     * @returns {{ complete: boolean, missing: string[] }}
     */
    checkPipelineReadiness(modelId) {
        const shards = this.#registry.getModelShards(modelId);
        const missing = [];
        for (const shard of shards) {
            if (this.#registry.getAvailableNodes(shard.shardId).length === 0) {
                missing.push(shard.shardId);
            }
        }
        return { complete: missing.length === 0, missing };
    }
}
