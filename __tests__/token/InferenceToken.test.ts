/**
 * WS-P5a: InferenceToken TDD Tests
 *
 * 1. Correct block reward per epoch (halving every 210,000 blocks)
 * 2. Never exceed max supply (21M)
 * 3. Mint only with valid ZKP proof
 * 4. Track cumulative supply correctly
 */
import { InferenceToken } from '../../src/token/InferenceToken.js';

describe('WS-P5a: InferenceToken', () => {

    test('should calculate correct block reward per epoch', () => {
        const token = new InferenceToken();

        expect(token.getBlockReward(0)).toBe(50);
        expect(token.getBlockReward(1)).toBe(50);
        expect(token.getBlockReward(209_999)).toBe(50);
        // First halving
        expect(token.getBlockReward(210_000)).toBe(25);
        expect(token.getBlockReward(419_999)).toBe(25);
        // Second halving
        expect(token.getBlockReward(420_000)).toBe(12.5);
        // Third halving
        expect(token.getBlockReward(630_000)).toBe(6.25);
        // Fourth halving
        expect(token.getBlockReward(840_000)).toBe(3.125);
    });

    test('should never exceed max supply (21M)', () => {
        const token = new InferenceToken();

        // Simulate many mints — reward should eventually reach 0
        // After enough halvings, reward rounds below minimum threshold
        let lastReward = 50;
        for (let epoch = 0; epoch < 64; epoch++) {
            const height = epoch * 210_000;
            const reward = token.getBlockReward(height);
            expect(reward).toBeLessThanOrEqual(lastReward);
            lastReward = reward;
        }

        // At very high epoch, reward should be effectively 0
        expect(token.getBlockReward(64 * 210_000)).toBeLessThan(0.00000001);
    });

    test('should mint only with valid ZKP proof', async () => {
        const token = new InferenceToken();

        // Valid proof → successful mint
        const validProof = { valid: true, outputCommitment: 'abc', expectedOutputHash: 'abc' };
        const result = await token.mint('node-1', 0, validProof as any);
        expect(result.amount).toBe(50);
        expect(result.nodeId).toBe('node-1');

        // Invalid proof → rejected
        const invalidProof = { valid: false, outputCommitment: 'abc', expectedOutputHash: 'xyz' };
        await expect(
            token.mint('node-2', 1, invalidProof as any)
        ).rejects.toThrow(/invalid|proof|rejected/i);
    });

    test('should track cumulative supply correctly', async () => {
        const token = new InferenceToken();
        expect(token.getTotalSupply()).toBe(0);

        const proof = { valid: true, outputCommitment: 'x', expectedOutputHash: 'x' };

        await token.mint('n1', 0, proof as any); // +50
        expect(token.getTotalSupply()).toBe(50);

        await token.mint('n2', 1, proof as any); // +50
        expect(token.getTotalSupply()).toBe(100);

        await token.mint('n3', 2, proof as any); // +50
        expect(token.getTotalSupply()).toBe(150);
    });
});
