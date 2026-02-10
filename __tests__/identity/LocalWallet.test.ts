/**
 * LocalWallet — TDD tests
 *
 * Tests blockchain-style local identity:
 * keypair generation, deterministic from seed, signing, verification, peerId.
 */
import { LocalWallet } from '../../src/identity/LocalWallet';

describe('LocalWallet', () => {

    // ── Generation ──────────────────────────────────────

    test('generate creates a unique wallet with peerId', () => {
        const wallet = LocalWallet.generate();

        expect(wallet.peerId).toBeDefined();
        expect(wallet.peerId.length).toBeGreaterThan(0);
        expect(wallet.publicKey).toBeInstanceOf(Uint8Array);
        expect(wallet.publicKey.length).toBe(32); // Ed25519 pubkey = 32 bytes
    });

    test('two generated wallets have different peerIds', () => {
        const w1 = LocalWallet.generate();
        const w2 = LocalWallet.generate();

        expect(w1.peerId).not.toBe(w2.peerId);
    });

    // ── Deterministic from Seed ─────────────────────────

    test('fromSeed produces identical wallet from same seed', () => {
        const seed = new Uint8Array(32);
        seed[0] = 42;
        seed[1] = 7;

        const w1 = LocalWallet.fromSeed(seed);
        const w2 = LocalWallet.fromSeed(seed);

        expect(w1.peerId).toBe(w2.peerId);
        expect(Buffer.from(w1.publicKey)).toEqual(Buffer.from(w2.publicKey));
    });

    test('different seeds produce different wallets', () => {
        const seed1 = new Uint8Array(32);
        seed1[0] = 1;
        const seed2 = new Uint8Array(32);
        seed2[0] = 2;

        const w1 = LocalWallet.fromSeed(seed1);
        const w2 = LocalWallet.fromSeed(seed2);

        expect(w1.peerId).not.toBe(w2.peerId);
    });

    // ── Signing ─────────────────────────────────────────

    test('sign produces a valid signature', () => {
        const wallet = LocalWallet.generate();
        const data = new TextEncoder().encode('hello world');

        const signature = wallet.sign(data);

        expect(signature).toBeInstanceOf(Uint8Array);
        expect(signature.length).toBe(64); // Ed25519 signature = 64 bytes
    });

    test('verify returns true for valid signature', () => {
        const wallet = LocalWallet.generate();
        const data = new TextEncoder().encode('test message');

        const signature = wallet.sign(data);
        const valid = LocalWallet.verify(wallet.publicKey, data, signature);

        expect(valid).toBe(true);
    });

    test('verify returns false for tampered data', () => {
        const wallet = LocalWallet.generate();
        const data = new TextEncoder().encode('original');
        const tampered = new TextEncoder().encode('tampered');

        const signature = wallet.sign(data);
        const valid = LocalWallet.verify(wallet.publicKey, tampered, signature);

        expect(valid).toBe(false);
    });

    test('verify returns false for wrong public key', () => {
        const wallet1 = LocalWallet.generate();
        const wallet2 = LocalWallet.generate();
        const data = new TextEncoder().encode('test');

        const signature = wallet1.sign(data);
        const valid = LocalWallet.verify(wallet2.publicKey, data, signature);

        expect(valid).toBe(false);
    });

    // ── PeerId Format ───────────────────────────────────

    test('peerId is a hex string of sha-256 hash', () => {
        const wallet = LocalWallet.generate();

        // SHA-256 hex = 64 characters
        expect(wallet.peerId).toMatch(/^[0-9a-f]{64}$/);
    });

    // ── Serialization ───────────────────────────────────

    test('export and import wallet', () => {
        const wallet = LocalWallet.generate();
        const exported = wallet.export();
        const restored = LocalWallet.import(exported);

        expect(restored.peerId).toBe(wallet.peerId);

        // Verify signing works with restored wallet
        const data = new TextEncoder().encode('round-trip');
        const sig = restored.sign(data);
        expect(LocalWallet.verify(restored.publicKey, data, sig)).toBe(true);
    });

    // ── File Persistence ────────────────────────────────

    test('save and load wallet from disk', () => {
        const tmpDir = `/tmp/cdi-test-${Date.now()}`;
        const wallet = LocalWallet.generate();

        wallet.save(tmpDir);

        const loaded = LocalWallet.load(tmpDir);
        expect(loaded).not.toBeNull();
        expect(loaded!.peerId).toBe(wallet.peerId);

        // Signing still works
        const data = new TextEncoder().encode('persistence test');
        const sig = loaded!.sign(data);
        expect(LocalWallet.verify(loaded!.publicKey, data, sig)).toBe(true);
    });

    test('loadOrGenerate creates new wallet if none exists', () => {
        const tmpDir = `/tmp/cdi-test-new-${Date.now()}`;
        const wallet = LocalWallet.loadOrGenerate(tmpDir);

        expect(wallet.peerId).toBeDefined();

        // Second call returns same wallet
        const same = LocalWallet.loadOrGenerate(tmpDir);
        expect(same.peerId).toBe(wallet.peerId);
    });

    test('load returns null when no wallet file', () => {
        const result = LocalWallet.load(`/tmp/cdi-nonexistent-${Date.now()}`);
        expect(result).toBeNull();
    });
});
