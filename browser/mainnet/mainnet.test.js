/**
 * Tests for P7: Mainnet Launch.
 * Run: node --test browser/mainnet/mainnet.test.js
 */

import { MigrationManager } from './MigrationManager.js';
import { GenesisBlock } from './GenesisBlock.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── MigrationManager Tests ───────────────────────────────────────────

describe('MigrationManager', () => {
    it('should create testnet snapshot', () => {
        const mgr = new MigrationManager({
            sourceNetworkId: 'cdi-testnet-v1',
            targetNetworkId: 'cdi-mainnet-v1',
        });

        const snapshot = mgr.createSnapshot({
            balances: { 'addr1': 500, 'addr2': 1500 },
            reputation: { 'addr1': 80, 'addr2': 60 },
            activeShards: ['shard-001', 'shard-002'],
            blockNumber: 42,
        });

        assert.equal(snapshot.balances.size, 2);
        assert.equal(snapshot.checksum.length, 64);
        assert.equal(snapshot.snapshotBlock, 42);
    });

    it('should validate snapshot', () => {
        const mgr = new MigrationManager({
            sourceNetworkId: 'test', targetNetworkId: 'main',
        });
        mgr.createSnapshot({
            balances: { 'a': 100 },
            reputation: {},
            activeShards: ['s1'],
        });

        const v = mgr.validateSnapshot();
        assert.ok(v.valid);
    });

    it('should reject invalid snapshot (negative balance)', () => {
        const mgr = new MigrationManager({
            sourceNetworkId: 'test', targetNetworkId: 'main',
        });
        mgr.createSnapshot({
            balances: { 'a': -100 },
            reputation: {},
            activeShards: ['s1'],
        });

        const v = mgr.validateSnapshot();
        assert.ok(!v.valid);
        assert.ok(v.errors.some(e => e.includes('Negative')));
    });

    it('should execute migration', () => {
        const mgr = new MigrationManager({
            sourceNetworkId: 'cdi-testnet-v1',
            targetNetworkId: 'cdi-mainnet-v1',
        });
        mgr.createSnapshot({
            balances: { 'addr1': 500 },
            reputation: { 'addr1': 80 },
            activeShards: ['shard-001'],
        });

        const { genesisState, migrationId } = mgr.migrate();
        assert.equal(genesisState.networkId, 'cdi-mainnet-v1');
        assert.equal(genesisState.parentNetwork, 'cdi-testnet-v1');
        assert.ok(migrationId.length > 0);
        assert.ok(mgr.isMigrated);
    });

    it('should prevent double migration', () => {
        const mgr = new MigrationManager({
            sourceNetworkId: 'test', targetNetworkId: 'main',
        });
        mgr.createSnapshot({ balances: { 'a': 1 }, reputation: {}, activeShards: ['s1'] });
        mgr.migrate();
        assert.throws(() => mgr.migrate(), /Already migrated/);
    });
});

// ── GenesisBlock Tests ────────────────────────────────────────────────

describe('GenesisBlock', () => {
    it('should create genesis block #0', () => {
        const genesis = new GenesisBlock();
        const block = genesis.create({
            networkId: 'cdi-mainnet-v1',
            initialSupply: 10_000_000,
            bootstrapRelays: [{ peerId: 'r1', multiaddr: '/ip4/1.2.3.4/tcp/9090', region: 'eu' }],
            seedShards: [{ shardId: 's0', modelId: 'm1' }],
            genesisState: { balances: { 'addr1': 500 } },
        });

        assert.equal(block.blockNumber, 0);
        assert.equal(block.hash.length, 64);
        assert.equal(block.stateRoot.length, 64);
        assert.equal(block.parentHash, '0'.repeat(64));
        assert.equal(block.treasury.initialSupply, 10_000_000);
    });

    it('should verify genesis block', () => {
        const genesis = new GenesisBlock();
        genesis.create({
            networkId: 'cdi-mainnet-v1',
            initialSupply: 10_000_000,
            bootstrapRelays: [{ peerId: 'r1' }],
            seedShards: [{ shardId: 's0' }],
        });

        const v = genesis.verify();
        assert.ok(v.valid);
        assert.ok(v.checks.blockNumberZero);
        assert.ok(v.checks.hasHash);
    });

    it('should prevent double creation', () => {
        const genesis = new GenesisBlock();
        genesis.create({ networkId: 'test', bootstrapRelays: [{ peerId: 'r1' }] });
        assert.throws(() => genesis.create({ networkId: 'test2' }), /already created/);
    });
});


