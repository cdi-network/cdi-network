/**
 * PeerDiscovery — GossipSub-based peer discovery for CDI Network.
 *
 * Topic: cdi-network/peer-announce
 * Nodes announce their capabilities, shards, and GPU info.
 * Auto-connect to nodes hosting adjacent pipeline stages.
 *
 * @module browser/p2p/PeerDiscovery
 */

export const TOPIC_PEER_ANNOUNCE = 'cdi-network/peer-announce';
export const TOPIC_SHARD_REQUEST = 'cdi-network/shard-request';
export const TOPIC_INFERENCE = 'cdi-network/inference';

const ANNOUNCE_INTERVAL_MS = 15_000; // Announce every 15s
const STALE_PEER_MS = 45_000;       // Peer stale after 3 missed announces

/**
 * @typedef {Object} PeerAnnounce
 * @property {string} peerId
 * @property {string[]} shards      - Shard IDs this node hosts
 * @property {string} gpuCapability - 'webgpu' | 'wasm-cpu' | 'none'
 * @property {number} bandwidth     - Estimated bandwidth in Mbps
 * @property {number} reputation    - Reputation score 0-100
 * @property {number} uptime        - Uptime in seconds
 * @property {number} timestamp
 */

export class PeerDiscovery {
    /** @type {Map<string, PeerAnnounce>} */
    #peers = new Map();
    /** @type {string|null} */
    #selfPeerId = null;
    /** @type {Function|null} */
    #publishFn = null;
    /** @type {number|null} */
    #announceTimer = null;
    /** @type {Function|null} */
    #onPeerJoin = null;
    /** @type {Function|null} */
    #onPeerLeave = null;
    /** @type {PeerAnnounce|null} */
    #selfAnnounce = null;

    /**
     * Initialize discovery with a publish function and self peer ID.
     * @param {string} peerId
     * @param {Function} publishFn - (topic, data) => Promise<void>
     */
    init(peerId, publishFn) {
        this.#selfPeerId = peerId;
        this.#publishFn = publishFn;
    }

    /**
     * Handle an incoming peer announce message (from GossipSub).
     * @param {PeerAnnounce} announce
     */
    handleAnnounce(announce) {
        if (!announce.peerId || announce.peerId === this.#selfPeerId) return;

        const isNew = !this.#peers.has(announce.peerId);
        this.#peers.set(announce.peerId, { ...announce });

        if (isNew && this.#onPeerJoin) {
            this.#onPeerJoin(announce);
        }
    }

    /**
     * Start periodic self-announcement.
     * @param {Object} selfInfo - { shards, gpuCapability, bandwidth, reputation, uptime }
     */
    startAnnouncing(selfInfo) {
        this.#selfAnnounce = {
            peerId: this.#selfPeerId,
            ...selfInfo,
            timestamp: Date.now(),
        };

        // Announce immediately
        this.#announce();

        // Then periodically
        this.#announceTimer = setInterval(() => this.#announce(), ANNOUNCE_INTERVAL_MS);
    }

    /**
     * Stop announcing and clean up.
     */
    stopAnnouncing() {
        if (this.#announceTimer) {
            clearInterval(this.#announceTimer);
            this.#announceTimer = null;
        }
    }

    /** Lifecycle alias — called by cdi-node.js bootstrap. */
    start() {
        this.startAnnouncing({
            shards: [],
            gpuCapability: (typeof navigator !== 'undefined' && navigator.gpu) ? 'webgpu' : 'wasm-cpu',
            bandwidth: 0,
            reputation: 50,
            uptime: 0,
        });
    }
    /** Lifecycle alias. */
    stop() { this.stopAnnouncing(); }
    /**
     * Update self announce data (e.g., new shard claimed).
     * @param {Partial<PeerAnnounce>} updates
     */
    updateSelfInfo(updates) {
        if (this.#selfAnnounce) {
            Object.assign(this.#selfAnnounce, updates);
        }
    }

    /**
     * Evict peers that haven't announced recently.
     * @returns {string[]} Evicted peer IDs
     */
    evictStalePeers() {
        const now = Date.now();
        const evicted = [];
        for (const [peerId, peer] of this.#peers) {
            if (now - peer.timestamp > STALE_PEER_MS) {
                this.#peers.delete(peerId);
                evicted.push(peerId);
                if (this.#onPeerLeave) this.#onPeerLeave(peer);
            }
        }
        return evicted;
    }

    /**
     * Find peers hosting a specific shard.
     * @param {string} shardId
     * @returns {PeerAnnounce[]}
     */
    findPeersForShard(shardId) {
        return [...this.#peers.values()].filter(p => p.shards.includes(shardId));
    }

    /**
     * Find peers with WebGPU capability.
     * @returns {PeerAnnounce[]}
     */
    findGpuPeers() {
        return [...this.#peers.values()].filter(p => p.gpuCapability === 'webgpu');
    }

    /**
     * Get best relay candidate (highest uptime + reputation).
     * @returns {PeerAnnounce|null}
     */
    getBestRelayCandidate() {
        const candidates = [...this.#peers.values()]
            .filter(p => p.uptime > 3600) // At least 1h uptime
            .sort((a, b) => (b.reputation + b.uptime / 3600) - (a.reputation + a.uptime / 3600));
        return candidates[0] || null;
    }

    /**
     * Register peer join handler.
     * @param {Function} handler - (PeerAnnounce) => void
     */
    onPeerJoin(handler) { this.#onPeerJoin = handler; }

    /**
     * Register peer leave handler.
     * @param {Function} handler - (PeerAnnounce) => void
     */
    onPeerLeave(handler) { this.#onPeerLeave = handler; }

    /**
     * EventEmitter-style event handler (used by cdi-node.js bootstrap).
     * @param {string} event - 'peer:found' | 'peer:lost'
     * @param {Function} handler
     */
    on(event, handler) {
        if (event === 'peer:found') this.#onPeerJoin = handler;
        else if (event === 'peer:lost') this.#onPeerLeave = handler;
    }

    /** @returns {PeerAnnounce[]} All known peers */
    get peers() { return [...this.#peers.values()]; }

    /** @returns {number} */
    get peerCount() { return this.#peers.size; }

    /** @private */
    async #announce() {
        if (!this.#publishFn || !this.#selfAnnounce) return;
        this.#selfAnnounce.timestamp = Date.now();
        try {
            await this.#publishFn(TOPIC_PEER_ANNOUNCE, this.#selfAnnounce);
        } catch (err) {
            // Silently fail — network might not be ready
        }
    }
}
