/**
 * E2ECrypto — End-to-End Encryption for CDI TabMesh
 *
 * Uses Web Crypto API (native, zero dependencies):
 *   ECDH P-256 for key exchange + AES-256-GCM for payload encryption.
 *
 * Flow:
 *   1. Each node generates an ECDH keypair at start
 *   2. Public keys are exchanged via BroadcastChannel announce
 *   3. Shared secret derived per-peer via ECDH
 *   4. Inference prompts/responses encrypted with AES-256-GCM
 *   5. Only sender + executor can decrypt — eavesdroppers see ciphertext
 */

const ALGO_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ALGO_AES = { name: 'AES-GCM', length: 256 };
const IV_BYTES = 12; // 96-bit IV for AES-GCM

// ── Key Generation ───────────────────────────────────────────────────

/**
 * Generate an ECDH P-256 keypair for this node.
 * @returns {Promise<CryptoKeyPair>} { publicKey, privateKey }
 */
export async function generateECDHKeyPair() {
    return crypto.subtle.generateKey(
        ALGO_ECDH,
        true,  // extractable (needed for export)
        ['deriveKey', 'deriveBits']
    );
}

// ── Key Export / Import ──────────────────────────────────────────────

/**
 * Export an ECDH public key to base64 string (for BroadcastChannel).
 * @param {CryptoKey} publicKey
 * @returns {Promise<string>} base64-encoded raw public key
 */
export async function exportPublicKey(publicKey) {
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    return arrayBufferToBase64(raw);
}

/**
 * Import an ECDH public key from base64 string.
 * @param {string} base64 — base64-encoded raw public key
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(base64) {
    const raw = base64ToArrayBuffer(base64);
    return crypto.subtle.importKey(
        'raw', raw,
        ALGO_ECDH,
        true,
        [] // public keys don't derive directly — used in deriveKey
    );
}

// ── Key Derivation ───────────────────────────────────────────────────

/**
 * Derive a shared AES-256-GCM key from our private key + their public key.
 * @param {CryptoKey} myPrivateKey — our ECDH private key
 * @param {CryptoKey} theirPublicKey — peer's ECDH public key
 * @returns {Promise<CryptoKey>} AES-256-GCM symmetric key
 */
export async function deriveSharedKey(myPrivateKey, theirPublicKey) {
    return crypto.subtle.deriveKey(
        { name: 'ECDH', public: theirPublicKey },
        myPrivateKey,
        ALGO_AES,
        false, // not extractable — stays in Web Crypto
        ['encrypt', 'decrypt']
    );
}

// ── Encrypt / Decrypt ────────────────────────────────────────────────

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * @param {CryptoKey} sharedKey — derived AES-256-GCM key
 * @param {string} plaintext
 * @returns {Promise<{ ciphertext: string, iv: string }>} base64-encoded
 */
export async function encrypt(sharedKey, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoded = new TextEncoder().encode(plaintext);

    const cipherbuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sharedKey,
        encoded
    );

    return {
        ciphertext: arrayBufferToBase64(cipherbuf),
        iv: arrayBufferToBase64(iv),
    };
}

/**
 * Decrypt a ciphertext with AES-256-GCM.
 * @param {CryptoKey} sharedKey — derived AES-256-GCM key
 * @param {string} ciphertextB64 — base64-encoded ciphertext
 * @param {string} ivB64 — base64-encoded IV
 * @returns {Promise<string>} decrypted plaintext
 */
export async function decrypt(sharedKey, ciphertextB64, ivB64) {
    const cipherbuf = base64ToArrayBuffer(ciphertextB64);
    const iv = base64ToArrayBuffer(ivB64);

    const plainbuf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        sharedKey,
        cipherbuf
    );

    return new TextDecoder().decode(plainbuf);
}

// ── Key Cache ────────────────────────────────────────────────────────
// Avoids re-deriving shared keys on every message.

/**
 * E2EKeyManager — manages ECDH keypair + per-peer shared key cache.
 *
 * Usage:
 *   const km = new E2EKeyManager();
 *   await km.init();                          // generates ECDH keypair
 *   const pubKeyB64 = await km.getPublicKeyBase64(); // for announce
 *   await km.addPeer('CDI-abc', peerPubKeyB64);      // store + derive
 *   const enc = await km.encryptFor('CDI-abc', 'secret prompt');
 *   const dec = await km.decryptFrom('CDI-abc', enc.ciphertext, enc.iv);
 */
export class E2EKeyManager {
    constructor() {
        /** @type {CryptoKeyPair|null} */
        this._keyPair = null;
        /** @type {string|null} base64-encoded public key */
        this._pubKeyB64 = null;
        /** @type {Map<string, CryptoKey>} peerId → derived AES key */
        this._sharedKeys = new Map();
        /** @type {Map<string, string>} peerId → base64 public key */
        this._peerPubKeys = new Map();
    }

    /** Generate ECDH keypair. Call once at node start. */
    async init() {
        this._keyPair = await generateECDHKeyPair();
        this._pubKeyB64 = await exportPublicKey(this._keyPair.publicKey);
        console.log('[E2E] ECDH P-256 keypair generated');
    }

    /** @returns {string} base64-encoded public key for BroadcastChannel announce */
    getPublicKeyBase64() {
        if (!this._pubKeyB64) throw new Error('E2EKeyManager not initialized');
        return this._pubKeyB64;
    }

    /**
     * Register a peer's public key and derive shared AES key.
     * @param {string} peerId
     * @param {string} pubKeyB64 — base64-encoded ECDH public key
     */
    async addPeer(peerId, pubKeyB64) {
        if (this._sharedKeys.has(peerId)) return; // already derived
        const theirPub = await importPublicKey(pubKeyB64);
        const shared = await deriveSharedKey(this._keyPair.privateKey, theirPub);
        this._sharedKeys.set(peerId, shared);
        this._peerPubKeys.set(peerId, pubKeyB64);
        console.log(`[E2E] Shared key derived for peer ${peerId.slice(0, 16)}…`);
    }

    /** Remove a peer's cached key (on disconnect). */
    removePeer(peerId) {
        this._sharedKeys.delete(peerId);
        this._peerPubKeys.delete(peerId);
    }

    /** Check if we have a shared key for a peer. */
    hasPeer(peerId) {
        return this._sharedKeys.has(peerId);
    }

    /**
     * Encrypt plaintext for a specific peer.
     * @param {string} peerId — target peer
     * @param {string} plaintext
     * @returns {Promise<{ ciphertext: string, iv: string }>}
     */
    async encryptFor(peerId, plaintext) {
        const key = this._sharedKeys.get(peerId);
        if (!key) throw new Error(`No shared key for peer ${peerId}`);
        return encrypt(key, plaintext);
    }

    /**
     * Decrypt ciphertext from a specific peer.
     * @param {string} peerId — sender peer
     * @param {string} ciphertext — base64
     * @param {string} iv — base64
     * @returns {Promise<string>} decrypted plaintext
     */
    async decryptFrom(peerId, ciphertext, iv) {
        const key = this._sharedKeys.get(peerId);
        if (!key) throw new Error(`No shared key for peer ${peerId}`);
        return decrypt(key, ciphertext, iv);
    }

    /** @returns {number} number of peers with derived keys */
    get peerCount() {
        return this._sharedKeys.size;
    }
}

// ── Helpers ──────────────────────────────────────────────────────────

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
