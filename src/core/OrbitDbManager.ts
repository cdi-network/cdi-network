import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { identify } from '@libp2p/identify';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { createHelia } from 'helia';
import { createLogger } from '../utils/logger.js';
import type winston from 'winston';

// OrbitDB v3 — lazy load
let _createOrbitDB: any;

async function loadOrbitDB() {
    if (!_createOrbitDB) {
        const mod = await import('@orbitdb/core');
        _createOrbitDB = (mod as any).createOrbitDB;
        if (typeof _createOrbitDB !== 'function') {
            throw new Error(`Failed to resolve createOrbitDB. Got: ${typeof _createOrbitDB}`);
        }
    }
    return _createOrbitDB;
}

// ── Builder ─────────────────────────────────────────────────

export class OrbitDbManagerBuilder {
    private directory = './orbitdb';
    private listenAddresses = ['/ip4/0.0.0.0/tcp/0'];
    private bootstrapPeers: string[] = [];
    private logger?: winston.Logger;

    withDirectory(dir: string): this {
        this.directory = dir;
        return this;
    }

    withListenAddresses(addrs: string[]): this {
        this.listenAddresses = addrs;
        return this;
    }

    withBootstrapPeers(peers: string[]): this {
        this.bootstrapPeers = peers;
        return this;
    }

    withLogger(logger: winston.Logger): this {
        this.logger = logger;
        return this;
    }

    async build(): Promise<OrbitDbManager> {
        const logger = this.logger || createLogger('info', 'orbitdb');

        logger.debug('Creating libp2p node', {
            listen: this.listenAddresses,
            bootstrapPeers: this.bootstrapPeers.length,
        });

        // Build libp2p services config
        const services: Record<string, any> = {
            identify: identify(),
            pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
        };

        // Build peerDiscovery config
        const peerDiscovery: any[] = [];
        if (this.bootstrapPeers.length > 0) {
            const { bootstrap } = await import('@libp2p/bootstrap');
            peerDiscovery.push(bootstrap({ list: this.bootstrapPeers }));
        }

        const libp2p = await createLibp2p({
            addresses: { listen: this.listenAddresses },
            transports: [tcp()],
            connectionEncrypters: [noise()],
            streamMuxers: [yamux()],
            peerDiscovery,
            services,
        });

        logger.debug('libp2p node created', { peerId: libp2p.peerId.toString() });

        const ipfs = await createHelia({ libp2p });
        logger.debug('Helia node created');

        const OrbitDB = await loadOrbitDB();
        const orbitdb = await OrbitDB({ ipfs, directory: this.directory });
        logger.info('OrbitDB instance ready', { peerId: libp2p.peerId.toString() });

        return new OrbitDbManager(orbitdb, ipfs, libp2p, logger);
    }
}

// ── Manager ─────────────────────────────────────────────────

export class OrbitDbManager {
    private openDbs: any[] = [];

    constructor(
        private readonly orbitdb: any,
        private readonly ipfs: any,
        private readonly libp2p: any,
        private readonly logger: winston.Logger,
    ) { }

    /**
     * Returns PeerId of this node as a string.
     */
    getPeerId(): string {
        return this.libp2p.peerId.toString();
    }

    /**
     * Opens or creates a Documents database indexed by `_id`.
     */
    async openDocumentsDb(name: string, indexBy: string = '_id'): Promise<any> {
        this.logger.debug(`Opening Documents DB: ${name}`, { indexBy });
        const db = await this.orbitdb.open(name, {
            type: 'documents',
            sync: true,
        });
        this.openDbs.push(db);
        return db;
    }

    /**
     * Opens or creates an Events database.
     */
    async openEventsDb(name: string): Promise<any> {
        this.logger.debug(`Opening Events DB: ${name}`);
        const db = await this.orbitdb.open(name, {
            type: 'events',
            sync: true,
        });
        this.openDbs.push(db);
        return db;
    }

    /**
     * Opens or creates a KeyValue database.
     */
    async openKeyValueDb(name: string): Promise<any> {
        this.logger.debug(`Opening KeyValue DB: ${name}`);
        const db = await this.orbitdb.open(name, {
            type: 'keyvalue',
            sync: true,
        });
        this.openDbs.push(db);
        return db;
    }

    /**
     * Returns the canonical OrbitDB address for a database.
     */
    getDbAddress(db: any): string {
        return db.address?.toString() ?? '';
    }

    /**
     * Graceful shutdown: closes all open DBs, stops OrbitDB, Helia, and libp2p.
     */
    async stop(): Promise<void> {
        this.logger.debug('Stopping OrbitDbManager');

        // Close all open databases
        for (const db of this.openDbs) {
            try {
                await db.close();
            } catch (err) {
                this.logger.debug(`Error closing DB: ${err}`);
            }
        }
        this.openDbs = [];

        // Stop OrbitDB
        try {
            await this.orbitdb.stop();
        } catch (err) {
            this.logger.debug(`Error stopping OrbitDB: ${err}`);
        }

        // Stop Helia (IPFS)
        try {
            await this.ipfs.stop();
        } catch (err) {
            this.logger.debug(`Error stopping Helia: ${err}`);
        }

        this.logger.info('OrbitDbManager stopped');
    }
}
