/**
 * OrbitDbStore — adapts OrbitDB KeyValue database to the LedgerStore interface.
 *
 * This bridges all in-memory stores (TokenLedger, ModelRegistry, etc.)
 * to persistent OrbitDB storage. Same interface, durable on disk via IPFS.
 */

import type { OrbitDbManager } from '../core/OrbitDbManager';

export interface PersistentStore {
    put(entry: any): Promise<void>;
    get(id: string): Promise<any>;
    del(id: string): Promise<void>;
    all(): Promise<Array<{ key: string; value: any }>>;
}

/**
 * Creates an OrbitDB-backed persistent store.
 * Compatible with LedgerStore, ModelRegistry store interface, etc.
 */
export class OrbitDbStore implements PersistentStore {
    private constructor(private readonly db: any) { }

    static async create(manager: OrbitDbManager, name: string): Promise<OrbitDbStore> {
        const db = await manager.openKeyValueDb(name);
        return new OrbitDbStore(db);
    }

    async put(entry: any): Promise<void> {
        const id = entry._id ?? entry.id;
        if (!id) throw new Error('Entry must have _id or id field');
        await this.db.put(id, entry);
    }

    async get(id: string): Promise<any> {
        const value = await this.db.get(id);
        return value ?? null;
    }

    async del(id: string): Promise<void> {
        await this.db.del(id);
    }

    async all(): Promise<Array<{ key: string; value: any }>> {
        const entries: Array<{ key: string; value: any }> = [];
        // OrbitDB KeyValue iterator
        for await (const record of this.db.iterator()) {
            entries.push({ key: record.key, value: record.value });
        }
        return entries;
    }
}

/**
 * In-memory store — for testing and lightweight usage.
 * Same interface as OrbitDbStore.
 */
export class InMemoryStore implements PersistentStore {
    private readonly data = new Map<string, any>();

    async put(entry: any): Promise<void> {
        const id = entry._id ?? entry.id;
        if (!id) throw new Error('Entry must have _id or id field');
        this.data.set(id, entry);
    }

    async get(id: string): Promise<any> {
        return this.data.get(id) ?? null;
    }

    async del(id: string): Promise<void> {
        this.data.delete(id);
    }

    async all(): Promise<Array<{ key: string; value: any }>> {
        return [...this.data.entries()].map(([key, value]) => ({ key, value }));
    }
}
