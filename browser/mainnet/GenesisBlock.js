/**
 * GenesisBlock — Block #0 for CDI mainnet.
 *
 * Produces the genesis block containing catalog, treasury,
 * bootstrap relays, and migrated testnet state.
 *
 * @module browser/mainnet/GenesisBlock
 */

import { createHash } from '../crypto-browser.js';

export class GenesisBlock {
    #block = null;

    constructor() { }

    /**
     * Create the genesis block.
     * @param {Object} config
     * @param {string} config.networkId
     * @param {number} config.initialSupply
     * @param {Object} config.genesisState   - From MigrationManager
     * @param {Object[]} config.bootstrapRelays
     * @param {Object[]} config.seedShards
     * @param {string} [config.treasuryAddress='treasury']
     * @returns {Object} The genesis block
     */
    create(config) {
        if (this.#block) throw new Error('Genesis block already created');
        if (!config.networkId) throw new Error('networkId required');

        const block = {
            blockNumber: 0,
            networkId: config.networkId,
            timestamp: Date.now(),
            parentHash: '0'.repeat(64),
            stateRoot: null,

            // Treasury
            treasury: {
                address: config.treasuryAddress || 'treasury',
                initialSupply: config.initialSupply || 10_000_000,
            },

            // Bootstrap infrastructure
            bootstrapRelays: config.bootstrapRelays || [],
            seedShards: config.seedShards || [],

            // Migrated state
            genesisState: config.genesisState || {},

            // Genesis ceremony metadata
            ceremony: {
                createdBy: 'CDI Network Foundation',
                version: '1.0.0',
                consensus: 'proof-of-inference',
            },
        };

        // Compute state root hash
        const stateData = JSON.stringify({
            treasury: block.treasury,
            relays: block.bootstrapRelays.map(r => r.peerId),
            shards: block.seedShards.map(s => s.shardId),
            state: block.genesisState,
        });
        block.stateRoot = createHash('sha256').update(stateData).digest('hex');

        // Compute block hash
        block.hash = createHash('sha256')
            .update(`${block.blockNumber}:${block.parentHash}:${block.stateRoot}:${block.timestamp}`)
            .digest('hex');

        this.#block = block;
        return block;
    }

    /**
     * Verify genesis block integrity.
     * @returns {{ valid: boolean, checks: Object }}
     */
    verify() {
        if (!this.#block) return { valid: false, checks: { exists: false } };

        const checks = {
            exists: true,
            blockNumberZero: this.#block.blockNumber === 0,
            hasHash: this.#block.hash?.length === 64,
            hasStateRoot: this.#block.stateRoot?.length === 64,
            hasTreasury: this.#block.treasury?.initialSupply > 0,
            hasRelays: this.#block.bootstrapRelays?.length > 0,
        };

        return {
            valid: Object.values(checks).every(v => v === true),
            checks,
        };
    }

    /** @returns {Object|null} */
    get block() { return this.#block ? { ...this.#block } : null; }
}
