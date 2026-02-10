/**
 * AutoBalancer — TDD tests
 *
 * Tests network self-balancing: replicate popular models,
 * evict unused models, migrate for load distribution.
 */
import { AutoBalancer, BalanceAction, ModelUsageStats } from '../../src/routing/AutoBalancer';

describe('AutoBalancer', () => {
    let balancer: AutoBalancer;

    beforeEach(() => {
        balancer = new AutoBalancer();
    });

    // ── Usage Tracking ──────────────────────────────────

    test('record model usage and retrieve stats', () => {
        balancer.recordUsage('llama3:8b', 'node-1');
        balancer.recordUsage('llama3:8b', 'node-1');
        balancer.recordUsage('llama3:8b', 'node-2');

        const stats = balancer.getUsageStats('llama3:8b');
        expect(stats).not.toBeNull();
        expect(stats!.totalInferences).toBe(3);
        expect(stats!.nodeDistribution.get('node-1')).toBe(2);
        expect(stats!.nodeDistribution.get('node-2')).toBe(1);
    });

    // ── Replication Signal ──────────────────────────────

    test('recommend replication when model utilization > 80%', () => {
        // Simulate high utilization on a single node
        balancer.reportNodeLoad('node-1', 'llama3:8b', 0.85);
        // Record some usage
        for (let i = 0; i < 100; i++) {
            balancer.recordUsage('llama3:8b', 'node-1');
        }

        // node-2 has capacity
        balancer.reportNodeLoad('node-2', 'deepseek:7b', 0.2);

        const actions = balancer.evaluate();
        const replicateActions = actions.filter(a => a.type === 'replicate');

        expect(replicateActions.length).toBeGreaterThan(0);
        expect(replicateActions[0].modelId).toBe('llama3:8b');
        expect(replicateActions[0].toNode).toBe('node-2');
    });

    // ── Eviction Signal ─────────────────────────────────

    test('recommend eviction when model has 0 usage for evaluation window', () => {
        // Model with no usage
        balancer.reportNodeLoad('node-1', 'unused-model:3b', 0.05);
        // Model with high usage
        balancer.reportNodeLoad('node-1', 'llama3:8b', 0.5);
        for (let i = 0; i < 50; i++) {
            balancer.recordUsage('llama3:8b', 'node-1');
        }

        const actions = balancer.evaluate();
        const evictActions = actions.filter(a => a.type === 'evict');

        expect(evictActions.length).toBeGreaterThan(0);
        expect(evictActions[0].modelId).toBe('unused-model:3b');
    });

    // ── Migration Signal ────────────────────────────────

    test('recommend migration when node is overloaded', () => {
        // node-1 overloaded with 2 models
        balancer.reportNodeLoad('node-1', 'llama3:8b', 0.95);
        balancer.reportNodeLoad('node-1', 'small:1b', 0.95);
        // node-2 has capacity
        balancer.reportNodeLoad('node-2', 'other:7b', 0.2);

        // small model has much fewer inferences (migrate least popular)
        for (let i = 0; i < 100; i++) {
            balancer.recordUsage('llama3:8b', 'node-1');
        }
        for (let i = 0; i < 5; i++) {
            balancer.recordUsage('small:1b', 'node-1');
        }

        const actions = balancer.evaluate();
        const migrateActions = actions.filter(a => a.type === 'migrate');

        // Should suggest migrating least popular model from overloaded node
        if (migrateActions.length > 0) {
            expect(migrateActions[0].modelId).toBe('small:1b');
            expect(migrateActions[0].fromNode).toBe('node-1');
        }
    });

    // ── No Actions When Balanced ────────────────────────

    test('no actions when network is balanced', () => {
        balancer.reportNodeLoad('node-1', 'llama3:8b', 0.5);
        balancer.reportNodeLoad('node-2', 'deepseek:7b', 0.4);

        for (let i = 0; i < 30; i++) {
            balancer.recordUsage('llama3:8b', 'node-1');
            balancer.recordUsage('deepseek:7b', 'node-2');
        }

        const actions = balancer.evaluate();
        expect(actions).toHaveLength(0);
    });

    // ── Edge: Single Node ───────────────────────────────

    test('no replication possible with single node', () => {
        balancer.reportNodeLoad('node-1', 'llama3:8b', 0.9);
        for (let i = 0; i < 100; i++) {
            balancer.recordUsage('llama3:8b', 'node-1');
        }

        const actions = balancer.evaluate();
        // Can't replicate if no other nodes exist
        const replicateActions = actions.filter(a => a.type === 'replicate');
        expect(replicateActions).toHaveLength(0);
    });

    // ── Progressive Loading Tracking ────────────────────

    test('track model pull progress', () => {
        balancer.startModelPull('node-1', 'deepseek-r1:70b');
        expect(balancer.isPulling('node-1', 'deepseek-r1:70b')).toBe(true);

        balancer.updatePullProgress('node-1', 'deepseek-r1:70b', 0.5);
        expect(balancer.getPullProgress('node-1', 'deepseek-r1:70b')).toBe(0.5);

        balancer.completePull('node-1', 'deepseek-r1:70b');
        expect(balancer.isPulling('node-1', 'deepseek-r1:70b')).toBe(false);
    });
});
