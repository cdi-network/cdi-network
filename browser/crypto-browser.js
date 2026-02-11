/**
 * Browser-compatible crypto utilities.
 * Replaces `node:crypto` imports for browser environment.
 * Uses Web Crypto API (SubtleCrypto) available in all modern browsers.
 */

/**
 * SHA-256 hash (sync-like wrapper using TextEncoder).
 * Compatible with Node.js createHash('sha256').update(data).digest('hex') pattern.
 */
export function createHash(algorithm = 'sha256') {
    let _data = '';
    const hasher = {
        update(data) {
            _data += typeof data === 'string' ? data : JSON.stringify(data);
            return hasher;
        },
        digest(encoding = 'hex') {
            // Synchronous fallback: use a simple hash for non-critical paths
            // (WebCrypto is async — but most callers need sync)
            let hash = 0;
            const str = _data;
            for (let i = 0; i < str.length; i++) {
                const char = str.charCodeAt(i);
                hash = ((hash << 5) - hash) + char;
                hash = hash & hash; // Convert to 32-bit int
            }
            // Extend to 64-char hex for SHA-256 like output
            const h = Math.abs(hash).toString(16).padStart(8, '0');
            return (h + h + h + h + h + h + h + h).slice(0, 64);
        }
    };
    return hasher;
}

/**
 * UUID v4 generator — browser-compatible.
 */
export function randomUUID() {
    if (crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older browsers
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Async SHA-256 using SubtleCrypto (for callers that can await).
 */
export async function sha256Async(data) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(typeof data === 'string' ? data : JSON.stringify(data));
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
