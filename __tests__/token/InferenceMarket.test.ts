/**
 * WS-P5c: InferenceMarket TDD Tests
 *
 * 1. Price compute via constant-product formula
 * 2. Price increases with demand
 * 3. Collect 0.3% swap fee
 * 4. Reject buy exceeding pool reserves
 */
import { InferenceMarket } from '../../src/token/InferenceMarket.js';

describe('WS-P5c: InferenceMarket', () => {

    test('should price compute via constant-product formula', () => {
        // Pool: 10000 tokens, 1000 compute units → price = 10 tokens/unit
        const market = new InferenceMarket(10_000, 1000);
        const state = market.getPoolState();

        expect(state.tokenReserve).toBe(10_000);
        expect(state.computeReserve).toBe(1000);
        expect(state.price).toBeCloseTo(10, 2); // 10000/1000 = 10
    });

    test('price should increase with demand', () => {
        const market = new InferenceMarket(10_000, 1000);
        const priceBefore = market.getPrice();

        // Buy 10 compute units
        market.buyCompute(10);
        const priceAfter = market.getPrice();

        expect(priceAfter).toBeGreaterThan(priceBefore);
    });

    test('should collect 0.3% swap fee', () => {
        const market = new InferenceMarket(10_000, 1000);

        // Buy 100 compute units
        const cost = market.buyCompute(100);

        // Cost should include fee
        // Without fee: dx = x * dy / (y - dy) = 10000 * 100 / 900 ≈ 1111.11
        // With 0.3% fee: actual cost should be slightly higher
        const costWithoutFee = (10_000 * 100) / (1000 - 100);
        expect(cost).toBeGreaterThan(costWithoutFee);

        // Check fee accumulation
        const state = market.getPoolState();
        expect(state.totalFees).toBeGreaterThan(0);
    });

    test('should reject buy exceeding pool reserves', () => {
        const market = new InferenceMarket(10_000, 1000);

        // Try to buy more than available
        expect(() => market.buyCompute(1000)).toThrow(/exceed|insufficient|reserve/i);
        expect(() => market.buyCompute(999)).not.toThrow(); // 999 < 1000, just barely ok
    });
});
