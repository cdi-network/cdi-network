/**
 * TabMesh — BroadcastChannel-based P2P discovery for same-origin tabs.
 *
 * When 3-4 browser tabs open the GitHub Pages URL, they discover each other
 * via BroadcastChannel (same-origin = same domain). No server needed.
 *
 * Protocol:
 *   announce  → { type:'announce', peerId, ethAddress, shards, gpu, ts }
 *   heartbeat → { type:'heartbeat', peerId, uptime, inferences, earnings }
 *   inference → { type:'inference:req', id, prompt, model, from }
 *              { type:'inference:res', id, output, peerId }
 *   governance → { type:'vote', proposalId, peerId, vote }
 *   mainnet   → { type:'mainnet:trigger', proof, ts }
 */

const CHANNEL_NAME = 'cdi-network-mesh';
const HEARTBEAT_MS = 3000;
const PEER_TIMEOUT_MS = 12000;

export class TabMesh {
    constructor({ peerId, ethAddress, onPeer, onPeerLost, onMessage, onInferenceReq }) {
        this.peerId = peerId;
        this.ethAddress = ethAddress;
        this.onPeer = onPeer || (() => { });
        this.onPeerLost = onPeerLost || (() => { });
        this.onMessage = onMessage || (() => { });
        this.onInferenceReq = onInferenceReq || (() => { });

        this.peers = new Map(); // peerId → { ethAddress, shards, gpu, lastSeen, uptime, inferences, earnings }
        this.channel = null;
        this._hbInterval = null;
        this._gcInterval = null;
        this._started = false;
    }

    start() {
        if (this._started) return;
        this._started = true;

        this.channel = new BroadcastChannel(CHANNEL_NAME);
        this.channel.onmessage = (ev) => this._handleMessage(ev.data);

        // Announce ourselves immediately
        this._announce();

        // Heartbeat loop
        this._hbInterval = setInterval(() => this._heartbeat(), HEARTBEAT_MS);

        // GC stale peers
        this._gcInterval = setInterval(() => this._gc(), HEARTBEAT_MS * 2);

        console.log(`[TabMesh] Started — peerId=${this.peerId.slice(0, 12)}…`);
    }

    stop() {
        if (!this._started) return;
        this._started = false;
        clearInterval(this._hbInterval);
        clearInterval(this._gcInterval);
        this.channel?.close();
        this.peers.clear();
    }

    // ── Send ──

    send(msg) {
        if (!this.channel) return;
        this.channel.postMessage({ ...msg, from: this.peerId });
    }

    _announce() {
        this.send({
            type: 'announce',
            peerId: this.peerId,
            ethAddress: this.ethAddress,
            shards: this._getLocalShards(),
            gpu: !!navigator.gpu,
            ts: Date.now(),
        });
    }

    _heartbeat() {
        this.send({
            type: 'heartbeat',
            peerId: this.peerId,
            uptime: this._getUptime(),
            inferences: this._getInferences(),
            earnings: this._getEarnings(),
        });
    }

    // Sent an inference request to all peers
    requestInference(id, prompt, model) {
        this.send({ type: 'inference:req', id, prompt, model });
    }

    // Respond to an inference request
    respondInference(id, output) {
        this.send({ type: 'inference:res', id, output, peerId: this.peerId });
    }

    // ── Vote ──
    broadcastVote(proposalId, vote) {
        this.send({ type: 'vote', proposalId, peerId: this.peerId, vote });
    }

    // ── Mainnet trigger ──
    broadcastMainnetTrigger(proof) {
        this.send({ type: 'mainnet:trigger', proof, ts: Date.now() });
    }

    // ── Receive ──

    _handleMessage(data) {
        if (!data || data.from === this.peerId) return; // Ignore own messages

        switch (data.type) {
            case 'announce': {
                const isNew = !this.peers.has(data.peerId);
                this.peers.set(data.peerId, {
                    ethAddress: data.ethAddress,
                    shards: data.shards || [],
                    gpu: data.gpu,
                    lastSeen: Date.now(),
                    uptime: 0,
                    inferences: 0,
                    earnings: 0,
                });
                if (isNew) {
                    console.log(`[TabMesh] Peer discovered: ${data.peerId.slice(0, 12)}…`);
                    this.onPeer({
                        peerId: data.peerId,
                        ethAddress: data.ethAddress,
                        gpu: data.gpu,
                        total: this.peers.size,
                    });
                    // Re-announce so the new peer knows about us
                    this._announce();
                }
                break;
            }
            case 'heartbeat': {
                const peer = this.peers.get(data.peerId);
                if (peer) {
                    peer.lastSeen = Date.now();
                    peer.uptime = data.uptime;
                    peer.inferences = data.inferences;
                    peer.earnings = data.earnings;
                }
                break;
            }
            case 'inference:req': {
                this.onInferenceReq(data);
                break;
            }
            default:
                this.onMessage(data);
        }
    }

    _gc() {
        const now = Date.now();
        for (const [pid, p] of this.peers) {
            if (now - p.lastSeen > PEER_TIMEOUT_MS) {
                this.peers.delete(pid);
                console.log(`[TabMesh] Peer lost: ${pid.slice(0, 12)}…`);
                this.onPeerLost({ peerId: pid, total: this.peers.size });
            }
        }
    }

    // ── Status ──

    getPeers() {
        return Array.from(this.peers.entries()).map(([id, p]) => ({ peerId: id, ...p }));
    }

    getPeerCount() { return this.peers.size; }

    getNetworkStats() {
        const peers = this.getPeers();
        return {
            peerCount: peers.length,
            totalInferences: peers.reduce((a, p) => a + (p.inferences || 0), 0),
            totalEarnings: peers.reduce((a, p) => a + (p.earnings || 0), 0),
            gpuNodes: peers.filter(p => p.gpu).length,
        };
    }

    // Hooks — overridden by cdi-node.js wiring
    _getLocalShards() { return []; }
    _getUptime() { return 0; }
    _getInferences() { return 0; }
    _getEarnings() { return 0; }
}

/**
 * GenesisBlockMiner — The first node mines the genesis block.
 *
 * Rules:
 *   - The genesis miner (you) loads the initial model catalog
 *   - Genesis block contains: treasury allocation, relay config, seed models
 *   - Only ONE genesis block can exist (persisted in localStorage)
 */
export class GenesisBlockMiner {
    constructor({ peerId, ethAddress }) {
        this.peerId = peerId;
        this.ethAddress = ethAddress;
    }

    isGenesisMined() {
        return !!localStorage.getItem('cdi_genesis_block');
    }

    getGenesisBlock() {
        const s = localStorage.getItem('cdi_genesis_block');
        return s ? JSON.parse(s) : null;
    }

    mineGenesisBlock(seedModels) {
        if (this.isGenesisMined()) {
            console.log('[Genesis] Block already mined');
            return this.getGenesisBlock();
        }

        const genesis = {
            blockNumber: 0,
            hash: this._sha256Hex(`genesis-${this.peerId}-${Date.now()}`),
            timestamp: Date.now(),
            miner: {
                peerId: this.peerId,
                ethAddress: this.ethAddress,
            },
            network: 'testnet',
            treasury: {
                totalSupply: 21_000_000,
                genesisAllocation: 1_000_000, // 1M CDI to genesis miner
                providerShare: 0.85,
                ecosystemShare: 0.15,
            },
            seedModels: seedModels.map(m => ({
                id: m.id || m.name.toLowerCase().replace(/\s+/g, '-'),
                name: m.name,
                size: m.size,
                family: m.family,
                category: m.category || 'chat',
                uploadedBy: this.peerId,
                timestamp: Date.now(),
            })),
            relayBootstrap: [
                '/dns4/cdi-relay-1.fly.dev/tcp/443/wss/p2p-circuit',
                '/dns4/cdi-relay-2.fly.dev/tcp/443/wss/p2p-circuit',
            ],
            mainnetCriteria: {
                minPeers: 10,
                minSuccessfulInferences: 100,
                minLargeModelInferences: 10, // ≥7B params
                minUptimeHours: 24,
                description: 'Mainnet auto-activates when testnet proves large LLM inference capability',
            },
            ceremony: {
                message: 'CDI Network Genesis — Collaborative Distributed Inference',
                creator: this.ethAddress,
            },
        };

        localStorage.setItem('cdi_genesis_block', JSON.stringify(genesis));
        console.log('[Genesis] ⛏️ Block #0 mined!', genesis);
        return genesis;
    }

    _sha256Hex(str) {
        // Simple hash for genesis — real SHA-256 would use crypto.subtle
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const c = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + c;
            hash |= 0;
        }
        return '0x' + Math.abs(hash).toString(16).padStart(16, '0') + Date.now().toString(16);
    }
}

/**
 * MainnetGate — Monitors testnet metrics and auto-triggers mainnet.
 *
 * Criteria (from genesis block):
 *   - ≥10 unique peers seen
 *   - ≥100 successful inferences
 *   - ≥10 inferences on large models (≥7B)
 *   - ≥24h cumulative network uptime
 */
export class MainnetGate {
    constructor({ genesis, onMainnet }) {
        this.criteria = genesis?.mainnetCriteria || {
            minPeers: 10,
            minSuccessfulInferences: 100,
            minLargeModelInferences: 10,
            minUptimeHours: 24,
        };
        this.onMainnet = onMainnet || (() => { });
        this.triggered = false;

        // Tracked metrics
        this.metrics = {
            uniquePeers: new Set(),
            totalInferences: 0,
            largeModelInferences: 0,
            networkUptimeSeconds: 0,
        };

        // Load persisted metrics
        this._load();
    }

    recordPeer(peerId) {
        this.metrics.uniquePeers.add(peerId);
        this._save();
        this._check();
    }

    recordInference(modelId, params) {
        this.metrics.totalInferences++;
        // Models ≥7B are considered "large"
        const sizeStr = (params || '').toString();
        if (sizeStr.includes('7b') || sizeStr.includes('8b') || sizeStr.includes('9b') ||
            sizeStr.includes('13b') || sizeStr.includes('14b') || sizeStr.includes('15b') ||
            sizeStr.includes('70b') || sizeStr.includes('large') || parseInt(sizeStr) >= 7) {
            this.metrics.largeModelInferences++;
        }
        this._save();
        this._check();
    }

    recordUptime(seconds) {
        this.metrics.networkUptimeSeconds = seconds;
        this._save();
        this._check();
    }

    getProgress() {
        const c = this.criteria;
        return {
            peers: { current: this.metrics.uniquePeers.size, target: c.minPeers, pct: Math.min(100, Math.round(this.metrics.uniquePeers.size / c.minPeers * 100)) },
            inferences: { current: this.metrics.totalInferences, target: c.minSuccessfulInferences, pct: Math.min(100, Math.round(this.metrics.totalInferences / c.minSuccessfulInferences * 100)) },
            largeModels: { current: this.metrics.largeModelInferences, target: c.minLargeModelInferences, pct: Math.min(100, Math.round(this.metrics.largeModelInferences / c.minLargeModelInferences * 100)) },
            uptime: { current: Math.round(this.metrics.networkUptimeSeconds / 3600), target: c.minUptimeHours, pct: Math.min(100, Math.round(this.metrics.networkUptimeSeconds / 3600 / c.minUptimeHours * 100)) },
            overall: 0, // computed below
            ready: false,
        };
    }

    _check() {
        if (this.triggered) return;
        const p = this.getProgress();
        p.overall = Math.round((p.peers.pct + p.inferences.pct + p.largeModels.pct + p.uptime.pct) / 4);
        p.ready = p.peers.pct >= 100 && p.inferences.pct >= 100 && p.largeModels.pct >= 100 && p.uptime.pct >= 100;

        if (p.ready) {
            this.triggered = true;
            console.log('[MainnetGate] 🚀 ALL CRITERIA MET — Triggering mainnet!');
            this.onMainnet(p);
        }
    }

    _save() {
        localStorage.setItem('cdi_mainnet_metrics', JSON.stringify({
            uniquePeers: [...this.metrics.uniquePeers],
            totalInferences: this.metrics.totalInferences,
            largeModelInferences: this.metrics.largeModelInferences,
            networkUptimeSeconds: this.metrics.networkUptimeSeconds,
        }));
    }

    _load() {
        const s = localStorage.getItem('cdi_mainnet_metrics');
        if (!s) return;
        try {
            const d = JSON.parse(s);
            this.metrics.uniquePeers = new Set(d.uniquePeers || []);
            this.metrics.totalInferences = d.totalInferences || 0;
            this.metrics.largeModelInferences = d.largeModelInferences || 0;
            this.metrics.networkUptimeSeconds = d.networkUptimeSeconds || 0;
        } catch (e) { }
    }
}
