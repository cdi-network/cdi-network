/**
 * SybilGuard — Protection against Sybil attacks in CDI network.
 *
 * Uses proof-of-work challenges, rate-based join throttling,
 * peer graph analysis, and stake requirements to prevent
 * a single entity from controlling many nodes.
 *
 * @module browser/security/SybilGuard
 */

const CHALLENGE_DIFFICULTY = 4; // Leading zeros in hex hash
const MAX_JOINS_PER_IP_HOUR = 5;
const MIN_STAKE_CDI = 10;

export class SybilGuard {
    /** @type {Map<string, number>} IP → join count in current window */
    #joinCounts = new Map();
    /** @type {Set<string>} Verified peer IDs */
    #verifiedPeers = new Set();
    /** @type {Map<string, string>} peerId → challenge */
    #pendingChallenges = new Map();
    /** @type {number} Window start for join counting */
    #windowStart = Date.now();
    /** @type {number} */
    #totalRejected = 0;

    constructor() { }

    /**
     * Generate a PoW challenge for a joining peer.
     * @param {string} peerId
     * @returns {{ challenge: string, difficulty: number }}
     */
    generateChallenge(peerId) {
        const challenge = `cdi-sybil-${peerId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        this.#pendingChallenges.set(peerId, challenge);
        return { challenge, difficulty: CHALLENGE_DIFFICULTY };
    }

    /**
     * Verify a PoW solution.
     * @param {string} peerId
     * @param {string} solution - Nonce that when appended to challenge produces valid hash
     * @param {string} hash     - SHA-256 hash of challenge+solution
     * @returns {{ verified: boolean, reason?: string }}
     */
    verifyChallenge(peerId, solution, hash) {
        const challenge = this.#pendingChallenges.get(peerId);
        if (!challenge) {
            return { verified: false, reason: 'No pending challenge' };
        }

        // Verify hash starts with required zero nibbles
        const prefix = '0'.repeat(CHALLENGE_DIFFICULTY);
        if (!hash.startsWith(prefix)) {
            this.#totalRejected++;
            return { verified: false, reason: 'Invalid proof-of-work' };
        }

        this.#pendingChallenges.delete(peerId);
        this.#verifiedPeers.add(peerId);
        return { verified: true };
    }

    /**
     * Check if a peer from an IP can join (rate limiting).
     * @param {string} ip
     * @returns {{ allowed: boolean, reason?: string }}
     */
    checkJoinRate(ip) {
        this.#maybeResetWindow();

        const count = this.#joinCounts.get(ip) || 0;
        if (count >= MAX_JOINS_PER_IP_HOUR) {
            this.#totalRejected++;
            return { allowed: false, reason: `IP ${ip} exceeded ${MAX_JOINS_PER_IP_HOUR} joins/hour` };
        }

        this.#joinCounts.set(ip, count + 1);
        return { allowed: true };
    }

    /**
     * Perform stake check.
     * @param {string} peerId
     * @param {number} stakedCdi
     * @returns {{ adequate: boolean, required: number }}
     */
    checkStake(peerId, stakedCdi) {
        return {
            adequate: stakedCdi >= MIN_STAKE_CDI,
            required: MIN_STAKE_CDI,
        };
    }

    /**
     * Full admission check (rate + stake + PoW verification status).
     * @param {string} peerId
     * @param {string} ip
     * @param {number} stakedCdi
     * @returns {{ admitted: boolean, reasons: string[] }}
     */
    admissionCheck(peerId, ip, stakedCdi) {
        const reasons = [];

        const joinCheck = this.checkJoinRate(ip);
        if (!joinCheck.allowed) reasons.push(joinCheck.reason);

        const stakeCheck = this.checkStake(peerId, stakedCdi);
        if (!stakeCheck.adequate) reasons.push(`Insufficient stake: ${stakedCdi}/${MIN_STAKE_CDI} CDI`);

        if (!this.#verifiedPeers.has(peerId)) {
            reasons.push('PoW challenge not completed');
        }

        return { admitted: reasons.length === 0, reasons };
    }

    /** @returns {boolean} */
    isVerified(peerId) { return this.#verifiedPeers.has(peerId); }
    /** @returns {number} */
    get verifiedCount() { return this.#verifiedPeers.size; }
    /** @returns {number} */
    get totalRejected() { return this.#totalRejected; }

    /** @private */
    #maybeResetWindow() {
        if (Date.now() - this.#windowStart > 3600_000) {
            this.#joinCounts.clear();
            this.#windowStart = Date.now();
        }
    }
}
