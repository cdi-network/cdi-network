import os from 'os';
import path from 'path';
import fs from 'fs';
import { OrbitDbManagerBuilder } from '../../src/core/OrbitDbManager.js';

/**
 * Helper: creates a unique temp directory for each test's OrbitDB data.
 */
const makeTempDir = (): string => {
    const dir = path.join(os.tmpdir(), `orbitdb-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
};

describe('OrbitDbManager', () => {
    const managers: Array<{ stop: () => Promise<void> }> = [];

    afterEach(async () => {
        // Gracefully stop all managers to avoid libp2p hanging
        await Promise.all(managers.map((m) => m.stop()));
        managers.length = 0;
    }, 30_000);

    test('should create an instance with default config', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        managers.push(manager);

        expect(manager).toBeDefined();
    }, 30_000);

    test('should return a valid peerId', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        managers.push(manager);

        const peerId = manager.getPeerId();
        expect(typeof peerId).toBe('string');
        expect(peerId.length).toBeGreaterThan(0);
    }, 30_000);

    test('should open a Documents database', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        managers.push(manager);

        const db = await manager.openDocumentsDb('test-docs');
        expect(db).toBeDefined();

        const address = manager.getDbAddress(db);
        expect(typeof address).toBe('string');
        expect(address.length).toBeGreaterThan(0);
    }, 30_000);

    test('should open an Events database', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        managers.push(manager);

        const db = await manager.openEventsDb('test-events');
        expect(db).toBeDefined();
    }, 30_000);

    test('should write and read from Documents DB', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();
        managers.push(manager);

        const db = await manager.openDocumentsDb('test-crud');

        // Write a document
        await db.put({ _id: 'doc-1', name: 'test', value: 42 });

        // Read it back
        const result = await db.get('doc-1');
        expect(result).toBeDefined();
        // OrbitDB Documents returns array of matching entries
        const doc = Array.isArray(result) ? result[0] : result;
        expect(doc.value?._id || doc._id).toBe('doc-1');
    }, 30_000);

    test('should stop gracefully without hanging', async () => {
        const dir = makeTempDir();
        const manager = await new OrbitDbManagerBuilder()
            .withDirectory(dir)
            .build();

        // Open some DBs
        await manager.openDocumentsDb('stop-test-docs');
        await manager.openEventsDb('stop-test-events');

        // Should stop without timeout
        await manager.stop();
        // Not adding to managers[] since we already stopped
    }, 30_000);
});
