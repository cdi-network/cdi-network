/**
 * LedgerStore — OrbitDB-backed CDI transaction ledger.
 *
 * Records all CDI token transactions: rewards, fees, burns, transfers.
 * Provides balance queries and transaction history.
 *
 * @module browser/storage/LedgerStore
 */

import { createHash } from '../crypto-browser.js';

/**
 * @typedef {Object} Transaction
 * @property {string} txId
 * @property {string} from
 * @property {string} to
 * @property {number} amount
 * @property {string} txType     - 'reward' | 'fee' | 'burn' | 'transfer' | 'mint'
 * @property {number} timestamp
 * @property {string} signature  - Ed25519 signature (hex)
 * @property {string} [memo]     - Optional memo
 */

export class LedgerStore {
    /** @type {Transaction[]} */
    #transactions = [];
    /** @type {Map<string, number>} address → balance */
    #balances = new Map();
    /** @type {string} */
    #dbName;

    /**
     * @param {string} [dbName='cdi-ledger']
     */
    constructor(dbName = 'cdi-ledger') {
        this.#dbName = dbName;
    }

    /** Lifecycle — no-op (in-memory store is ready after construction). */
    async open() { return this; }
    async close() { return this; }

    /**
     * Record a new transaction.
     * @param {Omit<Transaction, 'txId'>} tx
     * @returns {Transaction}
     */
    recordTransaction(tx) {
        if (!tx.from || !tx.to || tx.amount == null || !tx.txType) {
            throw new Error('Transaction requires from, to, amount, txType');
        }
        if (tx.amount <= 0) {
            throw new Error('Transaction amount must be positive');
        }

        // Check sender balance (except for mints)
        if (tx.txType !== 'mint') {
            const senderBalance = this.getBalance(tx.from);
            if (senderBalance < tx.amount) {
                throw new Error(`Insufficient balance: ${senderBalance} < ${tx.amount}`);
            }
        }

        const txId = this.#generateTxId(tx);
        const record = { ...tx, txId, timestamp: tx.timestamp || Date.now() };

        this.#transactions.push(record);

        // Update balances
        if (tx.txType !== 'mint') {
            this.#balances.set(tx.from, (this.#balances.get(tx.from) || 0) - tx.amount);
        }
        if (tx.txType !== 'burn') {
            this.#balances.set(tx.to, (this.#balances.get(tx.to) || 0) + tx.amount);
        }

        return record;
    }

    /**
     * Get balance for an address.
     * @param {string} address
     * @returns {number}
     */
    getBalance(address) {
        return this.#balances.get(address) || 0;
    }

    /**
     * Get transaction history for an address.
     * @param {string} address
     * @param {number} [limit=50]
     * @returns {Transaction[]}
     */
    getHistory(address, limit = 50) {
        return this.#transactions
            .filter(tx => tx.from === address || tx.to === address)
            .slice(-limit);
    }

    /**
     * Get all transactions of a specific type.
     * @param {string} txType
     * @returns {Transaction[]}
     */
    getByType(txType) {
        return this.#transactions.filter(tx => tx.txType === txType);
    }

    /**
     * Total CDI minted (sum of all mint transactions).
     * @returns {number}
     */
    get totalMinted() {
        return this.getByType('mint').reduce((sum, tx) => sum + tx.amount, 0);
    }

    /**
     * Total CDI burned.
     * @returns {number}
     */
    get totalBurned() {
        return this.getByType('burn').reduce((sum, tx) => sum + tx.amount, 0);
    }

    /**
     * Circulating supply = minted - burned.
     * @returns {number}
     */
    get circulatingSupply() {
        return this.totalMinted - this.totalBurned;
    }

    /** @returns {number} */
    get transactionCount() { return this.#transactions.length; }
    /** @returns {string} */
    get dbName() { return this.#dbName; }

    /**
     * Verify ledger consistency: sum of all balances = minted - burned.
     * @returns {{ valid: boolean, balanceSum: number, expected: number }}
     */
    audit() {
        let balanceSum = 0;
        for (const balance of this.#balances.values()) {
            balanceSum += balance;
        }
        const expected = this.totalMinted - this.totalBurned;
        return {
            valid: Math.abs(balanceSum - expected) < 1e-10,
            balanceSum,
            expected,
        };
    }

    /** @private */
    #generateTxId(tx) {
        const hash = createHash('sha256')
            .update(`${tx.from}:${tx.to}:${tx.amount}:${Date.now()}:${Math.random()}`)
            .digest('hex');
        return hash.slice(0, 16);
    }
}
