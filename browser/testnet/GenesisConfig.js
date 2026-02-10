/**
 * GenesisConfig — Testnet bootstrap configuration.
 *
 * Defines initial relay nodes, seed shards, genesis parameters,
 * and network-level constants for the CDI testnet launch.
 *
 * @module browser/testnet/GenesisConfig
 */

/**
 * @typedef {Object} RelayNode
 * @property {string} peerId
 * @property {string} multiaddr
 * @property {string} region   - 'eu-west' | 'us-east' | 'asia-se' | 'latam' | 'africa'
 * @property {number} capacity - Max concurrent connections
 */

/**
 * @typedef {Object} SeedShard
 * @property {string} modelId
 * @property {string} shardId
 * @property {string} cid
 * @property {number[]} layerRange
 */

const GENESIS_DEFAULTS = {
    networkId: 'cdi-testnet-v1',
    chainEpoch: 0,
    genesisTimestamp: null, // Set at launch
    maxNodesPerRelay: 50,
    minStakeForRelay: 500,  // CDI
    initialSupply: 10_000_000,
    blockTime: 12_000,      // ms (target per epoch)
    epochLength: 100,       // blocks per epoch
    rewardPerEpoch: 1000,   // CDI distributed per epoch
    slashingPenalty: 0.10,  // 10% slash for misbehaviour
};

export class GenesisConfig {
    #config;
    /** @type {RelayNode[]} */
    #bootstrapRelays = [];
    /** @type {SeedShard[]} */
    #seedShards = [];
    /** @type {boolean} */
    #finalized = false;

    constructor(overrides = {}) {
        this.#config = { ...GENESIS_DEFAULTS, ...overrides };
    }

    /**
     * Add a bootstrap relay node.
     * @param {RelayNode} relay
     * @returns {this}
     */
    addRelay(relay) {
        if (this.#finalized) throw new Error('Genesis config is finalized');
        if (!relay.peerId || !relay.multiaddr || !relay.region) {
            throw new Error('Relay requires peerId, multiaddr, region');
        }
        if (this.#bootstrapRelays.some(r => r.peerId === relay.peerId)) {
            throw new Error(`Duplicate relay: ${relay.peerId}`);
        }
        this.#bootstrapRelays.push({ capacity: 50, ...relay });
        return this;
    }

    /**
     * Add a seed shard (pre-loaded on genesis).
     * @param {SeedShard} shard
     * @returns {this}
     */
    addSeedShard(shard) {
        if (this.#finalized) throw new Error('Genesis config is finalized');
        if (!shard.modelId || !shard.shardId) {
            throw new Error('Seed shard requires modelId, shardId');
        }
        this.#seedShards.push(shard);
        return this;
    }

    /**
     * Finalize genesis config — no more changes allowed.
     * Sets genesisTimestamp if not already set.
     * @returns {Object} Frozen genesis config
     */
    finalize() {
        if (this.#finalized) throw new Error('Already finalized');

        if (this.#bootstrapRelays.length < 1) {
            throw new Error('Need at least 1 bootstrap relay');
        }

        this.#config.genesisTimestamp = this.#config.genesisTimestamp || Date.now();
        this.#finalized = true;

        return this.toJSON();
    }

    /**
     * Validate that genesis config meets minimum requirements.
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validate() {
        const errors = [];

        if (this.#bootstrapRelays.length < 1) {
            errors.push('At least 1 bootstrap relay required');
        }
        if (this.#seedShards.length < 1) {
            errors.push('At least 1 seed shard required for initial inference');
        }

        // Check relay geo-diversity
        const regions = new Set(this.#bootstrapRelays.map(r => r.region));
        if (regions.size < Math.min(2, this.#bootstrapRelays.length)) {
            errors.push('Bootstrap relays should span multiple regions');
        }

        if (this.#config.initialSupply <= 0) {
            errors.push('Initial supply must be positive');
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Export as JSON (for genesis block).
     */
    toJSON() {
        return {
            ...this.#config,
            bootstrapRelays: [...this.#bootstrapRelays],
            seedShards: [...this.#seedShards],
            finalized: this.#finalized,
        };
    }

    /** @returns {boolean} */
    get isFinalized() { return this.#finalized; }
    /** @returns {RelayNode[]} */
    get relays() { return [...this.#bootstrapRelays]; }
    /** @returns {SeedShard[]} */
    get seedShards() { return [...this.#seedShards]; }
    /** @returns {string} */
    get networkId() { return this.#config.networkId; }
    /** @returns {number} */
    get initialSupply() { return this.#config.initialSupply; }
}
