/**
 * HFModelSeeder — Download GGUF model files from HuggingFace and seed to IPFS.
 *
 * Flow:
 *   1. Check if model already on CDI network (ShardRegistry)
 *   2. If not: authenticate with HF token → list GGUF files → download each → store in IPFS
 *   3. Register shards in ShardRegistry with CIDs
 *
 * Genesis: Only genesis miner seeds initial models.
 * Post-genesis: Any node can seed new models (permissionless).
 *
 * @module browser/llm/HFModelSeeder
 */

const HF_API_BASE = 'https://huggingface.co/api/models';
const HF_RESOLVE_BASE = 'https://huggingface.co';

interface HFSibling {
    rfilename: string;
    size: number;
}

interface ShardSpec {
    shardId: string;
    modelId: string;
    layerRange: number[];
    cid: string;
    sizeBytes: number;
}

interface ProgressEvent {
    type: 'download' | 'upload';
    fileIndex: number;
    totalFiles: number;
    fileName: string;
    bytes?: number;
    cid?: string;
}

export interface HFModelSeederOpts {
    hfToken: string;
    fetchFn?: (url: string, opts?: any) => Promise<any>;
    helia: any;
    registry: any;
    onProgress?: (evt: ProgressEvent) => void;
}

interface SeedResult {
    modelId: string;
    shards: ShardSpec[];
    totalBytes: number;
}

export class HFModelSeeder {
    private hfToken: string;
    private fetchFn: (url: string, opts?: any) => Promise<any>;
    private helia: any;
    private registry: any;
    private onProgressCb: (evt: ProgressEvent) => void;

    constructor(opts: HFModelSeederOpts) {
        if (!opts?.hfToken) throw new Error('hfToken is required');
        this.hfToken = opts.hfToken;
        this.fetchFn = opts.fetchFn || globalThis.fetch?.bind(globalThis);
        this.helia = opts.helia;
        this.registry = opts.registry;
        this.onProgressCb = opts.onProgress || (() => { });
    }

    async listGGUFFiles(repoId: string, revision = 'main'): Promise<HFSibling[]> {
        const url = `${HF_API_BASE}/${repoId}`;
        const res = await this.fetchFn(url, {
            headers: { Authorization: `Bearer ${this.hfToken}` },
        });

        if (!res.ok) {
            throw new Error(`HF API error: ${res.status} ${res.statusText}`);
        }

        const data = await res.json();
        const siblings: HFSibling[] = data.siblings || [];
        return siblings.filter((f: HFSibling) => f.rfilename.endsWith('.gguf'));
    }

    async downloadAndSeed(repoId: string, revision = 'main'): Promise<SeedResult> {
        const ggufFiles = await this.listGGUFFiles(repoId, revision);

        if (ggufFiles.length === 0) {
            throw new Error(`No GGUF files found in ${repoId}`);
        }

        const shards: ShardSpec[] = [];
        let totalBytes = 0;

        for (let i = 0; i < ggufFiles.length; i++) {
            const file = ggufFiles[i];
            const fileName = file.rfilename;

            const downloadUrl = `${HF_RESOLVE_BASE}/${repoId}/resolve/${revision}/${fileName}`;
            const res = await this.fetchFn(downloadUrl, {
                headers: { Authorization: `Bearer ${this.hfToken}` },
            });

            if (!res.ok) {
                throw new Error(`Failed to download ${fileName}: ${res.status}`);
            }

            const arrayBuffer = await res.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);

            this.onProgressCb({
                type: 'download',
                fileIndex: i,
                totalFiles: ggufFiles.length,
                fileName,
                bytes: data.byteLength,
            });

            const cid = await this.helia.addShard(data);

            this.onProgressCb({
                type: 'upload',
                fileIndex: i,
                totalFiles: ggufFiles.length,
                fileName,
                cid,
            });

            const shardSpec: ShardSpec = {
                shardId: `${repoId}-shard-${i}`,
                modelId: repoId,
                layerRange: [i, i],
                cid,
                sizeBytes: data.byteLength,
            };
            this.registry.registerManifest(shardSpec);
            shards.push(shardSpec);
            totalBytes += data.byteLength;
        }

        return { modelId: repoId, shards, totalBytes };
    }

    isModelOnNetwork(modelId: string): boolean {
        const shards = this.registry.getModelShards(modelId);
        return shards.length > 0;
    }
}
