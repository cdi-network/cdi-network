/**
 * TokenLedger — decentralized balance sheet stored on OrbitDB.
 *
 * Tracks token balances and transaction history for each node.
 * Supports credit (mining, payments received) and debit (payments, fees).
 */

export type TransactionType = 'mine' | 'pay' | 'fee' | 'refund';

export interface Transaction {
    txId: string;
    nodeId: string;
    amount: number;
    type: TransactionType;
    direction: 'credit' | 'debit';
    timestamp: number;
    metadata: Record<string, unknown>;
}

interface LedgerEntry {
    _id: string;
    balance: number;
    transactions: Transaction[];
}

interface LedgerStore {
    put(entry: any): Promise<void>;
    get(id: string): Promise<any>;
    del(id: string): Promise<void>;
    all(): Promise<Array<{ key: string; value: any }>>;
}

export class TokenLedger {
    constructor(private readonly store: LedgerStore) { }

    /**
     * Credit tokens to a node's balance.
     */
    async credit(
        nodeId: string,
        amount: number,
        type: TransactionType,
        metadata: Record<string, unknown>,
    ): Promise<Transaction> {
        const entry = await this.getOrCreateEntry(nodeId);
        const tx: Transaction = {
            txId: `tx-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            nodeId,
            amount,
            type,
            direction: 'credit',
            timestamp: Date.now(),
            metadata,
        };
        entry.balance += amount;
        entry.transactions.push(tx);
        await this.store.put(entry);
        return tx;
    }

    /**
     * Debit tokens from a node's balance. Throws if insufficient funds.
     */
    async debit(
        nodeId: string,
        amount: number,
        type: TransactionType,
        metadata: Record<string, unknown>,
    ): Promise<Transaction> {
        const entry = await this.getOrCreateEntry(nodeId);
        if (entry.balance < amount) {
            throw new Error(
                `Insufficient balance for ${nodeId}: has ${entry.balance}, needs ${amount}`
            );
        }
        const tx: Transaction = {
            txId: `tx-${nodeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            nodeId,
            amount,
            type,
            direction: 'debit',
            timestamp: Date.now(),
            metadata,
        };
        entry.balance -= amount;
        entry.transactions.push(tx);
        await this.store.put(entry);
        return tx;
    }

    /**
     * Get current balance for a node.
     */
    async getBalance(nodeId: string): Promise<number> {
        const entry = await this.store.get(nodeId);
        return entry ? (entry as LedgerEntry).balance : 0;
    }

    /**
     * Get transaction history for a node.
     */
    async getTransactionHistory(nodeId: string): Promise<Transaction[]> {
        const entry = await this.store.get(nodeId);
        return entry ? (entry as LedgerEntry).transactions : [];
    }

    private async getOrCreateEntry(nodeId: string): Promise<LedgerEntry> {
        const existing = await this.store.get(nodeId);
        if (existing) return existing as LedgerEntry;
        return { _id: nodeId, balance: 0, transactions: [] };
    }
}
