/**
 * CDI Browser Node — Full P2P inference node running in the browser.
 *
 * Responsibilities:
 * 1. Load WASM module (wallet, signing, tokenomics)
 * 2. MetaMask wallet connection (mandatory)
 * 3. P2P networking via WebRTC (planned: libp2p integration)
 * 4. Shard execution coordination (planned: WebGPU)
 * 5. OrbitDB state management (planned: Helia integration)
 *
 * This module provides the core CdiNode class that the UI interacts with.
 */

import init, { CdiWallet, signTransaction, verifyTransaction, splitFee, shardReward, blockReward } from './pkg/cdi_wasm.js';

// ── Node State ────────────────────────────────────────────────────────

const NODE_STATE = {
    initialized: false,
    wallet: null,
    ethAddress: null,
    peers: [],
    shards: [],
    earnings: 0,
    uptime: 0,
    startTime: null,
    network: 'testnet', // 'testnet' | 'mainnet'
};

// ── WASM Initialization ───────────────────────────────────────────────

export async function initWasm() {
    if (NODE_STATE.initialized) return;
    await init();
    NODE_STATE.initialized = true;
    console.log('[CDI] WASM module loaded');
}

// ── Wallet Management ─────────────────────────────────────────────────

export function createWallet() {
    const wallet = new CdiWallet();
    NODE_STATE.wallet = wallet;
    persistWallet(wallet);
    return {
        peerId: wallet.peer_id,
        publicKey: wallet.public_key_hex,
    };
}

export function loadWallet() {
    const stored = localStorage.getItem('cdi_wallet');
    if (!stored) return null;
    try {
        const wallet = CdiWallet.fromJson(stored);
        NODE_STATE.wallet = wallet;
        return {
            peerId: wallet.peer_id,
            publicKey: wallet.public_key_hex,
        };
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

// ── MetaMask Integration ──────────────────────────────────────────────

export async function connectMetaMask() {
    if (!window.ethereum) {
        throw new Error('MetaMask or Brave Wallet not detected. Please install a Web3 wallet.');
    }

    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) {
        throw new Error('No accounts found. Please unlock your wallet.');
    }

    const ethAddress = accounts[0];
    NODE_STATE.ethAddress = ethAddress;

    // Create EIP-712 binding: ETH address ↔ CDI peerId
    const wallet = NODE_STATE.wallet;
    if (!wallet) throw new Error('CDI wallet not initialized');

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

    try {
        const signature = await window.ethereum.request({
            method: 'eth_signTypedData_v4',
            params: [ethAddress, JSON.stringify(bindingMessage)],
        });

        console.log('[CDI] Wallet bound:', ethAddress.slice(0, 10) + '...', '→', wallet.peer_id.slice(0, 16) + '...');

        // Store binding
        localStorage.setItem('cdi_eth_binding', JSON.stringify({
            ethAddress,
            cdiPeerId: wallet.peer_id,
            signature,
            timestamp: bindingMessage.message.timestamp,
        }));

        return { ethAddress, cdiPeerId: wallet.peer_id, signature };
    } catch (e) {
        throw new Error('Wallet binding rejected: ' + e.message);
    }
}

export function getStoredBinding() {
    const stored = localStorage.getItem('cdi_eth_binding');
    if (!stored) return null;
    try {
        return JSON.parse(stored);
    } catch {
        return null;
    }
}

// ── Node Lifecycle ────────────────────────────────────────────────────

export async function startNode() {
    if (!NODE_STATE.wallet) throw new Error('Wallet not initialized');
    if (!NODE_STATE.ethAddress) throw new Error('MetaMask not connected');

    NODE_STATE.startTime = Date.now();

    // TODO: Initialize libp2p with WebRTC transport
    // TODO: Initialize Helia (IPFS in browser)
    // TODO: Initialize OrbitDB over Helia
    // TODO: Start ShardExecutor (WebGPU)
    // TODO: Register in shard registry

    console.log('[CDI] Node started', {
        peerId: NODE_STATE.wallet.peer_id.slice(0, 16) + '...',
        ethAddress: NODE_STATE.ethAddress.slice(0, 10) + '...',
        network: NODE_STATE.network,
    });

    // Start uptime counter
    setInterval(() => {
        NODE_STATE.uptime = Math.floor((Date.now() - NODE_STATE.startTime) / 1000);
    }, 1000);

    return getNodeStatus();
}

export function getNodeStatus() {
    return {
        running: NODE_STATE.startTime !== null,
        peerId: NODE_STATE.wallet?.peer_id || null,
        ethAddress: NODE_STATE.ethAddress,
        peers: NODE_STATE.peers.length,
        shards: NODE_STATE.shards.length,
        earnings: NODE_STATE.earnings,
        uptime: NODE_STATE.uptime,
        network: NODE_STATE.network,
    };
}

// ── Transaction Helpers ───────────────────────────────────────────────

export function createTransaction(to, amount, txType) {
    if (!NODE_STATE.wallet) throw new Error('Wallet not initialized');
    return signTransaction(NODE_STATE.wallet, to, amount, txType, Date.now());
}

export function verifyTx(signedTxJson) {
    return verifyTransaction(signedTxJson);
}

// ── Tokenomics Helpers ────────────────────────────────────────────────

export function calculateFeeSplit(totalFee) {
    return splitFee(totalFee);
}

export function calculateShardReward(totalFee, shardWeight, totalWeight) {
    return shardReward(totalFee, shardWeight, totalWeight);
}

export function calculateBlockReward(epoch) {
    return blockReward(epoch);
}

// ── Export node state for UI ──────────────────────────────────────────

export function getState() {
    return { ...NODE_STATE };
}
