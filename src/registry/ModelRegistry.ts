/**
 * ModelRegistry — Central catalog of available models.
 *
 * Tracks model metadata, versions, lineage (parent→child), and
 * which nodes currently serve which models.
 *
 * Designed for persistence via OrbitDB (or any key-value store).
 */

export interface ModelEntry {
    _id: string;              // = modelId
    modelId: string;          // 'deepseek-r1:70b'
    family: string;           // 'deepseek-r1'
    variant: string;          // '70b', '7b', '1.5b'
    quantization?: string;    // 'q4_K_M', 'f16'
    capabilities: string[];   // ['chat', 'code', 'embedding']
    parameterCount: number;   // 70_000_000_000
    vramRequired: number;     // in MB
    layerCount: number;       // total transformer layers
    contributorId?: string;   // who uploaded/improved it
    version: number;          // monotonic version
    parentModelId?: string;   // base model (for LoRA/fine-tunes)
    createdAt: number;
    updatedAt: number;
}

export type ModelRegistrationInput = Omit<ModelEntry, '_id' | 'version' | 'createdAt' | 'updatedAt'>;

export interface ModelQuery {
    capability?: string;
    family?: string;
    maxVram?: number;
    minParams?: number;
    maxParams?: number;
}

interface RegistryStore {
    put(entry: any): Promise<void>;
    get(id: string): Promise<any>;
    del(id: string): Promise<void>;
    all(): Promise<Array<{ key: string; value: any }>>;
}

/** Fee multiplier tiers by parameter count */
function computeFeeMultiplier(parameterCount: number): number {
    const billions = parameterCount / 1e9;
    if (billions <= 7) return 1.0;
    if (billions <= 13) return 2.0;
    if (billions <= 70) return 5.0;
    return 10.0;
}

export class ModelRegistry {
    /** Node→Model assignments stored in-memory (could be a separate store) */
    private readonly nodeModels = new Map<string, Set<string>>();
    /** Cache of entries for getFeeMultiplier (sync lookups) */
    private readonly cache = new Map<string, ModelEntry>();

    constructor(private readonly store: RegistryStore) { }

    /**
     * Register a new model in the catalog.
     * @throws If model with same ID already exists
     */
    async register(input: ModelRegistrationInput): Promise<ModelEntry> {
        const existing = await this.store.get(input.modelId);
        if (existing) {
            throw new Error(`Model "${input.modelId}" already registered`);
        }

        // Validate parent exists if specified
        if (input.parentModelId) {
            const parent = await this.store.get(input.parentModelId);
            if (!parent) {
                throw new Error(`Parent model "${input.parentModelId}" not found`);
            }
        }

        const now = Date.now();
        const entry: ModelEntry = {
            _id: input.modelId,
            ...input,
            version: 1,
            createdAt: now,
            updatedAt: now,
        };

        await this.store.put(entry);
        this.cache.set(entry.modelId, entry);
        return entry;
    }

    /**
     * Get a model by ID.
     */
    async getModel(modelId: string): Promise<ModelEntry | null> {
        const entry = await this.store.get(modelId);
        return entry ? (entry as ModelEntry) : null;
    }

    /**
     * Update a model's metadata and bump version.
     */
    async updateModel(
        modelId: string,
        updates: Partial<Pick<ModelEntry, 'capabilities' | 'quantization' | 'vramRequired' | 'contributorId'>>,
    ): Promise<ModelEntry> {
        const entry = await this.store.get(modelId);
        if (!entry) {
            throw new Error(`Model "${modelId}" not found`);
        }

        const updated: ModelEntry = {
            ...entry,
            ...updates,
            version: entry.version + 1,
            updatedAt: Date.now(),
        };

        await this.store.put(updated);
        this.cache.set(modelId, updated);
        return updated;
    }

    /**
     * Query models by capability, family, VRAM, or parameter count.
     */
    async query(q: ModelQuery): Promise<ModelEntry[]> {
        const allEntries = await this.store.all();
        let models = allEntries.map(e => e.value as ModelEntry);

        if (q.capability) {
            models = models.filter(m => m.capabilities.includes(q.capability!));
        }
        if (q.family) {
            models = models.filter(m => m.family === q.family);
        }
        if (q.maxVram !== undefined) {
            models = models.filter(m => m.vramRequired <= q.maxVram!);
        }
        if (q.minParams !== undefined) {
            models = models.filter(m => m.parameterCount >= q.minParams!);
        }
        if (q.maxParams !== undefined) {
            models = models.filter(m => m.parameterCount <= q.maxParams!);
        }

        return models;
    }

    /**
     * List all registered models.
     */
    async listAll(): Promise<ModelEntry[]> {
        const entries = await this.store.all();
        return entries.map(e => e.value as ModelEntry);
    }

    /**
     * Get the full lineage chain: [root, ..., self].
     */
    async getLineage(modelId: string): Promise<ModelEntry[]> {
        const chain: ModelEntry[] = [];
        let current = await this.store.get(modelId);

        while (current) {
            chain.unshift(current as ModelEntry);
            if (current.parentModelId) {
                current = await this.store.get(current.parentModelId);
            } else {
                break;
            }
        }

        return chain;
    }

    /**
     * Assign a model to a node (the node is serving this model).
     */
    async assignNodeModel(nodeId: string, modelId: string): Promise<void> {
        if (!this.nodeModels.has(nodeId)) {
            this.nodeModels.set(nodeId, new Set());
        }
        this.nodeModels.get(nodeId)!.add(modelId);
    }

    /**
     * Unassign a model from a node.
     */
    async unassignNodeModel(nodeId: string, modelId: string): Promise<void> {
        this.nodeModels.get(nodeId)?.delete(modelId);
    }

    /**
     * Get all node IDs serving a specific model.
     */
    async getNodesForModel(modelId: string): Promise<string[]> {
        const nodes: string[] = [];
        for (const [nodeId, models] of this.nodeModels) {
            if (models.has(modelId)) {
                nodes.push(nodeId);
            }
        }
        return nodes;
    }

    /**
     * Get all models available on a specific node.
     */
    async getModelsForNode(nodeId: string): Promise<ModelEntry[]> {
        const modelIds = this.nodeModels.get(nodeId);
        if (!modelIds) return [];

        const models: ModelEntry[] = [];
        for (const id of modelIds) {
            const entry = await this.store.get(id);
            if (entry) models.push(entry as ModelEntry);
        }
        return models;
    }

    /**
     * Get fee multiplier for a model (synchronous, uses cache).
     * Falls back to 1.0 if model not in cache.
     */
    getFeeMultiplier(modelId: string): number {
        const entry = this.cache.get(modelId);
        if (!entry) return 1.0;
        return computeFeeMultiplier(entry.parameterCount);
    }
}
