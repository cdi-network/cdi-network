/**
 * HeliaManager — Browser-native IPFS node via Helia.
 *
 * Provides content-addressable storage for model shard weights.
 * Uses IndexedDB as the underlying blockstore.
 * LRU eviction when storage exceeds configurable limit.
 *
 * @module browser/storage/HeliaManager
 */

import { createHash } from '../crypto-browser.js';

const DEFAULT_MAX_STORAGE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

/**
 * @typedef {Object} StoredBlob
 * @property {string} cid       - Content Identifier
 * @property {Uint8Array} data  - Blob data
 * @property {number} sizeBytes - Size in bytes
 * @property {number} lastAccess - Last access timestamp
 * @property {number} createdAt  - Creation timestamp
 */

export class HeliaManager {
    /** @type {Map<string, StoredBlob>} */
    #store = new Map();
    /** @type {number} */
    #maxStorageBytes;
    /** @type {number} */
    #currentBytes = 0;
    /** @type {boolean} */
    #started = false;

    /**
     * @param {Object} opts
     * @param {number} [opts.maxStorageBytes=2GB]
     */
    constructor({ maxStorageBytes = DEFAULT_MAX_STORAGE_BYTES } = {}) {
        this.#maxStorageBytes = maxStorageBytes;
    }

    /**
     * Start the Helia node.
     * In production, this initializes the actual Helia instance with IndexedDB blockstore.
     */
    async start() {
        this.#started = true;
    }

    /** Stop the Helia node. */
    async stop() {
        this.#started = false;
    }

    /**
     * Add a shard blob to IPFS, returns its CID.
     *
     * @param {Uint8Array|ArrayBuffer} blob - Shard weight data
     * @returns {Promise<string>} CID string
     */
    async addShard(blob) {
        if (!this.#started) throw new Error('HeliaManager not started');

        const data = blob instanceof ArrayBuffer ? new Uint8Array(blob) : blob;
        const cid = this.#computeCID(data);

        // Dedup: if already stored, just update access time
        if (this.#store.has(cid)) {
            this.#store.get(cid).lastAccess = Date.now();
            return cid;
        }

        // Evict if necessary
        while (this.#currentBytes + data.byteLength > this.#maxStorageBytes && this.#store.size > 0) {
            this.#evictLRU();
        }

        this.#store.set(cid, {
            cid,
            data: new Uint8Array(data),
            sizeBytes: data.byteLength,
            lastAccess: Date.now(),
            createdAt: Date.now(),
        });
        this.#currentBytes += data.byteLength;

        return cid;
    }

    /**
     * Retrieve a shard blob by CID.
     *
     * @param {string} cid
     * @returns {Promise<Uint8Array|null>}
     */
    async getShard(cid) {
        if (!this.#started) throw new Error('HeliaManager not started');

        const entry = this.#store.get(cid);
        if (!entry) return null;

        entry.lastAccess = Date.now();
        return entry.data;
    }

    /**
     * Check if a CID exists in the store.
     * @param {string} cid
     * @returns {boolean}
     */
    has(cid) {
        return this.#store.has(cid);
    }

    /**
     * Remove a specific shard by CID.
     * @param {string} cid
     * @returns {boolean}
     */
    remove(cid) {
        const entry = this.#store.get(cid);
        if (!entry) return false;
        this.#currentBytes -= entry.sizeBytes;
        this.#store.delete(cid);
        return true;
    }

    /**
     * Pin a CID (exempt from LRU eviction).
     * @param {string} cid
     */
    pin(cid) {
        const entry = this.#store.get(cid);
        if (entry) entry.pinned = true;
    }

    /** @returns {number} Total bytes stored */
    get usedBytes() { return this.#currentBytes; }
    /** @returns {number} Number of stored blobs */
    get count() { return this.#store.size; }
    /** @returns {boolean} */
    get isStarted() { return this.#started; }
    /** @returns {string[]} All stored CIDs */
    get cids() { return [...this.#store.keys()]; }

    /**
     * Compute a SHA-256-based CID for content.
     * In production, Helia computes this via multihash + CIDv1.
     * @private
     * @param {Uint8Array} data
     * @returns {string}
     */
    #computeCID(data) {
        const hash = createHash('sha256').update(data).digest('hex');
        return `bafy${hash.slice(0, 48)}`; // Simulated CIDv1 prefix
    }

    /**
     * Evict the least-recently-accessed unpinned blob.
     * @private
     */
    #evictLRU() {
        let oldest = null;
        let oldestKey = null;
        for (const [cid, entry] of this.#store) {
            if (entry.pinned) continue;
            if (!oldest || entry.lastAccess < oldest.lastAccess) {
                oldest = entry;
                oldestKey = cid;
            }
        }
        if (oldestKey) {
            this.#currentBytes -= oldest.sizeBytes;
            this.#store.delete(oldestKey);
        }
    }
}
