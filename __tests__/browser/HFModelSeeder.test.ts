/**
 * HFModelSeeder — TDD tests for HuggingFace → IPFS model seeding pipeline.
 *
 * Flow: HF Token → list GGUF files → download → store in IPFS → register CIDs
 */

// @ts-nocheck — browser module DI with mocks

// ── Mock factories ──

function createMockHelia() {
    const store = new Map();
    return {
        started: true,
        async start() { this.started = true; },
        async stop() { this.started = false; },
        async addShard(blob: Uint8Array) {
            // Content-based CID (like real Helia) — same content = same CID
            let hash = 0;
            for (let i = 0; i < blob.length; i++) hash = ((hash << 5) - hash + blob[i]) | 0;
            const cid = `bafy-${(hash >>> 0).toString(16).padStart(8, '0')}`;
            if (!store.has(cid)) {
                store.set(cid, new Uint8Array(blob));
            }
            return cid;
        },
        async getShard(cid: string) { return store.get(cid) || null; },
        has(cid: string) { return store.has(cid); },
        get count() { return store.size; },
        get isStarted() { return this.started; },
        _store: store,
    };
}

function createMockRegistry() {
    const manifests = new Map();
    return {
        registerManifest(spec) { manifests.set(spec.shardId, spec); },
        getModelShards(modelId) {
            return [...manifests.values()].filter(s => s.modelId === modelId);
        },
        _manifests: manifests,
    };
}

function createMockFetch(opts: { failAuth?: boolean; fileCount?: number; chunkSize?: number } = {}) {
    const { failAuth = false, fileCount = 2, chunkSize = 1024 } = opts;

    const siblings: Array<{ rfilename: string; size: number }> = [];
    for (let i = 1; i <= fileCount; i++) {
        siblings.push({
            rfilename: `model-${String(i).padStart(5, '0')}-of-${String(fileCount).padStart(5, '0')}.gguf`,
            size: chunkSize,
        });
    }
    siblings.push({ rfilename: 'README.md', size: 100 });
    siblings.push({ rfilename: 'config.json', size: 200 });

    return jest.fn(async (url: string, _options: any = {}) => {
        if (failAuth) {
            return { ok: false, status: 401, statusText: 'Unauthorized' };
        }

        // Model info API
        if (url.includes('/api/models/')) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { modelId: 'test-org/test-model-gguf', siblings };
                },
            };
        }

        // File download
        if (url.includes('/resolve/')) {
            const data = new Uint8Array(chunkSize);
            const fileIdx = parseInt(url.match(/model-(\d+)/)?.[1] || '0');
            data.fill(fileIdx);
            return {
                ok: true,
                status: 200,
                headers: new Map([['content-length', String(chunkSize)]]),
                async arrayBuffer() { return data.buffer; },
            };
        }

        return { ok: false, status: 404, statusText: 'Not Found' };
    });
}


describe('HFModelSeeder', () => {
    let HFModelSeeder: any;

    beforeEach(async () => {
        const mod = await import('../../browser/llm/HFModelSeeder');
        HFModelSeeder = mod.HFModelSeeder;
    });

    describe('constructor', () => {
        it('requires hfToken', () => {
            expect(() => new HFModelSeeder({})).toThrow('hfToken');
        });

        it('accepts DI for fetch, helia, registry', () => {
            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch(),
                helia: createMockHelia(),
                registry: createMockRegistry(),
            });
            expect(seeder).toBeDefined();
        });
    });

    describe('listGGUFFiles', () => {
        it('lists only .gguf files from HF repo', async () => {
            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch({ fileCount: 3 }),
                helia: createMockHelia(),
                registry: createMockRegistry(),
            });

            const files = await seeder.listGGUFFiles('test-org/test-model-gguf');
            expect(files).toHaveLength(3);
            expect(files[0].rfilename).toMatch(/\.gguf$/);
            expect(files.every((f: any) => f.rfilename.endsWith('.gguf'))).toBe(true);
        });

        it('rejects on auth failure', async () => {
            const seeder = new HFModelSeeder({
                hfToken: 'bad_token',
                fetchFn: createMockFetch({ failAuth: true }),
                helia: createMockHelia(),
                registry: createMockRegistry(),
            });

            await expect(seeder.listGGUFFiles('test-org/test-model')).rejects.toThrow('401');
        });
    });

    describe('downloadAndSeed', () => {
        it('downloads GGUF files and stores each as a shard in IPFS', async () => {
            const helia = createMockHelia();
            const registry = createMockRegistry();

            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch({ fileCount: 2, chunkSize: 512 }),
                helia,
                registry,
            });

            const result = await seeder.downloadAndSeed('test-org/test-model-gguf');

            expect(helia.count).toBe(2);

            const shards = registry.getModelShards('test-org/test-model-gguf');
            expect(shards).toHaveLength(2);
            expect(shards.every((s: any) => s.cid?.startsWith('bafy'))).toBe(true);

            expect(result.modelId).toBe('test-org/test-model-gguf');
            expect(result.shards).toHaveLength(2);
            expect(result.totalBytes).toBe(1024);
        });

        it('emits progress callbacks during download', async () => {
            const progressEvents: any[] = [];
            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch({ fileCount: 3, chunkSize: 256 }),
                helia: createMockHelia(),
                registry: createMockRegistry(),
                onProgress: (evt: any) => progressEvents.push(evt),
            });

            await seeder.downloadAndSeed('test-org/test-model-gguf');

            expect(progressEvents.length).toBeGreaterThan(0);
            const fileDownloads = progressEvents.filter(e => e.type === 'download');
            expect(fileDownloads).toHaveLength(3);
            const uploads = progressEvents.filter(e => e.type === 'upload');
            expect(uploads).toHaveLength(3);
        });

        it('skips re-download when model already on network', async () => {
            const helia = createMockHelia();
            const registry = createMockRegistry();
            const mockFetch = createMockFetch({ fileCount: 2 });

            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: mockFetch,
                helia,
                registry,
            });

            // First seed
            await seeder.downloadAndSeed('test-org/test-model-gguf');
            expect(helia.count).toBe(2);

            // Second seed — dedup via CID in HeliaManager
            await seeder.downloadAndSeed('test-org/test-model-gguf');
            // HeliaManager deduplicates internally, count stays same
            expect(helia.count).toBe(2);
        });
    });

    describe('isModelOnNetwork', () => {
        it('returns true when shards are registered', async () => {
            const helia = createMockHelia();
            const registry = createMockRegistry();

            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch({ fileCount: 2 }),
                helia,
                registry,
            });

            await seeder.downloadAndSeed('test-org/test-model-gguf');
            expect(seeder.isModelOnNetwork('test-org/test-model-gguf')).toBe(true);
        });

        it('returns false when model not seeded', () => {
            const seeder = new HFModelSeeder({
                hfToken: 'hf_test123',
                fetchFn: createMockFetch(),
                helia: createMockHelia(),
                registry: createMockRegistry(),
            });

            expect(seeder.isModelOnNetwork('nonexistent/model')).toBe(false);
        });
    });
});
