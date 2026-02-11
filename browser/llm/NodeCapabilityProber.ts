/**
 * NodeCapabilityProber — Detect GPU VRAM, CPU cores, and network bandwidth.
 *
 * In-browser: uses WebGPU adapter limits + navigator.hardwareConcurrency.
 * In Node.js/tests: returns safe defaults (CPU-only mode).
 *
 * @module browser/llm/NodeCapabilityProber
 */

export interface NodeCapabilities {
    vramMB: number;
    cpuCores: number;
    bandwidthMbps: number;
    tier: 'xs' | 's' | 'm' | 'l' | 'xl';
}

export class NodeCapabilityProber {

    async probe(): Promise<NodeCapabilities> {
        let vramMB = 0;
        let cpuCores = 4;

        if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
            cpuCores = navigator.hardwareConcurrency;
        }

        // Try WebGPU VRAM detection
        if (typeof navigator !== 'undefined' && (navigator as any).gpu) {
            try {
                const adapter = await (navigator as any).gpu.requestAdapter();
                if (adapter) {
                    // maxBufferSize gives a rough VRAM indicator
                    const limits = adapter.limits;
                    const maxBuffer = limits?.maxBufferSize || 0;
                    vramMB = Math.round(maxBuffer / (1024 * 1024));
                }
            } catch { /* no GPU */ }
        }

        // Estimate bandwidth (could be refined with actual speed test)
        const bandwidthMbps = 100; // Conservative default

        return {
            vramMB,
            cpuCores: typeof cpuCores === 'number' ? cpuCores : 4,
            bandwidthMbps,
            tier: this.classifyTier(vramMB),
        };
    }

    classifyTier(vramMB: number): 'xs' | 's' | 'm' | 'l' | 'xl' {
        if (vramMB < 1000) return 'xs';
        if (vramMB < 4000) return 's';
        if (vramMB < 8000) return 'm';
        if (vramMB < 24000) return 'l';
        return 'xl';
    }

    /**
     * Estimate max model size (in params) that can run solo on this VRAM.
     * Rule of thumb: ~1GB VRAM per 1B params (Q4 quantized), ~2GB per 1B (FP16).
     */
    maxSoloModelParams(vramMB: number): number {
        // Q4 quantized: ~0.5 bytes/param, plus overhead (~30%)
        const usableVramBytes = vramMB * 1024 * 1024 * 0.7; // 70% usable
        const bytesPerParam = 0.5; // Q4
        return usableVramBytes / bytesPerParam;
    }
}
