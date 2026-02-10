/**
 * WS-P5b: TokenLedger TDD Tests
 *
 * 1. Credit and debit balances correctly
 * 2. Reject debit exceeding balance
 * 3. Record transaction history
 * 4. Handle concurrent credits from multiple nodes
 */
import { jest } from '@jest/globals';
import { TokenLedger } from '../../src/token/TokenLedger.js';

function createMockStore() {
    const data = new Map<string, any>();
    return {
        put: jest.fn(async (entry: any) => { data.set(entry._id, entry); }),
        get: jest.fn(async (id: string) => data.get(id) ?? null),
        del: jest.fn(async (id: string) => { data.delete(id); }),
        all: jest.fn(async () => Array.from(data.entries()).map(([key, value]) => ({ key, value }))),
    };
}

describe('WS-P5b: TokenLedger', () => {

    test('should credit and debit balances correctly', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);

        await ledger.credit('node-1', 100, 'mine', { block: 0 });
        expect(await ledger.getBalance('node-1')).toBe(100);

        await ledger.debit('node-1', 30, 'pay', { inferenceId: 'req-1' });
        expect(await ledger.getBalance('node-1')).toBe(70);
    });

    test('should reject debit exceeding balance', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);

        await ledger.credit('node-1', 100, 'mine', {});

        await expect(
            ledger.debit('node-1', 200, 'pay', {})
        ).rejects.toThrow(/insufficient|balance|funds/i);
    });

    test('should record transaction history', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);

        await ledger.credit('n1', 50, 'mine', { block: 0 });
        await ledger.credit('n1', 25, 'mine', { block: 1 });
        await ledger.debit('n1', 10, 'fee', { type: 'swap' });

        const history = await ledger.getTransactionHistory('n1');
        expect(history.length).toBe(3);
        expect(history[0].amount).toBe(50);
        expect(history[0].type).toBe('mine');
        expect(history[1].amount).toBe(25);
        expect(history[2].amount).toBe(10);
        expect(history[2].type).toBe('fee');
    });

    test('should handle concurrent credits from multiple nodes', async () => {
        const store = createMockStore();
        const ledger = new TokenLedger(store as any);

        // 5 nodes mine simultaneously
        await Promise.all([
            ledger.credit('n0', 50, 'mine', {}),
            ledger.credit('n1', 50, 'mine', {}),
            ledger.credit('n2', 50, 'mine', {}),
            ledger.credit('n3', 50, 'mine', {}),
            ledger.credit('n4', 50, 'mine', {}),
        ]);

        for (let i = 0; i < 5; i++) {
            expect(await ledger.getBalance(`n${i}`)).toBe(50);
        }
    });
});
