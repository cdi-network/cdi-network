/**
 * WS-P5d: Token Integration Tests
 *
 * End-to-end: inference pipeline → token mining + market pricing.
 * 1. Successful inference should mint tokens to pipeline nodes
 * 2. Requester should pay market price for compute
 * 3. Failed inference should refund requester
 * 4. Market price should reflect network load
 */
import { jest } from '@jest/globals';
import { InferenceToken } from '../../src/token/InferenceToken.js';
import { TokenLedger } from '../../src/token/TokenLedger.js';
import { InferenceMarket } from '../../src/token/InferenceMarket.js';
import { TokenSettlement } from '../../src/token/TokenSettlement.js';

function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: jest.fn(async (entry: any) => { data.set(entry._id, entry); }),
        get: jest.fn(async (id: string) => data.get(id) ?? null),
        del: jest.fn(async (id: string) => { data.delete(id); }),
        all: jest.fn(async () => Array.from(data.entries()).map(([key, value]) => ({ key, value }))),
    };
}

describe('WS-P5d: Token Integration', () => {

    test('successful inference should mint tokens to pipeline nodes', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);
        const token = new InferenceToken();

        const settlement = new TokenSettlement(token, ledger);

        // Simulate 3 nodes completing a pipeline inference
        const nodes = ['node-0', 'node-1', 'node-2'];
        const validProof = { outputCommitment: 'abc', expectedOutputHash: 'abc' };

        await settlement.settleInference(nodes, 0, validProof as any);

        // Each node should receive an equal share of the block reward
        // Block 0 reward = 50 → 50/3 per node ≈ 16.667
        for (const nodeId of nodes) {
            const balance = await ledger.getBalance(nodeId);
            expect(balance).toBeCloseTo(50 / 3, 2);
        }

        // Token supply should reflect the mint
        expect(token.getTotalSupply()).toBe(50);
    });

    test('requester should pay market price for compute', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);
        const market = new InferenceMarket(10_000, 1000);

        // Give requester some tokens
        await ledger.credit('requester-1', 500, 'mine', {});

        const priceBefore = market.getPrice();
        const computeUnits = 3; // 3-node pipeline
        const cost = market.buyCompute(computeUnits);

        // Debit from requester
        await ledger.debit('requester-1', cost, 'pay', { inference: 'req-1' });

        const balance = await ledger.getBalance('requester-1');
        expect(balance).toBe(500 - cost);
        expect(cost).toBeGreaterThan(0);
    });

    test('failed inference should refund requester', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);
        const token = new InferenceToken();

        const settlement = new TokenSettlement(token, ledger);

        // Give requester tokens and escrow
        await ledger.credit('req-1', 100, 'mine', {});
        await ledger.debit('req-1', 30, 'pay', { inference: 'job-1' });

        expect(await ledger.getBalance('req-1')).toBe(70);

        // Inference fails → refund
        await settlement.refund('req-1', 30, 'job-1');

        expect(await ledger.getBalance('req-1')).toBe(100);
    });

    test('market price should reflect network load', () => {
        const market = new InferenceMarket(10_000, 1000);
        const prices: number[] = [];

        // Simulate 5 sequential buys — each should increase price
        for (let i = 0; i < 5; i++) {
            prices.push(market.getPrice());
            market.buyCompute(10);
        }
        prices.push(market.getPrice());

        // Each price should be higher than the previous
        for (let i = 1; i < prices.length; i++) {
            expect(prices[i]).toBeGreaterThan(prices[i - 1]);
        }
    });
});
