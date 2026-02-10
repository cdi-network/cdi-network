/**
 * ReputationSystem — Peer reputation tracking for CDI network.
 *
 * Scores nodes based on inference quality, uptime,
 * shard hosting reliability, and governance participation.
 *
 * @module browser/security/ReputationSystem
 */

const DEFAULT_INITIAL_SCORE = 50;
const MIN_SCORE = 0;
const MAX_SCORE = 100;

/**
 * @typedef {Object} ReputationEvent
 * @property {'inference_success'|'inference_fail'|'shard_hosted'|'shard_dropped'|'governance_vote'|'latency_report'} type
 * @property {number} delta - Score change
 * @property {number} timestamp
 */

const EVENT_DELTAS = {
    inference_success: +2,
    inference_fail: -5,
    shard_hosted: +3,
    shard_dropped: -10,
    governance_vote: +1,
    latency_report: 0, // dynamic based on latency
    uptime_hour: +0.5,
    protocol_violation: -20,
};

export class ReputationSystem {
    /** @type {Map<string, { score: number, history: ReputationEvent[] }>} */
    #peers = new Map();

    constructor() { }

    /**
     * Record a reputation event for a peer.
     * @param {string} peerId
     * @param {string} eventType
     * @param {Object} [opts]
     * @param {number} [opts.latencyMs]  - For latency_report events
     * @param {number} [opts.customDelta] - Override automatic delta
     * @returns {{ score: number, delta: number }}
     */
    recordEvent(peerId, eventType, opts = {}) {
        const peer = this.#getOrCreate(peerId);

        let delta = opts.customDelta ?? EVENT_DELTAS[eventType];
        if (delta === undefined) throw new Error(`Unknown event type: ${eventType}`);

        // Dynamic delta for latency reports
        if (eventType === 'latency_report' && opts.latencyMs != null) {
            delta = opts.latencyMs < 1000 ? +1 : opts.latencyMs < 5000 ? 0 : -2;
        }

        peer.score = Math.max(MIN_SCORE, Math.min(MAX_SCORE, peer.score + delta));
        peer.history.push({ type: eventType, delta, timestamp: Date.now() });

        return { score: peer.score, delta };
    }

    /**
     * Get current reputation score.
     * @param {string} peerId
     * @returns {number}
     */
    getScore(peerId) {
        return this.#getOrCreate(peerId).score;
    }

    /**
     * Get reputation tier.
     * @param {string} peerId
     * @returns {'trusted'|'normal'|'suspicious'|'banned'}
     */
    getTier(peerId) {
        const score = this.getScore(peerId);
        if (score >= 80) return 'trusted';
        if (score >= 40) return 'normal';
        if (score >= 10) return 'suspicious';
        return 'banned';
    }

    /**
     * Check if peer is allowed to participate.
     * @param {string} peerId
     * @returns {boolean}
     */
    isAllowed(peerId) {
        return this.getTier(peerId) !== 'banned';
    }

    /**
     * Get top peers by reputation.
     * @param {number} [limit=10]
     * @returns {{ peerId: string, score: number }[]}
     */
    getLeaderboard(limit = 10) {
        return [...this.#peers.entries()]
            .map(([peerId, data]) => ({ peerId, score: data.score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    /**
     * Decay all scores slightly (call periodically, e.g. each epoch).
     * @param {number} [factor=0.99] Multiplicative decay
     */
    decayAll(factor = 0.99) {
        for (const data of this.#peers.values()) {
            data.score = Math.max(MIN_SCORE, data.score * factor);
        }
    }

    /** @returns {number} Peer count */
    get peerCount() { return this.#peers.size; }

    /** @private */
    #getOrCreate(peerId) {
        if (!this.#peers.has(peerId)) {
            this.#peers.set(peerId, { score: DEFAULT_INITIAL_SCORE, history: [] });
        }
        return this.#peers.get(peerId);
    }
}
