/**
 * ModelRouter — TDD tests
 *
 * Tests load-aware routing: weighted score (load, latency, vram),
 * model filtering, auto-scale signal, fallback.
 */
import { ModelRouter, NodeLoad } from '../../src/routing/ModelRouter';

describe('ModelRouter', () => {
    let router: ModelRouter;

    beforeEach(() => {
        router = new ModelRouter();
    });

    // ── Node Registration ───────────────────────────────

    test('register nodes and report load', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.3, queueDepth: 2, avgLatencyMs: 100, vramFree: 4000,
        });

        const loads = router.getLoadsForModel('llama3:8b');
        expect(loads).toHaveLength(1);
        expect(loads[0].nodeId).toBe('node-1');
    });

    // ── Best Node Selection ─────────────────────────────

    test('route to least-loaded node', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.8, queueDepth: 10, avgLatencyMs: 200, vramFree: 2000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'llama3:8b',
            currentLoad: 0.2, queueDepth: 1, avgLatencyMs: 80, vramFree: 5000,
        });

        const best = router.selectBestNode('llama3:8b');
        expect(best).not.toBeNull();
        expect(best!.nodeId).toBe('node-2'); // lower load + lower latency
    });

    test('returns null when no nodes serve the model', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.3, queueDepth: 2, avgLatencyMs: 100, vramFree: 4000,
        });

        const best = router.selectBestNode('deepseek-r1:70b');
        expect(best).toBeNull();
    });

    // ── Weighted Scoring ────────────────────────────────

    test('low-latency node preferred over low-load node at similar loads', () => {
        router.reportLoad({
            nodeId: 'node-slow', modelId: 'llama3:8b',
            currentLoad: 0.3, queueDepth: 2, avgLatencyMs: 500, vramFree: 4000,
        });
        router.reportLoad({
            nodeId: 'node-fast', modelId: 'llama3:8b',
            currentLoad: 0.3, queueDepth: 3, avgLatencyMs: 50, vramFree: 4000,
        });

        const best = router.selectBestNode('llama3:8b');
        expect(best!.nodeId).toBe('node-fast'); // latency matters at equal load
    });

    // ── Auto-Scale Detection ────────────────────────────

    test('detect auto-scale needed when all nodes overloaded', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'deepseek-r1:70b',
            currentLoad: 0.92, queueDepth: 20, avgLatencyMs: 500, vramFree: 1000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'deepseek-r1:70b',
            currentLoad: 0.95, queueDepth: 25, avgLatencyMs: 600, vramFree: 800,
        });

        expect(router.needsAutoScale('deepseek-r1:70b')).toBe(true);
    });

    test('no auto-scale needed when at least one node under threshold', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.5, queueDepth: 5, avgLatencyMs: 100, vramFree: 4000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'llama3:8b',
            currentLoad: 0.95, queueDepth: 25, avgLatencyMs: 600, vramFree: 800,
        });

        expect(router.needsAutoScale('llama3:8b')).toBe(false);
    });

    // ── Load Update ─────────────────────────────────────

    test('updating load changes routing', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.1, queueDepth: 1, avgLatencyMs: 50, vramFree: 5000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'llama3:8b',
            currentLoad: 0.5, queueDepth: 5, avgLatencyMs: 100, vramFree: 3000,
        });

        // Initially node-1 is best
        expect(router.selectBestNode('llama3:8b')!.nodeId).toBe('node-1');

        // node-1 suddenly overloaded
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.99, queueDepth: 30, avgLatencyMs: 800, vramFree: 500,
        });

        // Now node-2 is best
        expect(router.selectBestNode('llama3:8b')!.nodeId).toBe('node-2');
    });

    // ── Multi-Model Isolation ───────────────────────────

    test('routing is isolated per model', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.1, queueDepth: 1, avgLatencyMs: 50, vramFree: 5000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'deepseek-r1:70b',
            currentLoad: 0.2, queueDepth: 2, avgLatencyMs: 80, vramFree: 3000,
        });

        const llamaBest = router.selectBestNode('llama3:8b');
        const deepseekBest = router.selectBestNode('deepseek-r1:70b');

        expect(llamaBest!.nodeId).toBe('node-1');
        expect(deepseekBest!.nodeId).toBe('node-2');
    });

    // ── Node Removal ────────────────────────────────────

    test('remove node from routing', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.1, queueDepth: 1, avgLatencyMs: 50, vramFree: 5000,
        });

        router.removeNode('node-1', 'llama3:8b');

        const loads = router.getLoadsForModel('llama3:8b');
        expect(loads).toHaveLength(0);
    });

    // ── Edge case: get all available models ─────────────

    test('list all models with at least one node', () => {
        router.reportLoad({
            nodeId: 'node-1', modelId: 'llama3:8b',
            currentLoad: 0.3, queueDepth: 2, avgLatencyMs: 100, vramFree: 4000,
        });
        router.reportLoad({
            nodeId: 'node-2', modelId: 'deepseek-r1:70b',
            currentLoad: 0.5, queueDepth: 5, avgLatencyMs: 200, vramFree: 2000,
        });

        const models = router.getAvailableModels();
        expect(models).toContain('llama3:8b');
        expect(models).toContain('deepseek-r1:70b');
        expect(models).toHaveLength(2);
    });
});
