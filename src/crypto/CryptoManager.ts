import {
    generateKeyPairSync,
    createCipheriv,
    createDecipheriv,
    randomBytes,
    sign as cryptoSign,
    verify as cryptoVerify,
    createPublicKey,
    createPrivateKey,
    diffieHellman,
    createHash,
} from 'crypto';
import type { EncryptionModule, KeyPair } from '../types/index.js';

/**
 * Envelope format for the KeyPair.
 * publicKey  = base64( JSON({ enc: x25519PubDerB64, sign: ed25519PubDerB64 }) )
 * privateKey = base64( JSON({ enc: x25519PrivDerB64, sign: ed25519PrivDerB64 }) )
 */
interface KeyEnvelope {
    enc: string;  // X25519 DER base64
    sign: string; // Ed25519 DER base64
}

/**
 * CryptoManager — handles key generation, encrypt/decrypt (ECDH + AES-256-GCM),
 * signing/verification (Ed25519), and OrbitDB EncryptionModule creation.
 *
 * Uses only Node.js built-in `crypto` — no external dependencies.
 */
export class CryptoManager {

    /**
     * Generates an X25519 key pair (encryption) and Ed25519 key pair (signing).
     * Both are packed into a single KeyPair for convenience.
     */
    async generateKeyPair(): Promise<KeyPair> {
        const encKp = generateKeyPairSync('x25519');
        const signKp = generateKeyPairSync('ed25519');

        const pubEnvelope: KeyEnvelope = {
            enc: encKp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
            sign: signKp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
        };

        const privEnvelope: KeyEnvelope = {
            enc: encKp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
            sign: signKp.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
        };

        return {
            publicKey: Buffer.from(JSON.stringify(pubEnvelope)).toString('base64'),
            privateKey: Buffer.from(JSON.stringify(privEnvelope)).toString('base64'),
        };
    }

    /**
     * Encrypts plaintext using ephemeral ECDH (X25519) + AES-256-GCM.
     * Output: base64( ephemeralPubDER | iv(12) | authTag(16) | ciphertext )
     */
    async encrypt(plaintext: string, publicKeyB64: string): Promise<string> {
        const pubEnvelope = this.parsePubKey(publicKeyB64);

        const recipientEncPub = createPublicKey({
            key: Buffer.from(pubEnvelope.enc, 'base64'),
            format: 'der',
            type: 'spki',
        });

        // Ephemeral X25519 key pair
        const ephemeral = generateKeyPairSync('x25519');

        // ECDH → shared secret
        const sharedSecret = diffieHellman({
            privateKey: ephemeral.privateKey,
            publicKey: recipientEncPub,
        });

        // Derive AES key
        const aesKey = createHash('sha256').update(sharedSecret).digest();

        // AES-256-GCM
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
        const authTag = cipher.getAuthTag();

        // Export ephemeral pub (X25519 SPKI DER = 44 bytes)
        const ephPubDer = ephemeral.publicKey.export({ type: 'spki', format: 'der' });

        return Buffer.concat([ephPubDer, iv, authTag, encrypted]).toString('base64');
    }

    /**
     * Decrypts ciphertext produced by `encrypt`.
     */
    async decrypt(ciphertextB64: string, privateKeyB64: string): Promise<string> {
        const privEnvelope = this.parsePrivKey(privateKeyB64);
        const data = Buffer.from(ciphertextB64, 'base64');

        // X25519 SPKI DER = 44 bytes
        const ephPubDer = data.subarray(0, 44);
        const iv = data.subarray(44, 56);
        const authTag = data.subarray(56, 72);
        const encrypted = data.subarray(72);

        const ephPubKey = createPublicKey({ key: ephPubDer, format: 'der', type: 'spki' });
        const recipientPrivKey = createPrivateKey({
            key: Buffer.from(privEnvelope.enc, 'base64'),
            format: 'der',
            type: 'pkcs8',
        });

        // ECDH → shared secret
        const sharedSecret = diffieHellman({
            privateKey: recipientPrivKey,
            publicKey: ephPubKey,
        });

        // Derive AES key
        const aesKey = createHash('sha256').update(sharedSecret).digest();

        const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

        return decrypted.toString('utf-8');
    }

    /**
     * Signs data with Ed25519.
     */
    async sign(data: string, privateKeyB64: string): Promise<string> {
        const privEnvelope = this.parsePrivKey(privateKeyB64);
        const privateKey = createPrivateKey({
            key: Buffer.from(privEnvelope.sign, 'base64'),
            format: 'der',
            type: 'pkcs8',
        });

        const signature = cryptoSign(null, Buffer.from(data, 'utf-8'), privateKey);
        return signature.toString('base64');
    }

    /**
     * Verifies an Ed25519 signature.
     */
    async verify(data: string, signatureB64: string, publicKeyB64: string): Promise<boolean> {
        const pubEnvelope = this.parsePubKey(publicKeyB64);
        const publicKey = createPublicKey({
            key: Buffer.from(pubEnvelope.sign, 'base64'),
            format: 'der',
            type: 'spki',
        });

        return cryptoVerify(null, Buffer.from(data, 'utf-8'), publicKey, Buffer.from(signatureB64, 'base64'));
    }

    /**
     * Creates an OrbitDB-compatible EncryptionModule.
     */
    createEncryptionModule(keyPair: KeyPair): EncryptionModule {
        const createChannel = () => ({
            encrypt: async (data: Uint8Array): Promise<Uint8Array> => {
                const plaintext = Buffer.from(data).toString('utf-8');
                const ciphertext = await this.encrypt(plaintext, keyPair.publicKey);
                return new TextEncoder().encode(ciphertext);
            },
            decrypt: async (data: Uint8Array): Promise<Uint8Array> => {
                const ciphertext = new TextDecoder().decode(data);
                const plaintext = await this.decrypt(ciphertext, keyPair.privateKey);
                return new TextEncoder().encode(plaintext);
            },
        });

        return {
            replication: createChannel(),
            data: createChannel(),
        };
    }

    // ── Helpers ──────────────────────────────────────────────

    private parsePubKey(b64: string): KeyEnvelope {
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as KeyEnvelope;
    }

    private parsePrivKey(b64: string): KeyEnvelope {
        return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as KeyEnvelope;
    }
}
