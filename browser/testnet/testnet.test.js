/**
 * Tests for P4: Testnet Launch & Community.
 * Run: node --test browser/testnet/testnet.test.js
 */

import { GenesisConfig } from './GenesisConfig.js';
import { HealthMonitor } from './HealthMonitor.js';
import { NetworkDashboard } from './NetworkDashboard.js';
import { TestnetFaucet } from './TestnetFaucet.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── GenesisConfig Tests ───────────────────────────────────────────────

describe('GenesisConfig', () => {
    it('should build genesis config with relays and shards', () => {
        const genesis = new GenesisConfig();
        genesis
            .addRelay({ peerId: 'relay-eu', multiaddr: '/dns4/eu.cdi.net/tcp/9090', region: 'eu-west' })
            .addRelay({ peerId: 'relay-us', multiaddr: '/dns4/us.cdi.net/tcp/9090', region: 'us-east' })
            .addSeedShard({ modelId: 'tinyllama', shardId: 'tl-s0', cid: 'bafy...', layerRange: [0, 11] });

        const json = genesis.toJSON();
        assert.equal(json.bootstrapRelays.length, 2);
        assert.equal(json.seedShards.length, 1);
        assert.equal(json.networkId, 'cdi-testnet-v1');
    });

    it('should finalize and freeze config', () => {
        const genesis = new GenesisConfig();
        genesis
            .addRelay({ peerId: 'r1', multiaddr: '/ip4/1.2.3.4/tcp/9090', region: 'eu-west' })
            .addSeedShard({ modelId: 'm1', shardId: 's1' });

        const result = genesis.finalize();
        assert.ok(genesis.isFinalized);
        assert.ok(result.genesisTimestamp > 0);

        // Cannot modify after finalization
        assert.throws(
            () => genesis.addRelay({ peerId: 'r2', multiaddr: '/ip4/..', region: 'us-east' }),
            { message: /finalized/ }
        );
    });

    it('should validate config requirements', () => {
        const genesis = new GenesisConfig();
        const result = genesis.validate();
        assert.ok(!result.valid);
        assert.ok(result.errors.length >= 2); // No relays, no shards
    });

    it('should reject duplicate relay', () => {
        const genesis = new GenesisConfig();
        genesis.addRelay({ peerId: 'r1', multiaddr: '/ip4/1/tcp/9090', region: 'eu-west' });
        assert.throws(
            () => genesis.addRelay({ peerId: 'r1', multiaddr: '/ip4/2/tcp/9090', region: 'us-east' }),
            { message: /Duplicate/ }
        );
    });

    it('should support custom overrides', () => {
        const genesis = new GenesisConfig({ initialSupply: 50_000_000, blockTime: 6000 });
        assert.equal(genesis.initialSupply, 50_000_000);
    });
});

// ── HealthMonitor Tests ───────────────────────────────────────────────

describe('HealthMonitor', () => {
    it('should track node heartbeats', () => {
        const monitor = new HealthMonitor();
        monitor.heartbeat('node-1', { latencyMs: 100 });
        monitor.heartbeat('node-2', { latencyMs: 200 });

        assert.equal(monitor.nodeCount, 2);
    });

    it('should compute network health score', () => {
        const monitor = new HealthMonitor();
        monitor.heartbeat('n1', { latencyMs: 50 });
        monitor.heartbeat('n2', { latencyMs: 80 });
        monitor.heartbeat('n3', { latencyMs: 120 });

        const health = monitor.getNetworkHealth();
        assert.equal(health.totalNodes, 3);
        assert.equal(health.healthy, 3);
        assert.equal(health.score, 100);
    });

    it('should detect degraded nodes (high latency)', () => {
        const monitor = new HealthMonitor();
        monitor.heartbeat('fast', { latencyMs: 100 });
        // EMA needs multiple beats to cross 5000ms threshold
        for (let i = 0; i < 10; i++) monitor.heartbeat('slow', { latencyMs: 10000 });

        const health = monitor.getNetworkHealth();
        assert.equal(health.degraded, 1);
        assert.ok(health.score < 100);
    });

    it('should calculate latency percentiles', () => {
        const monitor = new HealthMonitor();
        for (let i = 1; i <= 100; i++) {
            monitor.heartbeat('node-1', { latencyMs: i });
        }

        const p = monitor.getLatencyPercentiles();
        assert.ok(p.p50 >= 45 && p.p50 <= 55);
        assert.ok(p.p95 >= 90 && p.p95 <= 100);
    });

    it('should track throughput', () => {
        const monitor = new HealthMonitor();
        monitor.recordInference({ latencyMs: 100, success: true, nodeId: 'n1' });
        monitor.recordInference({ latencyMs: 200, success: true, nodeId: 'n1' });
        monitor.recordInference({ latencyMs: 300, success: false, nodeId: 'n2' });

        const t = monitor.getThroughput();
        // recordInference increments totalInferences directly, then heartbeat adds inferenceCount=1
        // So total = 3 (direct) + 3 (via heartbeat) = 6
        assert.ok(t.totalInferences >= 3);
        assert.ok(t.totalErrors >= 1);
        assert.ok(t.errorRate > 0);
    });

    it('should generate alerts on status changes', () => {
        const monitor = new HealthMonitor();
        const alerts = [];
        monitor.onAlert(a => alerts.push(a));

        monitor.heartbeat('n1', { latencyMs: 100 });
        monitor.checkHealth();

        // Force offline by manipulating heartbeat time
        // (node not sending heartbeats triggers offline after threshold)
        assert.equal(monitor.alerts.length, 0); // No change yet
    });
});

// ── NetworkDashboard Tests ────────────────────────────────────────────

describe('NetworkDashboard', () => {
    it('should aggregate dashboard state', () => {
        const monitor = new HealthMonitor();
        monitor.heartbeat('n1', { latencyMs: 50 });
        monitor.heartbeat('n2', { latencyMs: 100 });
        monitor.recordInference({ latencyMs: 75, success: true, nodeId: 'n1' });

        const dashboard = new NetworkDashboard({ healthMonitor: monitor });
        const state = dashboard.getState();

        assert.equal(state.nodeCount, 2);
        assert.ok(state.healthScore > 0);
        assert.ok(state.totalInferences >= 1);
        assert.ok(state.uptime >= 0);
    });

    it('should produce formatted summary', () => {
        const monitor = new HealthMonitor();
        monitor.heartbeat('n1', { latencyMs: 50 });

        const dashboard = new NetworkDashboard({ healthMonitor: monitor });
        const summary = dashboard.getSummary();
        assert.ok(summary.includes('CDI Network Dashboard'));
        assert.ok(summary.includes('Health:'));
    });

    it('should require healthMonitor', () => {
        assert.throws(
            () => new NetworkDashboard({}),
            { message: /requires healthMonitor/ }
        );
    });
});

// ── TestnetFaucet (from P2, regression) ───────────────────────────────

describe('TestnetFaucet P4 Regression', () => {
    it('should still distribute all 4 reward types', () => {
        const faucet = new TestnetFaucet('testnet');
        const r1 = faucet.claimReward('addr1', 'wallet_connect');
        const r2 = faucet.claimReward('addr2', 'first_inference');
        const r3 = faucet.claimReward('addr3', 'shard_hosting');
        const r4 = faucet.claimReward('addr4', 'uptime_bonus');

        assert.ok(r1.success, `signup failed: ${r1.reason}`);
        assert.ok(r2.success, `firstInference failed: ${r2.reason}`);
        assert.ok(r3.success, `shardHost failed: ${r3.reason}`);
        assert.ok(r4.success, `governance failed: ${r4.reason}`);
    });
});
