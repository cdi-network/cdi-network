/**
 * CDI Browser Node — Full-stack P2P inference node in the browser.
 *
 * Bootstraps ALL subsystems:
 *   WASM wallet → P2P (libp2p/WebRTC) → Storage (Helia/OrbitDB) →
 *   Compute (WebGPU) → Security (Rate/Reputation/Sybil/ZKP) →
 *   Catalog (models) → Governance → Testnet/Mainnet
 *
 * When someone opens the GitHub Pages URL, this module turns their
 * browser tab into a fully functional CDI network node.
 */

import init, {
    CdiWallet, signTransaction, verifyTransaction,
    splitFee, shardReward, blockReward
} from './pkg/cdi_wasm.js';

// ── Subsystem imports ─────────────────────────────────────────────────
// P2P Layer
import { LibP2PNode } from './p2p/LibP2PNode.js';
import { PeerDiscovery } from './p2p/PeerDiscovery.js';
import { ActivationRelay } from './p2p/ActivationRelay.js';

// Storage Layer
import { HeliaManager } from './storage/HeliaManager.js';
import { LedgerStore } from './storage/LedgerStore.js';

// Compute Layer
import { ShardExecutor } from './compute/ShardExecutor.js';
import { ComputeShaders } from './compute/ComputeShaders.js';
import { ModelLoader } from './compute/ModelLoader.js';
import { FallbackExecutor } from './compute/FallbackExecutor.js';

// Security Layer
import { RateLimiter } from './security/RateLimiter.js';
import { ReputationSystem } from './security/ReputationSystem.js';
import { SybilGuard } from './security/SybilGuard.js';
import { ProofAggregator } from './security/ProofAggregator.js';

// Catalog
import { ModelCatalog } from './catalog/ModelCatalog.js';
import { ModelSharder } from './catalog/ModelSharder.js';

// Sharding & Pipeline
import { ShardRegistry } from './sharding/ShardRegistry.js';
import { PipelineOrchestrator } from './sharding/PipelineOrchestrator.js';

// Governance
import { GovernanceStore } from './governance/GovernanceStore.js';

// Network
import { AutoBalancer } from './network/AutoBalancer.js';

// Testnet
import { GenesisConfig } from './testnet/GenesisConfig.js';
import { HealthMonitor } from './testnet/HealthMonitor.js';
import { TestnetFaucet } from './testnet/TestnetFaucet.js';
import { NetworkDashboard } from './testnet/NetworkDashboard.js';

// ── Node State ────────────────────────────────────────────────────────

const NODE = {
    initialized: false,
    wallet: null,
    ethAddress: null,
    startTime: null,
    network: 'testnet',

    // Subsystem instances
    p2p: null,
    discovery: null,
    relay: null,
    helia: null,
    ledger: null,
    executor: null,
    shaders: null,
    modelLoader: null,
    fallback: null,
    rateLimiter: null,
    reputation: null,
    sybilGuard: null,
    proofAggregator: null,
    catalog: null,
    sharder: null,
    shardRegistry: null,
    pipeline: null,
    governance: null,
    autoBalancer: null,
    genesis: null,
    healthMonitor: null,
    faucet: null,
    dashboard: null,

    // Runtime metrics
    peers: [],
    shards: [],
    earnings: 0,
    uptime: 0,
    inferences: 0,
};

// Event listeners for UI updates
const _listeners = [];
function emit(event, data) {
    _listeners.forEach(fn => { try { fn(event, data); } catch (e) { /* */ } });
}

export function onNodeEvent(fn) {
    _listeners.push(fn);
    return () => { const i = _listeners.indexOf(fn); if (i >= 0) _listeners.splice(i, 1); };
}

// ── WASM ──────────────────────────────────────────────────────────────

export async function initWasm() {
    if (NODE.initialized) return;
    await init();
    NODE.initialized = true;
    emit('wasm:ready', {});
    console.log('[CDI] WASM module loaded');
}

// ── Wallet ────────────────────────────────────────────────────────────

export function createWallet() {
    const wallet = new CdiWallet();
    NODE.wallet = wallet;
    persistWallet(wallet);
    return { peerId: wallet.peer_id, publicKey: wallet.public_key_hex };
}

export function loadWallet() {
    const stored = localStorage.getItem('cdi_wallet');
    if (!stored) return null;
    try {
        const wallet = CdiWallet.fromJson(stored);
        NODE.wallet = wallet;
        return { peerId: wallet.peer_id, publicKey: wallet.public_key_hex };
    } catch (e) {
        console.warn('[CDI] Failed to load wallet:', e);
        return null;
    }
}

export function loadOrCreateWallet() {
    return loadWallet() || createWallet();
}

function persistWallet(wallet) {
    localStorage.setItem('cdi_wallet', wallet.export_json());
}

// ── MetaMask ──────────────────────────────────────────────────────────

export async function connectMetaMask() {
    if (!window.ethereum) {
        throw new Error('MetaMask or Brave Wallet not detected. Please install a Web3 wallet.');
    }
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('No accounts found.');

    const ethAddress = accounts[0];
    NODE.ethAddress = ethAddress;

    const wallet = NODE.wallet;
    if (!wallet) throw new Error('CDI wallet not initialized');

    // EIP-712 binding: ETH address ↔ CDI peerId
    const bindingMessage = {
        domain: { name: 'CDI Network', version: '1', chainId: 1 },
        types: {
            EIP712Domain: [
                { name: 'name', type: 'string' },
                { name: 'version', type: 'string' },
                { name: 'chainId', type: 'uint256' },
            ],
            NodeBinding: [
                { name: 'ethAddress', type: 'address' },
                { name: 'cdiPeerId', type: 'string' },
                { name: 'timestamp', type: 'uint256' },
            ],
        },
        primaryType: 'NodeBinding',
        message: {
            ethAddress,
            cdiPeerId: wallet.peer_id,
            timestamp: Math.floor(Date.now() / 1000),
        },
    };

    const signature = await window.ethereum.request({
        method: 'eth_signTypedData_v4',
        params: [ethAddress, JSON.stringify(bindingMessage)],
    });

    localStorage.setItem('cdi_eth_binding', JSON.stringify({
        ethAddress, cdiPeerId: wallet.peer_id, signature,
        timestamp: bindingMessage.message.timestamp,
    }));

    emit('wallet:bound', { ethAddress, cdiPeerId: wallet.peer_id });
    return { ethAddress, cdiPeerId: wallet.peer_id, signature };
}

export function getStoredBinding() {
    const s = localStorage.getItem('cdi_eth_binding');
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

// ── Full Node Bootstrap ───────────────────────────────────────────────

export async function startNode() {
    if (!NODE.wallet) throw new Error('Wallet not initialized');
    if (!NODE.ethAddress) throw new Error('MetaMask not connected');

    const peerId = NODE.wallet.peer_id;
    NODE.startTime = Date.now();
    emit('node:starting', { peerId });

    // ① P2P Layer — WebRTC + GossipSub
    console.log('[CDI] Initializing P2P layer...');
    NODE.p2p = new LibP2PNode({ peerId });
    NODE.discovery = new PeerDiscovery(NODE.p2p);
    NODE.relay = new ActivationRelay(NODE.p2p);
    await NODE.p2p.start();
    emit('p2p:started', { peerId });

    // ② Storage Layer — Helia (IPFS) + Distributed Ledger
    console.log('[CDI] Initializing Helia + OrbitDB...');
    NODE.helia = new HeliaManager({ libp2p: NODE.p2p });
    await NODE.helia.start();
    NODE.ledger = new LedgerStore(NODE.helia);
    await NODE.ledger.open();
    emit('storage:ready', {});

    // ③ Compute Layer — WebGPU shaders + fallback CPU
    console.log('[CDI] Initializing Compute (WebGPU)...');
    NODE.shaders = new ComputeShaders();
    NODE.modelLoader = new ModelLoader(NODE.helia);
    NODE.fallback = new FallbackExecutor();
    const hasWebGPU = !!navigator.gpu;
    if (hasWebGPU) {
        NODE.executor = new ShardExecutor({
            shaders: NODE.shaders,
            modelLoader: NODE.modelLoader,
            fallback: NODE.fallback,
        });
        await NODE.executor.init();
        emit('compute:webgpu', {});
    } else {
        NODE.executor = NODE.fallback;
        emit('compute:cpu', {});
    }

    // ④ Security Layer
    console.log('[CDI] Initializing Security stack...');
    NODE.rateLimiter = new RateLimiter();
    NODE.reputation = new ReputationSystem();
    NODE.sybilGuard = new SybilGuard({ rateLimiter: NODE.rateLimiter });
    NODE.proofAggregator = new ProofAggregator();
    emit('security:ready', {});

    // ⑤ Model Catalog + Sharding
    console.log('[CDI] Loading Model Catalog...');
    NODE.catalog = new ModelCatalog(NODE.helia);
    NODE.sharder = new ModelSharder();
    NODE.shardRegistry = new ShardRegistry();
    NODE.pipeline = new PipelineOrchestrator({
        executor: NODE.executor,
        shardRegistry: NODE.shardRegistry,
        ledger: NODE.ledger,
        proofAggregator: NODE.proofAggregator,
    });
    emit('catalog:ready', { models: NODE.catalog.listModels?.() || [] });

    // ⑥ Governance
    console.log('[CDI] Initializing Governance...');
    NODE.governance = new GovernanceStore(NODE.ledger);
    emit('governance:ready', {});

    // ⑦ Network Auto-balancer
    NODE.autoBalancer = new AutoBalancer({
        p2p: NODE.p2p,
        shardRegistry: NODE.shardRegistry,
        executor: NODE.executor,
    });

    // ⑧ Testnet specifics
    if (NODE.network === 'testnet') {
        console.log('[CDI] Testnet mode — loading genesis config...');
        NODE.genesis = new GenesisConfig();
        NODE.healthMonitor = new HealthMonitor(NODE.p2p);
        NODE.faucet = new TestnetFaucet(NODE.ledger);
        NODE.dashboard = new NetworkDashboard({
            healthMonitor: NODE.healthMonitor,
            shardRegistry: NODE.shardRegistry,
            catalog: NODE.catalog,
        });

        // Claim wallet_connect reward
        try {
            NODE.faucet.claimReward(peerId, 'wallet_connect');
            NODE.earnings += 10;
            emit('faucet:claimed', { type: 'wallet_connect', amount: 10 });
        } catch (e) { /* already claimed */ }
    }

    // ⑨ Start peer discovery
    NODE.discovery.start();
    NODE.discovery.on('peer:found', (peer) => {
        NODE.peers.push(peer);
        NODE.reputation.addPeer?.(peer.id);
        emit('peer:connected', { peerId: peer.id, total: NODE.peers.length });
    });

    // ⑩ Uptime counter
    setInterval(() => {
        NODE.uptime = Math.floor((Date.now() - NODE.startTime) / 1000);
    }, 1000);

    console.log('[CDI] ✅ Node fully started', {
        peerId: peerId.slice(0, 16) + '...',
        ethAddress: NODE.ethAddress.slice(0, 10) + '...',
        network: NODE.network,
        webgpu: hasWebGPU,
        subsystems: [
            'P2P', 'Helia', 'Ledger', 'WebGPU', 'Security',
            'Catalog', 'Pipeline', 'Governance', 'AutoBalancer',
            NODE.network === 'testnet' ? 'Testnet' : 'Mainnet',
        ].join(' → '),
    });

    emit('node:ready', getNodeStatus());
    return getNodeStatus();
}

// ── Inference ─────────────────────────────────────────────────────────

export async function runInference(prompt, modelId) {
    if (!NODE.pipeline) throw new Error('Node not started');

    // Rate-limit check
    const allowed = NODE.rateLimiter.tryConsume?.(NODE.ethAddress, 'inference') ?? true;
    if (!allowed) throw new Error('Rate limited. Try again shortly.');

    NODE.inferences++;
    emit('inference:start', { prompt, modelId });

    // Find model shards
    const model = modelId || 'llama3.1:8b';
    const shards = NODE.shardRegistry.getShardsForModel?.(model) || [];

    if (shards.length === 0) {
        // Direct local execution if available
        const result = await NODE.executor.execute?.({ prompt, model }) ||
            { output: `[Testnet] Inference queued for "${model}". Awaiting shard peers.`, status: 'queued' };
        emit('inference:complete', result);
        return result;
    }

    // Distributed pipeline execution
    const result = await NODE.pipeline.execute?.({ prompt, model, shards });

    // ZKP commitment
    if (result && NODE.proofAggregator) {
        const proof = NODE.proofAggregator.addCommitment?.({
            input: prompt,
            output: result.output,
            model,
            peerId: NODE.wallet.peer_id,
        });
        if (proof) result.proof = proof;
    }

    // Fee split & reward
    const fee = 1.0; // base fee in CDI
    const split = splitFee(fee);
    NODE.earnings += split.provider_share;
    NODE.ledger.recordTransaction?.({
        from: 'network',
        to: NODE.wallet.peer_id,
        amount: split.provider_share,
        type: 'inference_reward',
    });

    emit('inference:complete', { ...result, earnings: split.provider_share });
    return result;
}

// ── Node Status ───────────────────────────────────────────────────────

export function getNodeStatus() {
    return {
        running: NODE.startTime !== null,
        peerId: NODE.wallet?.peer_id || null,
        ethAddress: NODE.ethAddress,
        peers: NODE.peers.length,
        shards: NODE.shards.length,
        earnings: NODE.earnings,
        uptime: NODE.uptime,
        inferences: NODE.inferences,
        network: NODE.network,
        webgpu: !!navigator.gpu,
        subsystems: {
            p2p: !!NODE.p2p,
            helia: !!NODE.helia,
            ledger: !!NODE.ledger,
            executor: !!NODE.executor,
            security: !!NODE.rateLimiter,
            catalog: !!NODE.catalog,
            pipeline: !!NODE.pipeline,
            governance: !!NODE.governance,
        },
    };
}

// ── Transaction Helpers ───────────────────────────────────────────────

export function createTransaction(to, amount, txType) {
    if (!NODE.wallet) throw new Error('Wallet not initialized');
    return signTransaction(NODE.wallet, to, amount, txType, Date.now());
}

export function verifyTx(signedTxJson) {
    return verifyTransaction(signedTxJson);
}

// ── Tokenomics Helpers ────────────────────────────────────────────────

export function calculateFeeSplit(totalFee) { return splitFee(totalFee); }
export function calculateShardReward(totalFee, w, tw) { return shardReward(totalFee, w, tw); }
export function calculateBlockReward(epoch) { return blockReward(epoch); }

// ── Subsystem access (for advanced UI) ────────────────────────────────

export function getSubsystems() {
    return {
        p2p: NODE.p2p,
        discovery: NODE.discovery,
        relay: NODE.relay,
        helia: NODE.helia,
        ledger: NODE.ledger,
        executor: NODE.executor,
        catalog: NODE.catalog,
        pipeline: NODE.pipeline,
        governance: NODE.governance,
        healthMonitor: NODE.healthMonitor,
        faucet: NODE.faucet,
        dashboard: NODE.dashboard,
        rateLimiter: NODE.rateLimiter,
        reputation: NODE.reputation,
        sybilGuard: NODE.sybilGuard,
        proofAggregator: NODE.proofAggregator,
    };
}

export function getState() { return { ...NODE }; }
