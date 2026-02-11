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

// Tab-to-Tab P2P (BroadcastChannel), Genesis Block, Mainnet Gate
import { TabMesh, GenesisBlockMiner, MainnetGate } from './p2p/TabMesh.js';

// Immutable Genesis Constants (public key, tokenomics, mainnet criteria)
import {
    GENESIS_MINER_PUBLIC_KEY, GENESIS_MINER_PEER_ID,
    MAX_SUPPLY, GENESIS_ALLOCATION, PROVIDER_SHARE, ECOSYSTEM_SHARE,
    MAINNET_CRITERIA, GENESIS_SEED_MODELS, RELAY_BOOTSTRAP,
    isGenesisMiner, isGenesisPeerId, checkMainnetReadiness
} from './genesis/constants.js';

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
    tabMesh: null,
    genesisMiner: null,
    mainnetGate: null,

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

// ── MetaMask — In-Browser P2P Chain ───────────────────────────────────
// CDI chain (0xCD1 / 3281) lives entirely in the browser.
// No external RPC — the SPA handles all chain operations via BroadcastChannel + WebRTC.

const CDI_CHAIN = {
    chainId: '0xCD1',
    chainName: 'CDI Network',
    nativeCurrency: { name: 'CDI Token', symbol: 'CDI', decimals: 18 },
    rpcUrls: [window.location.origin + window.location.pathname],
    blockExplorerUrls: [window.location.origin + window.location.pathname],
};

export async function connectMetaMask() {
    if (!window.ethereum) {
        throw new Error('MetaMask or Brave Wallet not detected. Please install a Web3 wallet.');
    }

    // ① Request account access
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('No accounts found.');
    const ethAddress = accounts[0];
    NODE.ethAddress = ethAddress;

    // ② Auto-add CDI Network chain to MetaMask (no external RPC)
    try {
        await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [CDI_CHAIN],
        });
        console.log('[CDI] CDI chain (0xCD1) added to MetaMask');
    } catch (e) {
        // Chain may already exist — that's fine
        console.log('[CDI] CDI chain already registered or user declined:', e.message);
    }

    const wallet = NODE.wallet;
    if (!wallet) throw new Error('CDI wallet not initialized');

    // ③ EIP-712 binding: ETH address ↔ CDI peerId (on CDI chain, chainId=3281)
    const bindingMessage = {
        domain: { name: 'CDI Network', version: '1', chainId: 3281 },
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

    // ④ Check if this is the genesis miner
    const isGenesis = ethAddress.toLowerCase() === NODE.ethAddress?.toLowerCase() &&
        isGenesisPeerId(wallet.peer_id);

    localStorage.setItem('cdi_eth_binding', JSON.stringify({
        ethAddress, cdiPeerId: wallet.peer_id, signature,
        timestamp: bindingMessage.message.timestamp,
        isGenesisMiner: isGenesis,
        chainId: 3281,
    }));

    emit('wallet:bound', { ethAddress, cdiPeerId: wallet.peer_id, isGenesisMiner: isGenesis });
    return { ethAddress, cdiPeerId: wallet.peer_id, signature, isGenesisMiner: isGenesis };
}

export function getStoredBinding() {
    const s = localStorage.getItem('cdi_eth_binding');
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
}

// ── Full Node Bootstrap ───────────────────────────────────────────────

/**
 * Start node in testnet mode WITHOUT MetaMask.
 * Derives a pseudo-ETH address from Ed25519 public key.
 * All subsystems work identically — only MetaMask binding is skipped.
 */
export async function startNodeTestnet() {
    if (!NODE.wallet) throw new Error('Wallet not initialized');
    // Derive pseudo-ETH address from public key (0x + first 40 hex chars)
    const pubHex = NODE.wallet.public_key_hex || NODE.wallet.publicKey || '';
    NODE.ethAddress = '0x' + pubHex.slice(0, 40).padEnd(40, '0');
    NODE.testnetOnly = true;
    console.log('[CDI] Testnet mode (no MetaMask) — derived address:', NODE.ethAddress);
    return _startNodeInternal();
}

export async function startNode() {
    if (!NODE.wallet) throw new Error('Wallet not initialized');
    if (!NODE.ethAddress) throw new Error('MetaMask not connected');
    return _startNodeInternal();
}

async function _startNodeInternal() {

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

    // ⑧ Genesis Block — mined by YOU, seeded with immutable GENESIS_SEED_MODELS
    console.log('[CDI] Checking genesis block...');
    NODE.genesisMiner = new GenesisBlockMiner({ peerId, ethAddress: NODE.ethAddress });
    if (!NODE.genesisMiner.isGenesisMined()) {
        console.log('[CDI] ⛏️ Mining genesis block #0 with', GENESIS_SEED_MODELS.length, 'seed models...');
        NODE.genesisMiner.mineGenesisBlock([...GENESIS_SEED_MODELS]);
        emit('genesis:mined', { miner: peerId, models: GENESIS_SEED_MODELS.length });
    } else {
        emit('genesis:loaded', NODE.genesisMiner.getGenesisBlock());
    }

    // ⑨ Testnet specifics
    if (NODE.network === 'testnet') {
        console.log('[CDI] Testnet mode — loading config...');
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

    // ⑩ MainnetGate — auto-mainnet when testnet proves large LLM inference
    const genesisBlock = NODE.genesisMiner.getGenesisBlock();
    NODE.mainnetGate = new MainnetGate({
        genesis: genesisBlock,
        onMainnet: (progress) => {
            NODE.network = 'mainnet';
            console.log('[CDI] 🚀 MAINNET ACTIVATED!', progress);
            emit('mainnet:activated', progress);
        },
    });

    // ⑪ TabMesh — BroadcastChannel P2P for same-origin tabs
    console.log('[CDI] Starting TabMesh (tab-to-tab P2P)...');
    NODE.tabMesh = new TabMesh({
        peerId,
        ethAddress: NODE.ethAddress,
        onPeer: (peer) => {
            NODE.peers.push(peer);
            NODE.reputation.addPeer?.(peer.peerId);
            NODE.mainnetGate.recordPeer(peer.peerId);
            emit('peer:connected', { peerId: peer.peerId, total: NODE.tabMesh.getPeerCount(), shards: 0 });
        },
        onPeerLost: (peer) => {
            NODE.peers = NODE.peers.filter(p => p.peerId !== peer.peerId);
            emit('peer:disconnected', { peerId: peer.peerId, total: NODE.tabMesh.getPeerCount() });
        },
        onMessage: (msg) => {
            if (msg.type === 'mainnet:trigger') {
                NODE.network = 'mainnet';
                emit('mainnet:activated', msg.proof);
            }
        },
        onInferenceReq: async (req) => {
            // Distributed inference: another tab requested inference, we execute locally
            try {
                const result = await NODE.executor.execute?.({ prompt: req.prompt, model: req.model });
                NODE.tabMesh.respondInference(req.id, result);
                NODE.inferences++;
                emit('inference:complete', { output: result, distributed: true });
            } catch (e) { /* can't execute this model */ }
        },
    });
    // Wire metrics for heartbeat
    NODE.tabMesh._getUptime = () => NODE.uptime;
    NODE.tabMesh._getInferences = () => NODE.inferences;
    NODE.tabMesh._getEarnings = () => NODE.earnings;
    NODE.tabMesh.start();

    // ⑫ Start libp2p peer discovery (for cross-origin peers)
    NODE.discovery.start();
    NODE.discovery.on('peer:found', (peer) => {
        NODE.peers.push(peer);
        NODE.reputation.addPeer?.(peer.id);
        NODE.mainnetGate.recordPeer(peer.id);
        emit('peer:connected', { peerId: peer.id, total: NODE.peers.length });
    });

    // ⑬ Uptime counter + MainnetGate uptime tracking
    setInterval(() => {
        NODE.uptime = Math.floor((Date.now() - NODE.startTime) / 1000);
        NODE.mainnetGate.recordUptime(NODE.uptime);
    }, 1000);

    console.log('[CDI] ✅ Node fully started', {
        peerId: peerId.slice(0, 16) + '...',
        ethAddress: NODE.ethAddress.slice(0, 10) + '...',
        network: NODE.network,
        webgpu: hasWebGPU,
        genesisBlock: genesisBlock?.blockNumber === 0 ? 'mined' : 'loaded',
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
    NODE.mainnetGate?.recordInference(model, model);
    return result;
}

// ── Node Status ───────────────────────────────────────────────────────

export function getNodeStatus() {
    return {
        running: NODE.startTime !== null,
        peerId: NODE.wallet?.peer_id || null,
        ethAddress: NODE.ethAddress,
        peers: NODE.tabMesh ? NODE.tabMesh.getPeerCount() : NODE.peers.length,
        shards: NODE.shards.length,
        earnings: NODE.earnings,
        uptime: NODE.uptime,
        inferences: NODE.inferences,
        network: NODE.network,
        webgpu: !!navigator.gpu,
        genesisBlock: NODE.genesisMiner?.getGenesisBlock() || null,
        mainnetProgress: NODE.mainnetGate?.getProgress() || null,
        tabPeers: NODE.tabMesh?.getPeers() || [],
        networkStats: NODE.tabMesh?.getNetworkStats() || {},
        subsystems: {
            p2p: !!NODE.p2p,
            tabMesh: !!NODE.tabMesh,
            helia: !!NODE.helia,
            ledger: !!NODE.ledger,
            executor: !!NODE.executor,
            security: !!NODE.rateLimiter,
            catalog: !!NODE.catalog,
            pipeline: !!NODE.pipeline,
            governance: !!NODE.governance,
            genesis: !!NODE.genesisMiner?.isGenesisMined(),
            mainnetGate: !!NODE.mainnetGate,
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
export function isTestnetOnly() { return !!NODE.testnetOnly; }
