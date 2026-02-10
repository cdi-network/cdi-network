/**
 * Tests for P3 WS-P3.2: Helia IPFS + OrbitDB Persistence layer.
 * Run: node browser/storage/storage.test.js
 */

import { HeliaManager } from './HeliaManager.js';
import { LedgerStore } from './LedgerStore.js';
import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';

// ── HeliaManager Tests ────────────────────────────────────────────────

describe('HeliaManager', () => {
    it('should store and retrieve shard weights via CID', async () => {
        const helia = new HeliaManager();
        await helia.start();

        const weights = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
        const cid = await helia.addShard(weights);

        assert.ok(cid.startsWith('bafy'));
        assert.ok(helia.has(cid));

        const retrieved = await helia.getShard(cid);
        assert.deepEqual(retrieved, weights);

        await helia.stop();
    });

    it('should generate deterministic CIDs (dedup)', async () => {
        const helia = new HeliaManager();
        await helia.start();

        const data = new Uint8Array([10, 20, 30]);
        const cid1 = await helia.addShard(data);
        const cid2 = await helia.addShard(data);

        assert.equal(cid1, cid2);
        assert.equal(helia.count, 1); // Only stored once

        await helia.stop();
    });

    it('should handle ArrayBuffer input', async () => {
        const helia = new HeliaManager();
        await helia.start();

        const buffer = new ArrayBuffer(16);
        new Float32Array(buffer).set([1.0, 2.0, 3.0, 4.0]);

        const cid = await helia.addShard(buffer);
        const result = await helia.getShard(cid);
        assert.equal(result.byteLength, 16);

        await helia.stop();
    });

    it('should evict LRU when storage exceeds limit', async () => {
        // 100 bytes max, 3 shards of 40 bytes each → should evict oldest
        const helia = new HeliaManager({ maxStorageBytes: 100 });
        await helia.start();

        const shard1 = new Uint8Array(40).fill(1);
        const shard2 = new Uint8Array(40).fill(2);
        const shard3 = new Uint8Array(40).fill(3);

        const cid1 = await helia.addShard(shard1);
        // Delay to give shard2 a later creation time
        await new Promise(r => setTimeout(r, 10));
        const cid2 = await helia.addShard(shard2);

        // Delay, then access shard1 to update its lastAccess
        await new Promise(r => setTimeout(r, 10));
        await helia.getShard(cid1);

        // Delay, then add shard3 — should evict shard2 (oldest lastAccess)
        await new Promise(r => setTimeout(r, 10));
        const cid3 = await helia.addShard(shard3);

        assert.ok(helia.has(cid1), 'shard1 should remain (recently accessed)');
        assert.ok(!helia.has(cid2), 'shard2 should be evicted (LRU)');
        assert.ok(helia.has(cid3), 'shard3 should be added');

        await helia.stop();
    });

    it('should not evict pinned shards', async () => {
        const helia = new HeliaManager({ maxStorageBytes: 100 });
        await helia.start();

        const shard1 = new Uint8Array(40).fill(1);
        const shard2 = new Uint8Array(40).fill(2);
        const shard3 = new Uint8Array(40).fill(3);

        const cid1 = await helia.addShard(shard1);
        const cid2 = await helia.addShard(shard2);

        // Pin shard1
        helia.pin(cid1);

        // Adding shard3 should evict shard2 (not shard1 which is pinned)
        const cid3 = await helia.addShard(shard3);

        assert.ok(helia.has(cid1), 'pinned shard1 should remain');
        assert.ok(!helia.has(cid2), 'unpinned shard2 should be evicted');

        await helia.stop();
    });

    it('should remove a shard and update used bytes', async () => {
        const helia = new HeliaManager();
        await helia.start();

        const cid = await helia.addShard(new Uint8Array(100));
        assert.equal(helia.usedBytes, 100);

        helia.remove(cid);
        assert.equal(helia.usedBytes, 0);
        assert.ok(!helia.has(cid));

        await helia.stop();
    });

    it('should throw when not started', async () => {
        const helia = new HeliaManager();
        await assert.rejects(
            () => helia.addShard(new Uint8Array(1)),
            { message: /not started/ }
        );
    });
});

// ── LedgerStore Tests ─────────────────────────────────────────────────

describe('LedgerStore', () => {
    it('should record mint transaction and update balance', () => {
        const ledger = new LedgerStore();
        const tx = ledger.recordTransaction({
            from: 'treasury',
            to: '0xAlice',
            amount: 100,
            txType: 'mint',
            signature: 'sig-1',
        });

        assert.ok(tx.txId);
        assert.equal(ledger.getBalance('0xAlice'), 100);
        assert.equal(ledger.totalMinted, 100);
    });

    it('should record transfer and update both balances', () => {
        const ledger = new LedgerStore();

        // Mint to Alice first
        ledger.recordTransaction({
            from: 'treasury', to: '0xAlice', amount: 100,
            txType: 'mint', signature: 'sig-1',
        });

        // Transfer from Alice to Bob
        ledger.recordTransaction({
            from: '0xAlice', to: '0xBob', amount: 30,
            txType: 'transfer', signature: 'sig-2',
        });

        assert.equal(ledger.getBalance('0xAlice'), 70);
        assert.equal(ledger.getBalance('0xBob'), 30);
    });

    it('should reject transfer with insufficient balance', () => {
        const ledger = new LedgerStore();
        ledger.recordTransaction({
            from: 'treasury', to: '0xAlice', amount: 10,
            txType: 'mint', signature: 'sig-1',
        });

        assert.throws(
            () => ledger.recordTransaction({
                from: '0xAlice', to: '0xBob', amount: 50,
                txType: 'transfer', signature: 'sig-2',
            }),
            { message: /Insufficient balance/ }
        );
    });

    it('should record burn and reduce circulating supply', () => {
        const ledger = new LedgerStore();
        ledger.recordTransaction({
            from: 'treasury', to: '0xAlice', amount: 100,
            txType: 'mint', signature: 'sig-1',
        });
        ledger.recordTransaction({
            from: '0xAlice', to: 'burn-address', amount: 15,
            txType: 'burn', signature: 'sig-2',
        });

        assert.equal(ledger.totalMinted, 100);
        assert.equal(ledger.totalBurned, 15);
        assert.equal(ledger.circulatingSupply, 85);
        assert.equal(ledger.getBalance('0xAlice'), 85);
    });

    it('should return transaction history for an address', () => {
        const ledger = new LedgerStore();
        ledger.recordTransaction({
            from: 'treasury', to: '0xAlice', amount: 100,
            txType: 'mint', signature: 's1',
        });
        ledger.recordTransaction({
            from: '0xAlice', to: '0xBob', amount: 20,
            txType: 'transfer', signature: 's2',
        });
        ledger.recordTransaction({
            from: 'treasury', to: '0xCharlie', amount: 50,
            txType: 'mint', signature: 's3',
        });

        const aliceHistory = ledger.getHistory('0xAlice');
        assert.equal(aliceHistory.length, 2); // mint + transfer
    });

    it('should pass audit when ledger is consistent', () => {
        const ledger = new LedgerStore();
        ledger.recordTransaction({
            from: 'treasury', to: '0xAlice', amount: 1000,
            txType: 'mint', signature: 's1',
        });
        ledger.recordTransaction({
            from: '0xAlice', to: '0xBob', amount: 300,
            txType: 'transfer', signature: 's2',
        });
        ledger.recordTransaction({
            from: '0xBob', to: 'burn-address', amount: 100,
            txType: 'burn', signature: 's3',
        });

        const result = ledger.audit();
        assert.ok(result.valid);
        assert.equal(result.expected, 900); // 1000 minted - 100 burned
    });

    it('should record reward transactions', () => {
        const ledger = new LedgerStore();
        ledger.recordTransaction({
            from: 'treasury', to: '0xNode1', amount: 5,
            txType: 'mint', signature: 's1',
        });

        const rewards = ledger.getByType('mint');
        assert.equal(rewards.length, 1);
        assert.equal(rewards[0].to, '0xNode1');
    });
});
