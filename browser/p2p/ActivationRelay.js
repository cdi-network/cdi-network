/**
 * ActivationRelay — Binary-efficient WebRTC data channel for streaming
 * intermediate activations between pipeline stages.
 *
 * Uses Float32Array serialization (no JSON for tensors).
 * Supports backpressure and timeout with failover.
 *
 * @module browser/p2p/ActivationRelay
 */

/**
 * @typedef {Object} ActivationMessage
 * @property {string} requestId  - Inference request ID
 * @property {string} shardId    - Source shard ID
 * @property {number} stageIndex - Pipeline stage index
 * @property {Float32Array} data - Activation tensor data
 * @property {number[]} shape    - Tensor shape [batch, hidden_dim]
 * @property {number} timestamp  - When this was produced
 */

const HEADER_SIZE = 128; // bytes reserved for metadata header
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CHUNK_SIZE = 64 * 1024; // 64KB chunks for WebRTC

export class ActivationRelay {
    /** @type {Map<string, {resolve: Function, reject: Function, timer: number}>} */
    #pendingReceives = new Map();
    /** @type {Map<string, Float32Array>} */
    #receivedBuffers = new Map();
    /** @type {number} */
    #timeoutMs;
    /** @type {Function|null} */
    #onActivationReceived = null;

    /**
     * @param {Object} opts
     * @param {number} [opts.timeoutMs=30000]
     */
    constructor({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.#timeoutMs = timeoutMs;
    }

    /**
     * Serialize an activation message into a binary buffer.
     * Format: [headerLength:4][headerJSON:N][float32Data:M]
     *
     * @param {ActivationMessage} msg
     * @returns {ArrayBuffer}
     */
    serialize(msg) {
        const header = JSON.stringify({
            requestId: msg.requestId,
            shardId: msg.shardId,
            stageIndex: msg.stageIndex,
            shape: msg.shape,
            timestamp: msg.timestamp,
            dataLength: msg.data.length,
        });
        const headerBytes = new TextEncoder().encode(header);
        const headerLen = headerBytes.byteLength;

        // Pad header to next 4-byte boundary for Float32Array alignment
        const paddedHeaderLen = Math.ceil((4 + headerLen) / 4) * 4;

        const totalSize = paddedHeaderLen + msg.data.byteLength;
        const buffer = new ArrayBuffer(totalSize);
        const view = new DataView(buffer);

        // Write header length (uint32) — actual length, not padded
        view.setUint32(0, headerLen, true); // little-endian

        // Write header bytes after the 4-byte length prefix
        new Uint8Array(buffer, 4, headerLen).set(headerBytes);

        // Write float32 data at aligned offset
        new Float32Array(buffer, paddedHeaderLen).set(msg.data);

        return buffer;
    }

    /**
     * Deserialize a binary buffer back into an ActivationMessage.
     *
     * @param {ArrayBuffer} buffer
     * @returns {ActivationMessage}
     */
    deserialize(buffer) {
        const view = new DataView(buffer);
        const headerLen = view.getUint32(0, true);

        const headerBytes = new Uint8Array(buffer, 4, headerLen);
        const header = JSON.parse(new TextDecoder().decode(headerBytes));

        // Data starts at the same padded offset used during serialization
        const paddedHeaderLen = Math.ceil((4 + headerLen) / 4) * 4;
        const data = new Float32Array(buffer, paddedHeaderLen);

        return {
            requestId: header.requestId,
            shardId: header.shardId,
            stageIndex: header.stageIndex,
            data,
            shape: header.shape,
            timestamp: header.timestamp,
        };
    }

    /**
     * Send activations to a peer via a data channel (or any send function).
     *
     * @param {Function} sendFn - (ArrayBuffer) => void — typically stream.sink or dataChannel.send
     * @param {ActivationMessage} msg
     * @returns {Promise<void>}
     */
    async send(sendFn, msg) {
        const buffer = this.serialize(msg);

        // For large tensors, chunk the data
        if (buffer.byteLength <= MAX_CHUNK_SIZE) {
            await sendFn(buffer);
        } else {
            // Send in chunks with a chunk header
            const totalChunks = Math.ceil(buffer.byteLength / MAX_CHUNK_SIZE);
            for (let i = 0; i < totalChunks; i++) {
                const start = i * MAX_CHUNK_SIZE;
                const end = Math.min(start + MAX_CHUNK_SIZE, buffer.byteLength);
                const chunk = buffer.slice(start, end);

                // Prepend chunk metadata
                const chunkMeta = new ArrayBuffer(12);
                const metaView = new DataView(chunkMeta);
                metaView.setUint32(0, i, true);          // chunkIndex
                metaView.setUint32(4, totalChunks, true); // totalChunks
                metaView.setUint32(8, end - start, true); // chunkSize

                const combined = new ArrayBuffer(12 + chunk.byteLength);
                new Uint8Array(combined).set(new Uint8Array(chunkMeta));
                new Uint8Array(combined, 12).set(new Uint8Array(chunk));

                await sendFn(combined);
            }
        }
    }

    /**
     * Register a handler for received activations.
     * @param {Function} handler - (ActivationMessage) => void
     */
    onReceive(handler) {
        this.#onActivationReceived = handler;
    }

    /**
     * Process a received buffer (call this from the data channel onmessage).
     * @param {ArrayBuffer} buffer
     * @returns {ActivationMessage|null}
     */
    handleIncoming(buffer) {
        try {
            const msg = this.deserialize(buffer);
            const key = `${msg.requestId}:${msg.stageIndex}`;

            // Resolve any pending receive promises
            const pending = this.#pendingReceives.get(key);
            if (pending) {
                clearTimeout(pending.timer);
                this.#pendingReceives.delete(key);
                pending.resolve(msg);
            }

            // Notify handler
            if (this.#onActivationReceived) {
                this.#onActivationReceived(msg);
            }

            return msg;
        } catch (err) {
            console.error('[ActivationRelay] Failed to deserialize:', err);
            return null;
        }
    }

    /**
     * Wait for an activation from a specific stage with timeout.
     *
     * @param {string} requestId
     * @param {number} stageIndex
     * @returns {Promise<ActivationMessage>}
     */
    waitForActivation(requestId, stageIndex) {
        const key = `${requestId}:${stageIndex}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pendingReceives.delete(key);
                reject(new Error(`Timeout waiting for activation: ${key}`));
            }, this.#timeoutMs);

            this.#pendingReceives.set(key, { resolve, reject, timer });
        });
    }

    /**
     * Cancel all pending receives.
     */
    cancelAll() {
        for (const [key, { reject, timer }] of this.#pendingReceives) {
            clearTimeout(timer);
            reject(new Error('Cancelled'));
        }
        this.#pendingReceives.clear();
    }

    /** @returns {number} Number of pending receives */
    get pendingCount() {
        return this.#pendingReceives.size;
    }
}
