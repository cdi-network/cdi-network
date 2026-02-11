/**
 * ScalingTestHarness — Orchestrate progressive multi-node inference scale tests.
 *
 * Simulates node clusters at increasing scales (8B→14B→70B→671B)
 * and validates that the ScalingPlanner produces feasible pipeline plans.
 *
 * @module browser/llm/ScalingTestHarness
 */

import { ScalingPlanner } from './ScalingPlanner';
import type { ModelSpec, ScalingPlan, PeerNode } from './ScalingPlanner';

export interface ScaleTestConfig {
    modelSpec: ModelSpec;
    nodeCount: number;
    defaultVramMB: number;
}

export interface ScaleTestResult {
    modelParams: number;
    nodeCount: number;
    plan: ScalingPlan;
    timestamp: number;
}

export class ScalingTestHarness {
    private planner = new ScalingPlanner();

    /**
     * Run a single scale test: create N virtual peers and plan model distribution.
     */
    async runScaleTest(config: ScaleTestConfig): Promise<ScaleTestResult> {
        const peers: PeerNode[] = Array.from({ length: config.nodeCount }, (_, i) => ({
            nodeId: `node-${i}`,
            capabilities: {
                vramMB: config.defaultVramMB,
                cpuCores: 8,
                bandwidthMbps: 100,
            },
        }));

        const plan = this.planner.createPlan(config.modelSpec, peers);

        return {
            modelParams: config.modelSpec.params,
            nodeCount: config.nodeCount,
            plan,
            timestamp: Date.now(),
        };
    }

    /**
     * Run progressive test across multiple model sizes.
     */
    async runProgressiveTest(configs: ScaleTestConfig[]): Promise<ScaleTestResult[]> {
        const results: ScaleTestResult[] = [];
        for (const config of configs) {
            results.push(await this.runScaleTest(config));
        }
        return results;
    }

    /**
     * Generate human-readable scaling report.
     */
    generateReport(results: ScaleTestResult[]): string {
        const lines: string[] = ['# CDI Network — Progressive Scaling Report', ''];

        for (const r of results) {
            const paramsStr = r.modelParams >= 1e9
                ? `${(r.modelParams / 1e9).toFixed(0)}B`
                : `${(r.modelParams / 1e6).toFixed(0)}M`;

            lines.push(`## ${paramsStr} Model`);
            lines.push(`- **Nodes**: ${r.nodeCount}`);
            lines.push(`- **Feasible**: ${r.plan.feasible ? '✅' : '❌'}`);

            if (r.plan.feasible) {
                lines.push(`- **Stages**: ${r.plan.stages.length}`);
                lines.push(`- **Estimated Latency**: ${r.plan.estimatedLatencyMs.toFixed(1)}ms`);
                lines.push(`- **Bottleneck**: ${r.plan.bottleneck}`);
                lines.push(`- **VRAM**: ${r.plan.totalVramMB}MB / ${r.plan.requiredVramMB}MB required`);

                lines.push('- **Layer Assignment**:');
                for (const stage of r.plan.stages) {
                    const layers = stage.layerRange[1] - stage.layerRange[0] + 1;
                    lines.push(`  - ${stage.nodeId}: layers [${stage.layerRange[0]}-${stage.layerRange[1]}] (${layers} layers, ~${stage.assignedVramMB}MB)`);
                }
            } else {
                lines.push(`- **Reason**: ${r.plan.reason}`);
            }

            lines.push('');
        }

        return lines.join('\n');
    }
}
