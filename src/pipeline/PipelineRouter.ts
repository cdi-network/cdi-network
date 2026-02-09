import type { PipelineStage, PipelineMetrics, StageMetric } from './types.js';

interface PipelineRouterOptions {
    validateActivations?: boolean;
    collectMetrics?: boolean;
}

/**
 * PipelineRouter — chains PipelineStage nodes into a sequential pipeline.
 * Relays activations from stage to stage, optionally validating and collecting metrics.
 */
export class PipelineRouter {
    private lastMetrics: PipelineMetrics | null = null;

    constructor(
        private readonly stages: PipelineStage[],
        private readonly options: PipelineRouterOptions = {},
    ) { }

    /**
     * Runs a full inference pass through the pipeline.
     */
    async infer(input: Float32Array): Promise<Float32Array> {
        let current = input;
        const stageMetrics: StageMetric[] = [];
        const totalStart = performance.now();

        for (const stage of this.stages) {
            const stageStart = performance.now();

            current = await stage.forward(current);

            if (this.options.validateActivations) {
                this.validateOutput(current, stage.nodeId);
            }

            if (this.options.collectMetrics) {
                stageMetrics.push({
                    nodeId: stage.nodeId,
                    durationMs: performance.now() - stageStart,
                });
            }
        }

        if (this.options.collectMetrics) {
            this.lastMetrics = {
                stages: stageMetrics,
                totalDurationMs: performance.now() - totalStart,
            };
        }

        return current;
    }

    /**
     * Returns metrics from the last infer() call.
     */
    getLastMetrics(): PipelineMetrics | null {
        return this.lastMetrics;
    }

    /**
     * Validates activation output: checks for NaN, Infinity, and zero-length.
     */
    private validateOutput(output: Float32Array, nodeId: string): void {
        if (!output || output.length === 0) {
            throw new Error(`Corrupted activation from ${nodeId}: empty output`);
        }
        for (let i = 0; i < output.length; i++) {
            if (!Number.isFinite(output[i])) {
                throw new Error(`Corrupted activation from ${nodeId}: non-finite value at index ${i}`);
            }
        }
    }
}
