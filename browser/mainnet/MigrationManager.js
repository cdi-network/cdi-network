/**
 * MigrationManager — Testnet → Mainnet state migration.
 *
 * Takes a snapshot of testnet state (balances, reputation, shards, governance)
 * and produces a migration manifest for mainnet genesis.
 *
 * @module browser/mainnet/MigrationManager
 */

/**
 * @typedef {Object} MigrationSnapshot
 * @property {string} networkId
 * @property {number} snapshotBlock
 * @property {number} timestamp
 * @property {Map<string, number>} balances
 * @property {Map<string, number>} reputation
 * @property {string[]} activeShards
 * @property {Object[]} activeProposals
 * @property {string} checksum
 */

import { createHash } from '../crypto-browser.js';

export class MigrationManager {
    #sourceNetworkId;
    #targetNetworkId;
    /** @type {MigrationSnapshot|null} */
    #snapshot = null;
    /** @type {boolean} */
    #migrated = false;
    /** @type {string[]} */
    #log = [];

    /**
     * @param {Object} opts
     * @param {string} opts.sourceNetworkId - e.g. 'cdi-testnet-v1'
     * @param {string} opts.targetNetworkId - e.g. 'cdi-mainnet-v1'
     */
    constructor({ sourceNetworkId, targetNetworkId }) {
        this.#sourceNetworkId = sourceNetworkId;
        this.#targetNetworkId = targetNetworkId;
    }

    /**
     * Create a snapshot of the testnet state.
     * @param {Object} state
     * @param {Map<string, number>|Object} state.balances
     * @param {Map<string, number>|Object} state.reputation
     * @param {string[]} state.activeShards
     * @param {Object[]} [state.activeProposals=[]]
     * @param {number} [state.blockNumber=0]
     * @returns {MigrationSnapshot}
     */
    createSnapshot(state) {
        const balances = state.balances instanceof Map
            ? state.balances
            : new Map(Object.entries(state.balances || {}));

        const reputation = state.reputation instanceof Map
            ? state.reputation
            : new Map(Object.entries(state.reputation || {}));

        // Compute checksum from serialized state
        const raw = JSON.stringify({
            balances: [...balances.entries()],
            reputation: [...reputation.entries()],
            shards: state.activeShards,
        });
        const checksum = createHash('sha256').update(raw).digest('hex');

        this.#snapshot = {
            networkId: this.#sourceNetworkId,
            snapshotBlock: state.blockNumber || 0,
            timestamp: Date.now(),
            balances,
            reputation,
            activeShards: state.activeShards || [],
            activeProposals: state.activeProposals || [],
            checksum,
        };

        this.#log.push(`Snapshot created: ${balances.size} balances, ${reputation.size} reputations, ${state.activeShards?.length || 0} shards`);
        return this.#snapshot;
    }

    /**
     * Validate snapshot integrity.
     * @returns {{ valid: boolean, errors: string[] }}
     */
    validateSnapshot() {
        if (!this.#snapshot) return { valid: false, errors: ['No snapshot created'] };

        const errors = [];
        if (this.#snapshot.balances.size === 0) errors.push('Empty balances');
        if (this.#snapshot.activeShards.length === 0) errors.push('No active shards');

        // Check for negative balances
        for (const [addr, bal] of this.#snapshot.balances) {
            if (bal < 0) errors.push(`Negative balance for ${addr}: ${bal}`);
        }

        return { valid: errors.length === 0, errors };
    }

    /**
     * Execute migration — produce mainnet genesis state.
     * @returns {{ genesisState: Object, migrationId: string }}
     */
    migrate() {
        if (!this.#snapshot) throw new Error('No snapshot to migrate');
        if (this.#migrated) throw new Error('Already migrated');

        const validation = this.validateSnapshot();
        if (!validation.valid) throw new Error(`Invalid snapshot: ${validation.errors.join(', ')}`);

        const migrationId = createHash('sha256')
            .update(`${this.#snapshot.checksum}-${this.#targetNetworkId}-${Date.now()}`)
            .digest('hex')
            .slice(0, 16);

        const genesisState = {
            networkId: this.#targetNetworkId,
            parentNetwork: this.#sourceNetworkId,
            snapshotChecksum: this.#snapshot.checksum,
            migrationId,
            balances: Object.fromEntries(this.#snapshot.balances),
            reputation: Object.fromEntries(this.#snapshot.reputation),
            activeShards: this.#snapshot.activeShards,
            timestamp: Date.now(),
        };

        this.#migrated = true;
        this.#log.push(`Migration complete: ${migrationId}`);
        return { genesisState, migrationId };
    }

    /** @returns {boolean} */
    get isMigrated() { return this.#migrated; }
    /** @returns {MigrationSnapshot|null} */
    get snapshot() { return this.#snapshot; }
    /** @returns {string[]} */
    get log() { return [...this.#log]; }
}
