/**
 * IMMUTABLE GENESIS CONSTANTS — CDI Network
 *
 * ⚠️  THESE VALUES ARE HARDCODED AND MUST NEVER BE MODIFIED.
 * ⚠️  They define the genesis authority, testnet→mainnet transition
 * ⚠️  rules, and tokenomics parameters. Any modification invalidates
 * ⚠️  the entire network state.
 *
 * The genesis miner's PUBLIC KEY is embedded here. The corresponding
 * private key lives ONLY in .secrets/genesis-miner.json (local, never pushed).
 */

// ── Genesis Authority ─────────────────────────────────────────────────
// This is the ONLY identity that can mine block #0 and seed models.
// The public key is derived from the Ed25519 keypair in .secrets/

export const GENESIS_MINER_PUBLIC_KEY =
    '302a300506032b65700321002e9c8afcf940970e12dc5e71f582d4cc153f493ff89f24e0f2e8e12d7becb9fd';

export const GENESIS_MINER_PEER_ID = 'CDI-3b3df609dbc480939941db534a6d3d1a';

// ── Tokenomics (immutable) ────────────────────────────────────────────

export const MAX_SUPPLY = 21_000_000;           // 21M CDI — hard cap, no inflation
export const GENESIS_ALLOCATION = 1_000_000;    // 1M CDI to genesis miner
export const PROVIDER_SHARE = 0.85;             // 85% of inference fees → providers
export const ECOSYSTEM_SHARE = 0.15;            // 15% → ecosystem (uploaders, improvers)
export const HALVING_INTERVAL = 210_000;        // Block reward halves every 210k blocks
export const INITIAL_BLOCK_REWARD = 50;         // 50 CDI per block (pre-halving)

// ── Mainnet Transition Rules (immutable) ──────────────────────────────
// These criteria CANNOT be changed. Mainnet activates automatically
// when ALL criteria are met. No governance vote, no admin override.

export const MAINNET_CRITERIA = Object.freeze({
    /** Minimum unique peers that have connected to the testnet */
    minPeers: 10,

    /** Minimum successful inference completions */
    minSuccessfulInferences: 100,

    /** Minimum inferences on large models (≥7B parameters) */
    minLargeModelInferences: 10,

    /** Minimum cumulative network uptime in hours */
    minUptimeHours: 24,

    /** Human-readable description */
    description: 'Mainnet auto-activates when testnet proves large LLM inference capability. No admin override possible.',
});

// ── Genesis Seed Models (immutable) ───────────────────────────────────
// These are the initial models loaded by the genesis miner in block #0.
// Additional models can be added by any node after genesis.

export const GENESIS_SEED_MODELS = Object.freeze([
    { name: 'LLaMA 3.1 8B', size: '4.7GB', family: 'Meta', category: 'chat' },
    { name: 'LLaMA 3.1 70B', size: '40GB', family: 'Meta', category: 'chat' },
    { name: 'Mistral 7B v0.3', size: '4.1GB', family: 'Mistral', category: 'chat' },
    { name: 'Qwen 2.5 7B', size: '4.4GB', family: 'Alibaba', category: 'chat' },
    { name: 'Gemma 2 9B', size: '5.4GB', family: 'Google', category: 'chat' },
    { name: 'Phi-4 14B', size: '7.9GB', family: 'Microsoft', category: 'reason' },
    { name: 'DeepSeek R1 8B', size: '4.9GB', family: 'DeepSeek', category: 'reason' },
    { name: 'DeepSeek Coder V2', size: '8.9GB', family: 'DeepSeek', category: 'code' },
    { name: 'StarCoder2 15B', size: '9.1GB', family: 'BigCode', category: 'code' },
    { name: 'LLaVA 1.6 13B', size: '7.8GB', family: 'LLaVA', category: 'vision' },
    { name: 'Whisper Large V3', size: '1.5GB', family: 'OpenAI', category: 'audio' },
    { name: 'Nomic Embed v1.5', size: '0.3GB', family: 'Nomic', category: 'embed' },
]);

// ── Network Configuration (immutable) ─────────────────────────────────

export const RELAY_BOOTSTRAP = Object.freeze([
    '/dns4/cdi-relay-1.fly.dev/tcp/443/wss/p2p-circuit',
    '/dns4/cdi-relay-2.fly.dev/tcp/443/wss/p2p-circuit',
]);

// ── Validation ────────────────────────────────────────────────────────

/**
 * Verify that a given public key matches the genesis miner authority.
 * This is the ONLY check needed to authorize genesis-level operations.
 */
export function isGenesisMiner(publicKeyHex) {
    return publicKeyHex === GENESIS_MINER_PUBLIC_KEY;
}

/**
 * Verify that a given peerId matches the genesis miner.
 */
export function isGenesisPeerId(peerId) {
    return peerId === GENESIS_MINER_PEER_ID;
}

/**
 * Check if all mainnet criteria are met.
 * Returns { ready: boolean, progress: {...} }
 */
export function checkMainnetReadiness(metrics) {
    const c = MAINNET_CRITERIA;
    const progress = {
        peers: { current: metrics.uniquePeers || 0, target: c.minPeers, met: (metrics.uniquePeers || 0) >= c.minPeers },
        inferences: { current: metrics.totalInferences || 0, target: c.minSuccessfulInferences, met: (metrics.totalInferences || 0) >= c.minSuccessfulInferences },
        largeModels: { current: metrics.largeModelInferences || 0, target: c.minLargeModelInferences, met: (metrics.largeModelInferences || 0) >= c.minLargeModelInferences },
        uptime: { current: metrics.uptimeHours || 0, target: c.minUptimeHours, met: (metrics.uptimeHours || 0) >= c.minUptimeHours },
    };
    const ready = progress.peers.met && progress.inferences.met && progress.largeModels.met && progress.uptime.met;
    return { ready, progress };
}
