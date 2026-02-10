/**
 * RateLimiter — Token-bucket rate limiter for CDI network requests.
 *
 * Prevents spam/abuse by limiting inference requests, gossip messages,
 * and API calls per peer.
 *
 * @module browser/security/RateLimiter
 */

/**
 * @typedef {Object} BucketConfig
 * @property {number} maxTokens   - Maximum burst capacity
 * @property {number} refillRate  - Tokens added per second
 */

const DEFAULT_CONFIGS = {
    inference: { maxTokens: 10, refillRate: 2 },   // 2 req/s default, burst 10
    gossip: { maxTokens: 50, refillRate: 20 },   // 20 msg/s, burst 50
    relay: { maxTokens: 20, refillRate: 5 },    // 5/s, burst 20
};

export class RateLimiter {
    /** @type {Map<string, Map<string, { tokens: number, lastRefill: number }>>} */
    #buckets = new Map(); // peerId → { category → bucket }
    /** @type {Object<string, BucketConfig>} */
    #configs;
    /** @type {number} */
    #totalRejected = 0;

    /**
     * @param {Object<string, BucketConfig>} [configs] - Override defaults
     */
    constructor(configs = {}) {
        this.#configs = { ...DEFAULT_CONFIGS, ...configs };
    }

    /**
     * Check and consume a token.
     * @param {string} peerId
     * @param {string} [category='inference']
     * @returns {{ allowed: boolean, remaining: number, retryAfterMs: number }}
     */
    consume(peerId, category = 'inference') {
        const config = this.#configs[category];
        if (!config) throw new Error(`Unknown rate limit category: ${category}`);

        const bucket = this.#getBucket(peerId, category);
        this.#refill(bucket, config);

        if (bucket.tokens >= 1) {
            bucket.tokens -= 1;
            return { allowed: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
        }

        this.#totalRejected++;
        const retryAfterMs = Math.ceil((1 - bucket.tokens) / config.refillRate * 1000);
        return { allowed: false, remaining: 0, retryAfterMs };
    }

    /**
     * Check if a request would be allowed (without consuming).
     * @param {string} peerId
     * @param {string} [category='inference']
     * @returns {boolean}
     */
    canConsume(peerId, category = 'inference') {
        const config = this.#configs[category];
        if (!config) return false;
        const bucket = this.#getBucket(peerId, category);
        this.#refill(bucket, config);
        return bucket.tokens >= 1;
    }

    /**
     * Reset limits for a peer (e.g., after reputation upgrade).
     * @param {string} peerId
     */
    reset(peerId) {
        this.#buckets.delete(peerId);
    }

    /** @returns {number} Total rejected requests */
    get totalRejected() { return this.#totalRejected; }

    /** @private */
    #getBucket(peerId, category) {
        if (!this.#buckets.has(peerId)) {
            this.#buckets.set(peerId, new Map());
        }
        const peerBuckets = this.#buckets.get(peerId);
        if (!peerBuckets.has(category)) {
            const config = this.#configs[category];
            peerBuckets.set(category, { tokens: config.maxTokens, lastRefill: Date.now() });
        }
        return peerBuckets.get(category);
    }

    /** @private */
    #refill(bucket, config) {
        const now = Date.now();
        const elapsed = (now - bucket.lastRefill) / 1000;
        bucket.tokens = Math.min(config.maxTokens, bucket.tokens + elapsed * config.refillRate);
        bucket.lastRefill = now;
    }
}
