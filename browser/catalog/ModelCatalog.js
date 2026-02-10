/**
 * ModelCatalog — OrbitDB-backed registry of available models.
 *
 * Stores model metadata, shard manifests, hosting stats,
 * and provides search/filter capabilities.
 *
 * @module browser/catalog/ModelCatalog
 */

/**
 * @typedef {Object} CatalogEntry
 * @property {string} modelId
 * @property {string} name
 * @property {string} family       - 'llama' | 'mistral' | 'qwen' | 'phi' | 'gemma' | etc.
 * @property {number} paramCount   - Total parameters
 * @property {string} quantization - 'fp16' | 'q4_0' | 'q8_0' | 'q5_k_m'
 * @property {number} totalSizeBytes
 * @property {number} shardCount
 * @property {string[]} tags       - ['chat', 'code', 'reasoning', 'vision']
 * @property {string} license      - 'apache-2.0' | 'mit' | 'llama3' | 'gemma'
 * @property {number} hostCount    - How many nodes currently host shards
 * @property {number} inferenceCount - Total inferences served
 * @property {number} addedAt
 */

export class ModelCatalog {
    /** @type {Map<string, CatalogEntry>} */
    #models = new Map();
    /** @type {Map<string, Object[]>} modelId → shard manifests */
    #shardManifests = new Map();

    constructor() { }

    /**
     * Register a model in the catalog.
     * @param {CatalogEntry} entry
     * @returns {this}
     */
    registerModel(entry) {
        if (!entry.modelId || !entry.name) {
            throw new Error('CatalogEntry requires modelId and name');
        }
        this.#models.set(entry.modelId, {
            hostCount: 0,
            inferenceCount: 0,
            addedAt: Date.now(),
            tags: [],
            ...entry,
        });
        return this;
    }

    /**
     * Attach shard manifest to a model.
     * @param {string} modelId
     * @param {Object[]} shards
     */
    attachShards(modelId, shards) {
        if (!this.#models.has(modelId)) throw new Error(`Unknown model: ${modelId}`);
        this.#shardManifests.set(modelId, shards);
        const model = this.#models.get(modelId);
        model.shardCount = shards.length;
    }

    /**
     * Get model by ID.
     * @param {string} modelId
     * @returns {CatalogEntry|null}
     */
    getModel(modelId) {
        return this.#models.get(modelId) || null;
    }

    /**
     * Search models by query (name, family, or tags).
     * @param {string} query
     * @returns {CatalogEntry[]}
     */
    search(query) {
        const q = query.toLowerCase();
        return [...this.#models.values()].filter(m =>
            m.name.toLowerCase().includes(q) ||
            m.family?.toLowerCase().includes(q) ||
            m.tags?.some(t => t.toLowerCase().includes(q))
        );
    }

    /**
     * Filter by family.
     * @param {string} family
     * @returns {CatalogEntry[]}
     */
    filterByFamily(family) {
        return [...this.#models.values()].filter(m => m.family === family);
    }

    /**
     * Filter by minimum param count.
     * @param {number} minParams
     * @returns {CatalogEntry[]}
     */
    filterBySize(minParams) {
        return [...this.#models.values()].filter(m => m.paramCount >= minParams);
    }

    /**
     * Get most popular models (by inference count).
     * @param {number} [limit=10]
     * @returns {CatalogEntry[]}
     */
    getPopular(limit = 10) {
        return [...this.#models.values()]
            .sort((a, b) => b.inferenceCount - a.inferenceCount)
            .slice(0, limit);
    }

    /**
     * Increment host count for model.
     * @param {string} modelId
     */
    incrementHosts(modelId) {
        const m = this.#models.get(modelId);
        if (m) m.hostCount++;
    }

    /**
     * Increment inference count.
     * @param {string} modelId
     */
    incrementInferences(modelId) {
        const m = this.#models.get(modelId);
        if (m) m.inferenceCount++;
    }

    /**
     * Get shard manifests for a model.
     * @param {string} modelId
     * @returns {Object[]}
     */
    getShards(modelId) {
        return this.#shardManifests.get(modelId) || [];
    }

    /** @returns {number} Total models in catalog */
    get modelCount() { return this.#models.size; }

    /** @returns {CatalogEntry[]} All models */
    getAll() { return [...this.#models.values()]; }

    /**
     * Export catalog as JSON.
     * @returns {Object}
     */
    toJSON() {
        return {
            models: [...this.#models.values()],
            totalModels: this.#models.size,
            exportedAt: Date.now(),
        };
    }
}
