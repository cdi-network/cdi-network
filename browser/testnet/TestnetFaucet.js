/**
 * TestnetFaucet — Airdrop mechanism for testnet participants.
 *
 * Rewards:
 * - 10 CDI: Wallet connection
 * - 50 CDI: First shard hosted
 * - 20 CDI: First inference participation
 * - 20 CDI: 24h uptime bonus
 * Total: 100 CDI per node
 *
 * @module browser/testnet/TestnetFaucet
 */

export const TESTNET_REWARDS = {
    WALLET_CONNECT: { type: 'wallet_connect', amount: 10 },
    SHARD_HOSTING: { type: 'shard_hosting', amount: 50 },
    FIRST_INFERENCE: { type: 'first_inference', amount: 20 },
    UPTIME_BONUS: { type: 'uptime_bonus', amount: 20 },
};

export const MAX_PER_NODE = 100;

export class TestnetFaucet {
    /** @type {Map<string, {rewards: Map<string, number>, total: number}>} */
    #ledger = new Map();
    /** @type {string} */
    #network;

    /**
     * @param {'testnet'|'mainnet'} network
     */
    constructor(network = 'testnet') {
        this.#network = network;
    }

    /**
     * Claim a testnet reward.
     * @param {string} walletAddress - MetaMask address
     * @param {string} rewardType - One of TESTNET_REWARDS keys
     * @returns {{ success: boolean, amount: number, balance: number, reason?: string }}
     */
    claimReward(walletAddress, rewardType) {
        if (this.#network !== 'testnet') {
            return { success: false, amount: 0, balance: 0, reason: 'Faucet only available on testnet' };
        }

        const reward = Object.values(TESTNET_REWARDS).find(r => r.type === rewardType);
        if (!reward) {
            return { success: false, amount: 0, balance: this.#getBalance(walletAddress), reason: `Unknown reward type: ${rewardType}` };
        }

        // Initialize ledger entry
        if (!this.#ledger.has(walletAddress)) {
            this.#ledger.set(walletAddress, { rewards: new Map(), total: 0 });
        }

        const entry = this.#ledger.get(walletAddress);

        // Check if already claimed this reward
        if (entry.rewards.has(rewardType)) {
            return { success: false, amount: 0, balance: entry.total, reason: `Already claimed: ${rewardType}` };
        }

        // Check max per node
        if (entry.total + reward.amount > MAX_PER_NODE) {
            return { success: false, amount: 0, balance: entry.total, reason: 'Max airdrop reached' };
        }

        // Grant reward
        entry.rewards.set(rewardType, reward.amount);
        entry.total += reward.amount;

        return { success: true, amount: reward.amount, balance: entry.total };
    }

    /**
     * Get the balance for a wallet.
     * @param {string} walletAddress
     * @returns {number}
     */
    getBalance(walletAddress) {
        return this.#getBalance(walletAddress);
    }

    /**
     * Get all rewards claimed by a wallet.
     * @param {string} walletAddress
     * @returns {Map<string, number>}
     */
    getRewards(walletAddress) {
        const entry = this.#ledger.get(walletAddress);
        return entry ? new Map(entry.rewards) : new Map();
    }

    /**
     * Check if a wallet has claimed a specific reward.
     * @param {string} walletAddress
     * @param {string} rewardType
     * @returns {boolean}
     */
    hasClaimed(walletAddress, rewardType) {
        const entry = this.#ledger.get(walletAddress);
        return entry ? entry.rewards.has(rewardType) : false;
    }

    /**
     * Get total CDI distributed across all wallets.
     * @returns {number}
     */
    get totalDistributed() {
        let total = 0;
        for (const entry of this.#ledger.values()) total += entry.total;
        return total;
    }

    /**
     * Get number of unique wallets.
     * @returns {number}
     */
    get walletCount() {
        return this.#ledger.size;
    }

    /** @private */
    #getBalance(walletAddress) {
        const entry = this.#ledger.get(walletAddress);
        return entry ? entry.total : 0;
    }
}
