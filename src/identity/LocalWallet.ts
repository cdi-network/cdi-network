/**
 * LocalWallet — Blockchain-style local identity.
 *
 * Generates Ed25519 keypairs locally. No server registration needed.
 * The `peerId` (hex SHA-256 of pubkey) serves as the wallet address for CDI.
 *
 * Uses Node.js built-in `crypto` module (Ed25519 support since Node 18).
 */

import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from 'node:crypto';

export class LocalWallet {
    readonly peerId: string;
    readonly publicKey: Uint8Array;
    private readonly privateKeyDer: Buffer;

    private constructor(publicKey: Uint8Array, privateKeyDer: Buffer) {
        this.publicKey = publicKey;
        this.privateKeyDer = privateKeyDer;
        this.peerId = createHash('sha256')
            .update(publicKey)
            .digest('hex');
    }

    /**
     * Generate a new random wallet.
     */
    static generate(): LocalWallet {
        const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
            publicKeyEncoding: { type: 'spki', format: 'der' },
            privateKeyEncoding: { type: 'pkcs8', format: 'der' },
        });

        // Extract raw 32-byte pubkey from DER-encoded SPKI
        // Ed25519 SPKI DER: 12-byte header + 32-byte key
        const rawPubkey = new Uint8Array(publicKey.slice(publicKey.length - 32));

        return new LocalWallet(rawPubkey, privateKey as unknown as Buffer);
    }

    /**
     * Create wallet from a 32-byte seed (deterministic).
     */
    static fromSeed(seed: Uint8Array): LocalWallet {
        if (seed.length !== 32) {
            throw new Error('Seed must be exactly 32 bytes');
        }

        // Create Ed25519 private key from seed
        // Ed25519 PKCS8 DER structure: 16-byte header + 34-byte wrapped seed (2-byte ASN.1 + 32-byte seed)
        const pkcs8Header = Buffer.from([
            0x30, 0x2e, // SEQUENCE (46 bytes)
            0x02, 0x01, 0x00, // INTEGER 0 (version)
            0x30, 0x05, // SEQUENCE (5 bytes)
            0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
            0x04, 0x22, // OCTET STRING (34 bytes)
            0x04, 0x20, // OCTET STRING (32 bytes) — the actual seed
        ]);

        const privateKeyDer = Buffer.concat([pkcs8Header, Buffer.from(seed)]);

        const privateKeyObj = createPrivateKey({
            key: privateKeyDer,
            format: 'der',
            type: 'pkcs8',
        });

        const publicKeyObj = createPublicKey(privateKeyObj);
        const publicKeyDer = publicKeyObj.export({ type: 'spki', format: 'der' });
        const rawPubkey = new Uint8Array(publicKeyDer.slice(publicKeyDer.length - 32));

        // Re-export private key as DER for storage
        const exportedPriv = privateKeyObj.export({ type: 'pkcs8', format: 'der' });

        return new LocalWallet(rawPubkey, exportedPriv as unknown as Buffer);
    }

    /**
     * Sign data with this wallet's private key.
     * @returns 64-byte Ed25519 signature
     */
    sign(data: Uint8Array): Uint8Array {
        const privateKeyObj = createPrivateKey({
            key: Buffer.from(this.privateKeyDer),
            format: 'der',
            type: 'pkcs8',
        });

        const signature = sign(null, Buffer.from(data), privateKeyObj);
        return new Uint8Array(signature);
    }

    /**
     * Verify a signature against a public key.
     */
    static verify(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
        try {
            // Build SPKI DER from raw 32-byte pubkey
            const spkiHeader = Buffer.from([
                0x30, 0x2a, // SEQUENCE (42 bytes)
                0x30, 0x05, // SEQUENCE (5 bytes)
                0x06, 0x03, 0x2b, 0x65, 0x70, // OID 1.3.101.112 (Ed25519)
                0x03, 0x21, 0x00, // BIT STRING (33 bytes, 0 unused bits)
            ]);
            const spkiDer = Buffer.concat([spkiHeader, Buffer.from(publicKey)]);

            const publicKeyObj = createPublicKey({
                key: spkiDer,
                format: 'der',
                type: 'spki',
            });

            return verify(null, Buffer.from(data), publicKeyObj, Buffer.from(signature));
        } catch {
            return false;
        }
    }

    /**
     * Export wallet as a serializable object (for local storage).
     */
    export(): { publicKey: string; privateKey: string } {
        return {
            publicKey: Buffer.from(this.publicKey).toString('hex'),
            privateKey: Buffer.from(this.privateKeyDer).toString('hex'),
        };
    }

    /**
     * Import wallet from a previously exported object.
     */
    static import(data: { publicKey: string; privateKey: string }): LocalWallet {
        const publicKey = new Uint8Array(Buffer.from(data.publicKey, 'hex'));
        const privateKeyDer = Buffer.from(data.privateKey, 'hex');
        return new LocalWallet(publicKey, privateKeyDer);
    }
}
