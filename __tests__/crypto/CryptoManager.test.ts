import { CryptoManager } from '../../src/crypto/CryptoManager.js';

describe('CryptoManager', () => {
    let crypto: CryptoManager;

    beforeEach(() => {
        crypto = new CryptoManager();
    });

    // ── Key Generation ──────────────────────────────────────
    test('should generate a valid key pair', async () => {
        const keyPair = await crypto.generateKeyPair();

        expect(keyPair.publicKey).toBeDefined();
        expect(keyPair.privateKey).toBeDefined();

        // Base64 encoded strings
        expect(typeof keyPair.publicKey).toBe('string');
        expect(typeof keyPair.privateKey).toBe('string');

        // Should decode from base64 without error
        expect(() => Buffer.from(keyPair.publicKey, 'base64')).not.toThrow();
        expect(() => Buffer.from(keyPair.privateKey, 'base64')).not.toThrow();

        // Keys should have reasonable length (X25519 keys)
        expect(Buffer.from(keyPair.publicKey, 'base64').length).toBeGreaterThan(0);
        expect(Buffer.from(keyPair.privateKey, 'base64').length).toBeGreaterThan(0);
    });

    // ── Encrypt / Decrypt ───────────────────────────────────
    test('should encrypt and decrypt a string', async () => {
        const keyPair = await crypto.generateKeyPair();
        const plaintext = 'Hello, decentralized world!';

        const ciphertext = await crypto.encrypt(plaintext, keyPair.publicKey);
        expect(ciphertext).not.toBe(plaintext);

        const decrypted = await crypto.decrypt(ciphertext, keyPair.privateKey);
        expect(decrypted).toBe(plaintext);
    });

    test('should fail decryption with wrong key', async () => {
        const keyPair1 = await crypto.generateKeyPair();
        const keyPair2 = await crypto.generateKeyPair();

        const ciphertext = await crypto.encrypt('secret', keyPair1.publicKey);

        await expect(
            crypto.decrypt(ciphertext, keyPair2.privateKey)
        ).rejects.toThrow();
    });

    test('should produce different ciphertext for same plaintext', async () => {
        const keyPair = await crypto.generateKeyPair();
        const plaintext = 'same input';

        const ct1 = await crypto.encrypt(plaintext, keyPair.publicKey);
        const ct2 = await crypto.encrypt(plaintext, keyPair.publicKey);

        // Different due to random IV
        expect(ct1).not.toBe(ct2);
    });

    // ── Sign / Verify ───────────────────────────────────────
    test('should sign and verify data', async () => {
        const keyPair = await crypto.generateKeyPair();
        const data = 'important message';

        const signature = await crypto.sign(data, keyPair.privateKey);
        expect(typeof signature).toBe('string');

        const isValid = await crypto.verify(data, signature, keyPair.publicKey);
        expect(isValid).toBe(true);
    });

    test('should reject invalid signature', async () => {
        const keyPair = await crypto.generateKeyPair();
        const data = 'important message';

        const signature = await crypto.sign(data, keyPair.privateKey);

        // Tamper with data
        const isValid = await crypto.verify('tampered message', signature, keyPair.publicKey);
        expect(isValid).toBe(false);
    });

    test('should reject signature from different key', async () => {
        const keyPair1 = await crypto.generateKeyPair();
        const keyPair2 = await crypto.generateKeyPair();
        const data = 'message';

        const signature = await crypto.sign(data, keyPair1.privateKey);

        const isValid = await crypto.verify(data, signature, keyPair2.publicKey);
        expect(isValid).toBe(false);
    });

    // ── EncryptionModule ────────────────────────────────────
    test('should produce OrbitDB-compatible EncryptionModule', async () => {
        const keyPair = await crypto.generateKeyPair();
        const encModule = crypto.createEncryptionModule(keyPair);

        expect(encModule.replication).toBeDefined();
        expect(encModule.data).toBeDefined();

        // Test roundtrip with Uint8Array (as OrbitDB would use)
        const original = new TextEncoder().encode('Hello OrbitDB');

        const encryptedData = await encModule.data.encrypt(original);
        const decryptedData = await encModule.data.decrypt(encryptedData);
        expect(new TextDecoder().decode(decryptedData)).toBe('Hello OrbitDB');

        const encryptedRepl = await encModule.replication.encrypt(original);
        const decryptedRepl = await encModule.replication.decrypt(encryptedRepl);
        expect(new TextDecoder().decode(decryptedRepl)).toBe('Hello OrbitDB');
    });
});
