/**
 * GenesisUpload — Batch upload of open-weight models at network genesis.
 *
 * Uploads 40+ models from the GENESIS_MODELS list, shards them,
 * uploads to Helia IPFS, and registers in ModelCatalog.
 *
 * @module browser/catalog/GenesisUpload
 */

/**
 * Pre-defined genesis model list (40+ open-weight models).
 * In production, actual weights are downloaded from HuggingFace.
 * Here we define the manifest metadata.
 */
export const GENESIS_MODELS = [
    // ── LLaMA Family ──
    { modelId: 'llama-3.2-1b', name: 'Llama 3.2 1B', family: 'llama', paramCount: 1_000_000_000, hiddenDim: 2048, numLayers: 16, quantization: 'q4_0', license: 'llama3', tags: ['chat'] },
    { modelId: 'llama-3.2-3b', name: 'Llama 3.2 3B', family: 'llama', paramCount: 3_000_000_000, hiddenDim: 3072, numLayers: 28, quantization: 'q4_0', license: 'llama3', tags: ['chat'] },
    { modelId: 'llama-3.1-8b', name: 'Llama 3.1 8B', family: 'llama', paramCount: 8_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'llama3', tags: ['chat', 'reasoning'] },
    { modelId: 'llama-3.1-70b', name: 'Llama 3.1 70B', family: 'llama', paramCount: 70_000_000_000, hiddenDim: 8192, numLayers: 80, quantization: 'q4_0', license: 'llama3', tags: ['chat', 'reasoning'] },
    { modelId: 'codellama-7b', name: 'Code Llama 7B', family: 'llama', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'llama3', tags: ['code'] },
    { modelId: 'codellama-34b', name: 'Code Llama 34B', family: 'llama', paramCount: 34_000_000_000, hiddenDim: 8192, numLayers: 48, quantization: 'q4_0', license: 'llama3', tags: ['code'] },

    // ── Mistral Family ──
    { modelId: 'mistral-7b-v0.3', name: 'Mistral 7B v0.3', family: 'mistral', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'mistral-nemo-12b', name: 'Mistral Nemo 12B', family: 'mistral', paramCount: 12_000_000_000, hiddenDim: 5120, numLayers: 40, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'mixtral-8x7b', name: 'Mixtral 8x7B', family: 'mistral', paramCount: 46_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat', 'moe'] },
    { modelId: 'codestral-22b', name: 'Codestral 22B', family: 'mistral', paramCount: 22_000_000_000, hiddenDim: 6144, numLayers: 40, quantization: 'q4_0', license: 'apache-2.0', tags: ['code'] },

    // ── Qwen Family ──
    { modelId: 'qwen2.5-0.5b', name: 'Qwen 2.5 0.5B', family: 'qwen', paramCount: 500_000_000, hiddenDim: 1024, numLayers: 24, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'qwen2.5-3b', name: 'Qwen 2.5 3B', family: 'qwen', paramCount: 3_000_000_000, hiddenDim: 2048, numLayers: 36, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'qwen2.5-7b', name: 'Qwen 2.5 7B', family: 'qwen', paramCount: 7_000_000_000, hiddenDim: 3584, numLayers: 28, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'qwen2.5-72b', name: 'Qwen 2.5 72B', family: 'qwen', paramCount: 72_000_000_000, hiddenDim: 8192, numLayers: 80, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat', 'reasoning'] },
    { modelId: 'qwen2.5-coder-7b', name: 'Qwen 2.5 Coder 7B', family: 'qwen', paramCount: 7_000_000_000, hiddenDim: 3584, numLayers: 28, quantization: 'q4_0', license: 'apache-2.0', tags: ['code'] },
    { modelId: 'qwen-vl-7b', name: 'Qwen VL 7B', family: 'qwen', paramCount: 7_000_000_000, hiddenDim: 3584, numLayers: 28, quantization: 'q4_0', license: 'apache-2.0', tags: ['vision'] },

    // ── Phi Family (Microsoft) ──
    { modelId: 'phi-3-mini-4k', name: 'Phi-3 Mini 4K', family: 'phi', paramCount: 3_800_000_000, hiddenDim: 3072, numLayers: 32, quantization: 'q4_0', license: 'mit', tags: ['chat'] },
    { modelId: 'phi-3-medium-14b', name: 'Phi-3 Medium 14B', family: 'phi', paramCount: 14_000_000_000, hiddenDim: 5120, numLayers: 40, quantization: 'q4_0', license: 'mit', tags: ['chat', 'reasoning'] },
    { modelId: 'phi-4-14b', name: 'Phi-4 14B', family: 'phi', paramCount: 14_000_000_000, hiddenDim: 5120, numLayers: 40, quantization: 'q4_0', license: 'mit', tags: ['chat', 'reasoning'] },

    // ── Gemma Family (Google) ──
    { modelId: 'gemma-2-2b', name: 'Gemma 2 2B', family: 'gemma', paramCount: 2_000_000_000, hiddenDim: 2304, numLayers: 26, quantization: 'q4_0', license: 'gemma', tags: ['chat'] },
    { modelId: 'gemma-2-9b', name: 'Gemma 2 9B', family: 'gemma', paramCount: 9_000_000_000, hiddenDim: 3584, numLayers: 42, quantization: 'q4_0', license: 'gemma', tags: ['chat'] },
    { modelId: 'gemma-2-27b', name: 'Gemma 2 27B', family: 'gemma', paramCount: 27_000_000_000, hiddenDim: 4608, numLayers: 46, quantization: 'q4_0', license: 'gemma', tags: ['chat', 'reasoning'] },
    { modelId: 'codegemma-7b', name: 'CodeGemma 7B', family: 'gemma', paramCount: 7_000_000_000, hiddenDim: 3072, numLayers: 28, quantization: 'q4_0', license: 'gemma', tags: ['code'] },

    // ── DeepSeek ──
    { modelId: 'deepseek-r1-7b', name: 'DeepSeek R1 7B', family: 'deepseek', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 28, quantization: 'q4_0', license: 'mit', tags: ['reasoning'] },
    { modelId: 'deepseek-r1-70b', name: 'DeepSeek R1 70B', family: 'deepseek', paramCount: 70_000_000_000, hiddenDim: 8192, numLayers: 80, quantization: 'q4_0', license: 'mit', tags: ['reasoning'] },
    { modelId: 'deepseek-v3-685b', name: 'DeepSeek V3 685B', family: 'deepseek', paramCount: 685_000_000_000, hiddenDim: 16384, numLayers: 128, quantization: 'q4_0', license: 'mit', tags: ['reasoning', 'moe'] },
    { modelId: 'deepseek-coder-v2-16b', name: 'DeepSeek Coder V2 16B', family: 'deepseek', paramCount: 16_000_000_000, hiddenDim: 6144, numLayers: 28, quantization: 'q4_0', license: 'mit', tags: ['code'] },

    // ── Smaller / Specialized ──
    { modelId: 'tinyllama-1.1b', name: 'TinyLlama 1.1B', family: 'llama', paramCount: 1_100_000_000, hiddenDim: 2048, numLayers: 22, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'smollm2-360m', name: 'SmolLM2 360M', family: 'smollm', paramCount: 360_000_000, hiddenDim: 1024, numLayers: 24, quantization: 'fp16', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'smollm2-1.7b', name: 'SmolLM2 1.7B', family: 'smollm', paramCount: 1_700_000_000, hiddenDim: 2048, numLayers: 24, quantization: 'q4_0', license: 'apache-2.0', tags: ['chat'] },
    { modelId: 'starcoder2-3b', name: 'StarCoder2 3B', family: 'starcoder', paramCount: 3_000_000_000, hiddenDim: 2560, numLayers: 30, quantization: 'q4_0', license: 'apache-2.0', tags: ['code'] },
    { modelId: 'starcoder2-15b', name: 'StarCoder2 15B', family: 'starcoder', paramCount: 15_000_000_000, hiddenDim: 6144, numLayers: 40, quantization: 'q4_0', license: 'apache-2.0', tags: ['code'] },
    { modelId: 'nomic-embed-v2', name: 'Nomic Embed V2', family: 'nomic', paramCount: 137_000_000, hiddenDim: 768, numLayers: 12, quantization: 'fp16', license: 'apache-2.0', tags: ['embedding'] },
    { modelId: 'snowflake-arctic-embed', name: 'Snowflake Arctic Embed', family: 'arctic', paramCount: 110_000_000, hiddenDim: 768, numLayers: 12, quantization: 'fp16', license: 'apache-2.0', tags: ['embedding'] },

    // ── Vision ──
    { modelId: 'llava-v1.6-7b', name: 'LLaVA v1.6 7B', family: 'llava', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'apache-2.0', tags: ['vision', 'chat'] },
    { modelId: 'moondream-2b', name: 'Moondream 2B', family: 'moondream', paramCount: 2_000_000_000, hiddenDim: 2048, numLayers: 24, quantization: 'q4_0', license: 'apache-2.0', tags: ['vision'] },

    // ── Audio ──
    { modelId: 'whisper-large-v3', name: 'Whisper Large V3', family: 'whisper', paramCount: 1_550_000_000, hiddenDim: 1280, numLayers: 32, quantization: 'fp16', license: 'mit', tags: ['audio', 'transcription'] },

    // ── Medical / Scientific ──
    { modelId: 'meditron-7b', name: 'Meditron 7B', family: 'meditron', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'llama3', tags: ['medical'] },
    { modelId: 'biomistral-7b', name: 'BioMistral 7B', family: 'biomistral', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'apache-2.0', tags: ['medical'] },

    // ── Math / Reasoning ──
    { modelId: 'mathstral-7b', name: 'Mathstral 7B', family: 'mistral', paramCount: 7_000_000_000, hiddenDim: 4096, numLayers: 32, quantization: 'q4_0', license: 'apache-2.0', tags: ['math', 'reasoning'] },
];

export class GenesisUpload {
    #catalog;
    #sharder;

    /**
     * @param {Object} deps
     * @param {import('./ModelCatalog.js').ModelCatalog} deps.catalog
     * @param {import('./ModelSharder.js').ModelSharder} deps.sharder
     */
    constructor({ catalog, sharder }) {
        if (!catalog || !sharder) throw new Error('GenesisUpload requires catalog and sharder');
        this.#catalog = catalog;
        this.#sharder = sharder;
    }

    /**
     * Register all genesis models in the catalog and create shard plans.
     * @returns {{ modelsRegistered: number, totalShards: number, families: string[] }}
     */
    registerAll() {
        let totalShards = 0;
        const families = new Set();

        for (const model of GENESIS_MODELS) {
            // Register in catalog
            this.#catalog.registerModel({
                ...model,
                totalSizeBytes: this.#estimateSize(model),
                shardCount: 0,
            });

            // Create shard plan
            const shards = this.#sharder.createPlan({
                modelId: model.modelId,
                numLayers: model.numLayers,
                hiddenDim: model.hiddenDim,
                totalSizeBytes: this.#estimateSize(model),
            });

            this.#catalog.attachShards(model.modelId, shards);
            totalShards += shards.length;
            families.add(model.family);
        }

        return {
            modelsRegistered: GENESIS_MODELS.length,
            totalShards,
            families: [...families],
        };
    }

    /**
     * Get genesis stats.
     * @returns {{ totalModels: number, totalParams: number, families: string[] }}
     */
    static getStats() {
        const totalParams = GENESIS_MODELS.reduce((s, m) => s + m.paramCount, 0);
        const families = [...new Set(GENESIS_MODELS.map(m => m.family))];
        return {
            totalModels: GENESIS_MODELS.length,
            totalParams,
            families,
        };
    }

    /** @private */
    #estimateSize(model) {
        // q4_0 ≈ 0.5 bytes/param, fp16 ≈ 2 bytes/param
        const bytesPerParam = model.quantization === 'fp16' ? 2 : 0.5;
        return Math.round(model.paramCount * bytesPerParam);
    }
}
