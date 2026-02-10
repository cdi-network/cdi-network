/**
 * FallbackExecutor — CPU-only WASM fallback for browsers without WebGPU.
 *
 * Same interface as ShardExecutor, ~10x slower but works everywhere.
 * Auto-detected via navigator.gpu check.
 *
 * @module browser/compute/FallbackExecutor
 */

import { ShardExecutor } from './ShardExecutor.js';

export class FallbackExecutor extends ShardExecutor {
    /**
     * Override init to always report no GPU.
     * @returns {Promise<boolean>}
     */
    async init() {
        // Force CPU-only mode
        await super.init();
        return false;
    }

    /** Always false — this is the CPU fallback */
    get isGpuAvailable() { return false; }
}

/**
 * Factory: create the best available executor.
 * @returns {Promise<ShardExecutor>}
 */
export async function createExecutor() {
    const executor = new ShardExecutor();
    const hasGpu = await executor.init();

    if (hasGpu) {
        return executor;
    }

    // Fall back to CPU
    const fallback = new FallbackExecutor();
    await fallback.init();
    return fallback;
}
