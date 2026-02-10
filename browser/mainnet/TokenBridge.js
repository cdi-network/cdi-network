/**
 * TokenBridge — CDI ↔ ERC-20 bridge for L2 interoperability.
 *
 * Manages lock/mint pattern for bridging CDI tokens between
 * the CDI network and an EVM-compatible L2 chain.
 *
 * @module browser/mainnet/TokenBridge
 */

import { createHash } from 'node:crypto';

/**
 * @typedef {Object} BridgeTransaction
 * @property {string} txId
 * @property {'lock'|'mint'|'burn'|'release'} type
 * @property {string} from
 * @property {string} to
 * @property {number} amount
 * @property {'cdi'|'erc20'} sourceChain
 * @property {'cdi'|'erc20'} targetChain
 * @property {'pending'|'confirmed'|'failed'} status
 * @property {number} timestamp
 * @property {string} proofHash
 */

export class TokenBridge {
    /** @type {BridgeTransaction[]} */
    #transactions = [];
    /** @type {Map<string, number>} locked CDI by address */
    #lockedBalances = new Map();
    /** @type {number} */
    #totalLocked = 0;
    /** @type {number} */
    #totalBridged = 0;

    constructor() { }

    /**
     * Lock CDI tokens on CDI network → mint ERC-20 on L2.
     * @param {string} cdiAddress
     * @param {string} evmAddress
     * @param {number} amount
     * @returns {BridgeTransaction}
     */
    lockAndMint(cdiAddress, evmAddress, amount) {
        if (amount <= 0) throw new Error('Amount must be positive');

        const tx = this.#createTx({
            type: 'lock',
            from: cdiAddress,
            to: evmAddress,
            amount,
            sourceChain: 'cdi',
            targetChain: 'erc20',
        });

        // Lock on CDI side
        const current = this.#lockedBalances.get(cdiAddress) || 0;
        this.#lockedBalances.set(cdiAddress, current + amount);
        this.#totalLocked += amount;
        this.#totalBridged += amount;

        return tx;
    }

    /**
     * Burn ERC-20 on L2 → release CDI on CDI network.
     * @param {string} evmAddress
     * @param {string} cdiAddress
     * @param {number} amount
     * @returns {BridgeTransaction}
     */
    burnAndRelease(evmAddress, cdiAddress, amount) {
        if (amount <= 0) throw new Error('Amount must be positive');

        const locked = this.#lockedBalances.get(cdiAddress) || 0;
        if (locked < amount) {
            throw new Error(`Insufficient locked balance: ${locked} < ${amount}`);
        }

        const tx = this.#createTx({
            type: 'release',
            from: evmAddress,
            to: cdiAddress,
            amount,
            sourceChain: 'erc20',
            targetChain: 'cdi',
        });

        this.#lockedBalances.set(cdiAddress, locked - amount);
        this.#totalLocked -= amount;

        return tx;
    }

    /**
     * Get bridge status for an address.
     * @param {string} address
     * @returns {{ locked: number, transactions: BridgeTransaction[] }}
     */
    getStatus(address) {
        return {
            locked: this.#lockedBalances.get(address) || 0,
            transactions: this.#transactions.filter(
                t => t.from === address || t.to === address
            ),
        };
    }

    /**
     * Get bridge stats.
     * @returns {{ totalLocked: number, totalBridged: number, transactionCount: number }}
     */
    getStats() {
        return {
            totalLocked: this.#totalLocked,
            totalBridged: this.#totalBridged,
            transactionCount: this.#transactions.length,
        };
    }

    /** @returns {BridgeTransaction[]} All transactions */
    get transactions() { return [...this.#transactions]; }

    /** @private */
    #createTx(data) {
        const proofHash = createHash('sha256')
            .update(`${data.from}:${data.to}:${data.amount}:${Date.now()}`)
            .digest('hex');

        const tx = {
            txId: `bridge-${this.#transactions.length}-${proofHash.slice(0, 8)}`,
            status: 'confirmed',
            timestamp: Date.now(),
            proofHash,
            ...data,
        };

        this.#transactions.push(tx);
        return tx;
    }
}
