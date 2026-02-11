/**
 * ScalingPlanner — Optimal model sharding across N heterogeneous nodes.
 *
 * Given a model spec and a set of peer nodes with capabilities,
 * produces a pipeline plan that assigns layer ranges proportionally
 * based on VRAM and estimates latency bottlenecks.
 *
 * @module browser/llm/ScalingPlanner
 */

export interface ModelSpec {
    params: number;
    vramMB: number;
    layers: number;
    hiddenDim: number;
}

export interface PeerNode {
    nodeId: string;
    capabilities: {
        vramMB: number;
        cpuCores: number;
        bandwidthMbps: number;
    };
}

export interface PipelineStage {
    nodeId: string;
    layerRange: [number, number];
    assignedVramMB: number;
}

export interface ScalingPlan {
    stages: PipelineStage[];
    feasible: boolean;
    reason?: string;
    estimatedLatencyMs: number;
    bottleneck?: string;
    totalVramMB: number;
    requiredVramMB: number;
}

export class ScalingPlanner {

    createPlan(model: ModelSpec, peers: PeerNode[]): ScalingPlan {
        const totalVramMB = peers.reduce((sum, p) => sum + p.capabilities.vramMB, 0);
        const requiredVramMB = model.vramMB;

        // Check feasibility
        if (totalVramMB < requiredVramMB) {
            return {
                stages: [],
                feasible: false,
                reason: `Total VRAM insufficient: ${totalVramMB}MB available, ${requiredVramMB}MB required`,
                estimatedLatencyMs: Infinity,
                totalVramMB,
                requiredVramMB,
            };
        }

        // Assign layers proportionally to VRAM
        const stages: PipelineStage[] = [];
        let layerCursor = 0;

        for (let i = 0; i < peers.length; i++) {
            const peer = peers[i];
            const vramFraction = peer.capabilities.vramMB / totalVramMB;
            let layerCount: number;

            if (i === peers.length - 1) {
                // Last node gets remaining layers
                layerCount = model.layers - layerCursor;
            } else {
                layerCount = Math.max(1, Math.round(model.layers * vramFraction));
                // Don't exceed remaining
                layerCount = Math.min(layerCount, model.layers - layerCursor);
            }

            if (layerCount <= 0) continue;

            const startLayer = layerCursor;
            const endLayer = layerCursor + layerCount - 1;

            stages.push({
                nodeId: peer.nodeId,
                layerRange: [startLayer, endLayer],
                assignedVramMB: Math.round(requiredVramMB * (layerCount / model.layers)),
            });

            layerCursor = endLayer + 1;
        }

        // Estimate latency
        const { latencyMs, bottleneck } = this.estimateLatency(model, peers, stages);

        return {
            stages,
            feasible: true,
            estimatedLatencyMs: latencyMs,
            bottleneck,
            totalVramMB,
            requiredVramMB,
        };
    }

    private estimateLatency(model: ModelSpec, peers: PeerNode[], stages: PipelineStage[]): { latencyMs: number; bottleneck: string } {
        // Activation transfer size between stages (hidden_dim * sizeof(float32))
        const activationSizeBytes = model.hiddenDim * 4;
        const activationSizeMB = activationSizeBytes / (1024 * 1024);

        // Compute latency per stage
        let maxComputeMs = 0;
        let totalTransferMs = 0;
        let bottleneck = 'compute';

        for (let i = 0; i < stages.length; i++) {
            const stage = stages[i];
            const peer = peers[i];
            const layerCount = stage.layerRange[1] - stage.layerRange[0] + 1;

            // Rough compute estimate: ~1ms per layer per B params on GPU
            const paramsPerLayer = model.params / model.layers;
            const computeMs = layerCount * (paramsPerLayer / 1e9) * 1.0; // ~1ms/layer/B
            maxComputeMs = Math.max(maxComputeMs, computeMs);

            // Transfer latency between stages
            if (i < stages.length - 1) {
                const nextPeer = peers[i + 1];
                const minBandwidth = Math.min(peer.capabilities.bandwidthMbps, nextPeer.capabilities.bandwidthMbps);
                const transferMs = (activationSizeMB * 8 / minBandwidth) * 1000; // bits / Mbps = seconds
                totalTransferMs += transferMs;
            }
        }

        if (totalTransferMs > maxComputeMs) {
            bottleneck = 'bandwidth';
        }

        return {
            latencyMs: maxComputeMs + totalTransferMs,
            bottleneck,
        };
    }
}
