/**
 * Tests for P3 WS-P3.1: libp2p WebRTC P2P layer.
 * Run: node browser/p2p/p2p.test.js
 */

import { ActivationRelay } from './ActivationRelay.js';
import { PeerDiscovery, TOPIC_PEER_ANNOUNCE } from './PeerDiscovery.js';
import { LibP2PNode } from './LibP2PNode.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// ── ActivationRelay Tests ─────────────────────────────────────────────

describe('ActivationRelay', () => {
    it('should serialize and deserialize Float32Array activations', () => {
        const relay = new ActivationRelay();
        const original = {
            requestId: 'req-001',
            shardId: 'shard-0',
            stageIndex: 0,
            data: new Float32Array([1.0, 2.5, -3.7, 0.001, 42.0]),
            shape: [1, 5],
            timestamp: Date.now(),
        };

        const buffer = relay.serialize(original);
        assert.ok(buffer instanceof ArrayBuffer);
        assert.ok(buffer.byteLength > 0);

        const deserialized = relay.deserialize(buffer);
        assert.equal(deserialized.requestId, 'req-001');
        assert.equal(deserialized.shardId, 'shard-0');
        assert.equal(deserialized.stageIndex, 0);
        assert.deepEqual(deserialized.shape, [1, 5]);
        assert.equal(deserialized.data.length, 5);
        // Float32 precision check
        assert.ok(Math.abs(deserialized.data[0] - 1.0) < 1e-6);
        assert.ok(Math.abs(deserialized.data[2] - (-3.7)) < 1e-5);
    });

    it('should handle large tensors (4096-dim hidden state)', () => {
        const relay = new ActivationRelay();
        const size = 4096;
        const data = new Float32Array(size);
        for (let i = 0; i < size; i++) data[i] = Math.random() * 2 - 1;

        const msg = {
            requestId: 'req-large',
            shardId: 'shard-big',
            stageIndex: 5,
            data,
            shape: [1, size],
            timestamp: Date.now(),
        };

        const buffer = relay.serialize(msg);
        const result = relay.deserialize(buffer);
        assert.equal(result.data.length, size);
        assert.ok(Math.abs(result.data[0] - data[0]) < 1e-6);
        assert.ok(Math.abs(result.data[size - 1] - data[size - 1]) < 1e-6);
    });

    it('should send via sendFn (small buffer, no chunking)', async () => {
        const relay = new ActivationRelay();
        const sent = [];
        const sendFn = async (buf) => sent.push(buf);

        await relay.send(sendFn, {
            requestId: 'r1',
            shardId: 's1',
            stageIndex: 0,
            data: new Float32Array([1, 2, 3]),
            shape: [1, 3],
            timestamp: Date.now(),
        });

        assert.equal(sent.length, 1);
        assert.ok(sent[0] instanceof ArrayBuffer);
    });

    it('should handle incoming and resolve waitForActivation', async () => {
        const relay = new ActivationRelay({ timeoutMs: 5000 });

        const msg = {
            requestId: 'req-wait',
            shardId: 's1',
            stageIndex: 2,
            data: new Float32Array([7.7]),
            shape: [1, 1],
            timestamp: Date.now(),
        };

        // Start waiting before sending
        const waitPromise = relay.waitForActivation('req-wait', 2);

        // Simulate incoming
        const buffer = relay.serialize(msg);
        relay.handleIncoming(buffer);

        const result = await waitPromise;
        assert.equal(result.requestId, 'req-wait');
        assert.ok(Math.abs(result.data[0] - 7.7) < 1e-5);
    });

    it('should timeout when no activation arrives', async () => {
        const relay = new ActivationRelay({ timeoutMs: 50 });
        await assert.rejects(
            () => relay.waitForActivation('req-never', 0),
            { message: /Timeout/ }
        );
    });

    it('should fire onReceive handler', () => {
        const relay = new ActivationRelay();
        let received = null;
        relay.onReceive((msg) => { received = msg; });

        const msg = {
            requestId: 'r1', shardId: 's1', stageIndex: 0,
            data: new Float32Array([1]), shape: [1, 1], timestamp: Date.now(),
        };
        relay.handleIncoming(relay.serialize(msg));

        assert.ok(received);
        assert.equal(received.requestId, 'r1');
    });

    it('should cancel all pending receives', () => {
        const relay = new ActivationRelay({ timeoutMs: 60000 });
        const p1 = relay.waitForActivation('r1', 0).catch(() => 'cancelled');
        const p2 = relay.waitForActivation('r2', 1).catch(() => 'cancelled');
        assert.equal(relay.pendingCount, 2);
        relay.cancelAll();
        assert.equal(relay.pendingCount, 0);
    });
});

// ── PeerDiscovery Tests ───────────────────────────────────────────────

describe('PeerDiscovery', () => {
    it('should handle peer announce and track new peers', () => {
        const discovery = new PeerDiscovery();
        discovery.init('self-peer', async () => { });

        let joinedPeer = null;
        discovery.onPeerJoin((p) => { joinedPeer = p; });

        discovery.handleAnnounce({
            peerId: 'peer-A',
            shards: ['shard-0', 'shard-1'],
            gpuCapability: 'webgpu',
            bandwidth: 100,
            reputation: 80,
            uptime: 7200,
            timestamp: Date.now(),
        });

        assert.equal(discovery.peerCount, 1);
        assert.ok(joinedPeer);
        assert.equal(joinedPeer.peerId, 'peer-A');
    });

    it('should ignore self announces', () => {
        const discovery = new PeerDiscovery();
        discovery.init('self-peer', async () => { });
        discovery.handleAnnounce({
            peerId: 'self-peer', shards: [], gpuCapability: 'webgpu',
            bandwidth: 100, reputation: 50, uptime: 100, timestamp: Date.now(),
        });
        assert.equal(discovery.peerCount, 0);
    });

    it('should find peers for a specific shard', () => {
        const discovery = new PeerDiscovery();
        discovery.init('self', async () => { });

        discovery.handleAnnounce({
            peerId: 'A', shards: ['s0', 's1'], gpuCapability: 'webgpu',
            bandwidth: 100, reputation: 80, uptime: 3600, timestamp: Date.now(),
        });
        discovery.handleAnnounce({
            peerId: 'B', shards: ['s1', 's2'], gpuCapability: 'wasm-cpu',
            bandwidth: 50, reputation: 60, uptime: 1800, timestamp: Date.now(),
        });

        const s1Peers = discovery.findPeersForShard('s1');
        assert.equal(s1Peers.length, 2);

        const s0Peers = discovery.findPeersForShard('s0');
        assert.equal(s0Peers.length, 1);
        assert.equal(s0Peers[0].peerId, 'A');
    });

    it('should find GPU-capable peers', () => {
        const discovery = new PeerDiscovery();
        discovery.init('self', async () => { });

        discovery.handleAnnounce({
            peerId: 'gpu-node', shards: [], gpuCapability: 'webgpu',
            bandwidth: 200, reputation: 90, uptime: 7200, timestamp: Date.now(),
        });
        discovery.handleAnnounce({
            peerId: 'cpu-node', shards: [], gpuCapability: 'wasm-cpu',
            bandwidth: 50, reputation: 70, uptime: 3600, timestamp: Date.now(),
        });

        const gpuPeers = discovery.findGpuPeers();
        assert.equal(gpuPeers.length, 1);
        assert.equal(gpuPeers[0].peerId, 'gpu-node');
    });

    it('should evict stale peers', async () => {
        const discovery = new PeerDiscovery();
        discovery.init('self', async () => { });

        let leftPeer = null;
        discovery.onPeerLeave((p) => { leftPeer = p; });

        discovery.handleAnnounce({
            peerId: 'old-peer', shards: [], gpuCapability: 'none',
            bandwidth: 10, reputation: 20, uptime: 60, timestamp: Date.now() - 60_000,
        });

        const evicted = discovery.evictStalePeers();
        assert.equal(evicted.length, 1);
        assert.equal(evicted[0], 'old-peer');
        assert.equal(discovery.peerCount, 0);
        assert.ok(leftPeer);
    });

    it('should get best relay candidate', () => {
        const discovery = new PeerDiscovery();
        discovery.init('self', async () => { });

        discovery.handleAnnounce({
            peerId: 'low-uptime', shards: [], gpuCapability: 'webgpu',
            bandwidth: 100, reputation: 90, uptime: 600, timestamp: Date.now(),
        });
        discovery.handleAnnounce({
            peerId: 'high-uptime', shards: [], gpuCapability: 'webgpu',
            bandwidth: 100, reputation: 85, uptime: 86400, timestamp: Date.now(),
        });

        const relay = discovery.getBestRelayCandidate();
        assert.equal(relay.peerId, 'high-uptime');
    });

    it('should publish self announcements', async () => {
        const published = [];
        const discovery = new PeerDiscovery();
        discovery.init('self', async (topic, data) => {
            published.push({ topic, data });
        });

        discovery.startAnnouncing({
            shards: ['s0'], gpuCapability: 'webgpu',
            bandwidth: 200, reputation: 95, uptime: 3600,
        });

        // Wait a tick for the immediate announce
        await new Promise(r => setTimeout(r, 10));
        discovery.stopAnnouncing();

        assert.ok(published.length >= 1);
        assert.equal(published[0].topic, TOPIC_PEER_ANNOUNCE);
        assert.equal(published[0].data.peerId, 'self');
    });
});

// ── LibP2PNode Tests ──────────────────────────────────────────────────

describe('LibP2PNode', () => {
    it('should start and stop', async () => {
        const node = new LibP2PNode();
        assert.ok(!node.isStarted);
        await node.start();
        assert.ok(node.isStarted);
        await node.stop();
        assert.ok(!node.isStarted);
    });

    it('should configure WebRTC + Circuit Relay', async () => {
        const node = new LibP2PNode({ enableRelay: true, maxConnections: 100 });
        await node.start();
        const config = node.nodeConfig;
        assert.ok(config.transports.includes('@libp2p/webrtc'));
        assert.equal(config.services.relay, '@libp2p/circuit-relay-v2');
        assert.equal(config.connectionManager.maxConnections, 100);
        await node.stop();
    });

    it('should connect and disconnect peers', async () => {
        const node = new LibP2PNode();
        await node.start();

        let connected = null, disconnected = null;
        node.onPeerConnect(id => { connected = id; });
        node.onPeerDisconnect(id => { disconnected = id; });

        const peerId = await node.connectPeer('/ip4/1.2.3.4/tcp/9090/p2p/QmTestPeer');
        assert.equal(peerId, 'QmTestPeer');
        assert.equal(node.connectionCount, 1);
        assert.equal(connected, 'QmTestPeer');

        await node.disconnectPeer('QmTestPeer');
        assert.equal(node.connectionCount, 0);
        assert.equal(disconnected, 'QmTestPeer');

        await node.stop();
    });

    it('should send data to connected peer', async () => {
        const node = new LibP2PNode();
        await node.start();
        await node.connectPeer('/ip4/0.0.0.0/tcp/1/p2p/QmPeer1');

        const data = new ArrayBuffer(256);
        const result = await node.sendToPeer('QmPeer1', data);
        assert.ok(result.sent);
        assert.equal(result.bytes, 256);

        await node.stop();
    });

    it('should throw when sending to disconnected peer', async () => {
        const node = new LibP2PNode();
        await node.start();
        await assert.rejects(
            () => node.sendToPeer('nobody', new ArrayBuffer(1)),
            { message: /Not connected/ }
        );
        await node.stop();
    });

    it('should publish to GossipSub topic', async () => {
        const node = new LibP2PNode();
        await node.start();
        const result = await node.publish('test-topic', { hello: 'world' });
        assert.ok(result.published);
        assert.equal(result.topic, 'test-topic');
        await node.stop();
    });
});
