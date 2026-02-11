/**
 * BrowserInferenceEngine — In-browser LLM inference via WebLLM (WebGPU/WASM).
 *
 * Each browser tab IS a compute node. Models are downloaded once,
 * cached in IndexedDB, and run entirely on the local GPU via WebGPU.
 * Zero external API calls.
 *
 * @module browser/llm/BrowserInferenceEngine
 */

/**
 * Supported models — progressive scale from 360M to 8B.
 * Ordered by VRAM requirement for rolling capability testing.
 *
 * Tiers:
 *   xs  = <500MB VRAM   — any device
 *   s   = 500MB-1GB     — mid-range phones
 *   m   = 1-2GB         — flagship phones, low-end laptops
 *   l   = 2-4GB         — laptops with dGPU
 *   xl  = 4-8GB         — desktops, MacBooks with 8GB+
 */
export const SUPPORTED_MODELS = [
    {
        id: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
        name: 'SmolLM2 360M',
        params: '360M',
        vram: 130,
        family: 'smollm',
        tier: 'xs',
        description: 'Ultra fast — any device',
    },
    {
        id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC',
        name: 'Qwen2.5 0.5B',
        params: '0.5B',
        vram: 350,
        family: 'qwen',
        tier: 'xs',
        description: 'Qwen2.5 nano — low-end phones',
    },
    {
        id: 'TinyLlama-1.1B-Chat-v1.0-q4f16_1-MLC',
        name: 'TinyLlama 1.1B',
        params: '1.1B',
        vram: 900,
        family: 'llama',
        tier: 's',
        description: 'Primary testnet model',
    },
    {
        id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC',
        name: 'Qwen2.5 1.5B',
        params: '1.5B',
        vram: 1100,
        family: 'qwen',
        tier: 'm',
        description: 'Qwen2.5 small — good quality',
    },
    {
        id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
        name: 'Llama 3.2 1B',
        params: '1B',
        vram: 800,
        family: 'llama',
        tier: 's',
        description: 'Meta Llama 3.2 — fast',
    },
    {
        id: 'Gemma-2-2B-it-q4f16_1-MLC',
        name: 'Gemma 2 2B',
        params: '2B',
        vram: 2048,
        family: 'gemma',
        tier: 'm',
        description: 'Google Gemma — high quality',
    },
    {
        id: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
        name: 'Llama 3.2 3B',
        params: '3B',
        vram: 2200,
        family: 'llama',
        tier: 'm',
        description: 'Meta Llama 3.2 — balanced',
    },
    {
        id: 'Phi-3.5-mini-instruct-q4f16_1-MLC',
        name: 'Phi 3.5 Mini',
        params: '3.8B',
        vram: 2800,
        family: 'phi',
        tier: 'l',
        description: 'Microsoft Phi — reasoning',
    },
    {
        id: 'Qwen2.5-7B-Instruct-q4f16_1-MLC',
        name: 'Qwen2.5 7B',
        params: '7B',
        vram: 5200,
        family: 'qwen',
        tier: 'xl',
        description: 'Qwen2.5 large — best quality',
    },
    {
        id: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
        name: 'Llama 3.1 8B',
        params: '8B',
        vram: 5800,
        family: 'llama',
        tier: 'xl',
        description: 'Meta Llama 3.1 — flagship',
    },
];

/**
 * @typedef {'idle'|'loading'|'ready'|'inferring'|'error'} EngineStatus
 */

/**
 * @typedef {Object} GenerateResult
 * @property {string} text          - Generated text
 * @property {number} tokensGenerated
 * @property {number} tokensPerSecond
 * @property {number} latencyMs
 * @property {string} model
 */

export class BrowserInferenceEngine {
    /** @type {import('@mlc-ai/web-llm').MLCEngine|null} */
    #engine = null;

    /** @type {string|null} */
    #loadedModelId = null;

    /** @type {EngineStatus} */
    #status = 'idle';

    /** @type {number} 0-100 */
    #loadProgress = 0;

    /** @type {boolean} */
    #webGPUAvailable = false;

    /** @type {Function|null} */
    #onStatusChange = null;

    /** @type {Function|null} */
    #onProgress = null;

    /** @type {object|null} - injected WebLLM module (for DI/testing) */
    #webllm = null;

    /**
     * @param {Object} opts
     * @param {Function} [opts.onStatusChange] - (status, detail) => void
     * @param {Function} [opts.onProgress]     - (progress: number) => void
     * @param {object}   [opts.webllm]         - Injected WebLLM module (DI for testing)
     */
    constructor({ onStatusChange, onProgress, webllm } = {}) {
        this.#onStatusChange = onStatusChange || (() => { });
        this.#onProgress = onProgress || (() => { });
        this.#webllm = webllm || null;
    }

    /**
     * Check WebGPU availability.
     * @returns {Promise<boolean>}
     */
    async checkWebGPU() {
        if (typeof navigator === 'undefined' || !navigator.gpu) {
            this.#webGPUAvailable = false;
            return false;
        }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            this.#webGPUAvailable = !!adapter;
            return this.#webGPUAvailable;
        } catch {
            this.#webGPUAvailable = false;
            return false;
        }
    }

    /**
     * Load a model into the browser. Downloads weights on first run,
     * cached in IndexedDB for subsequent loads.
     *
     * @param {string} modelId - One of SUPPORTED_MODELS[].id
     * @returns {Promise<void>}
     */
    async init(modelId) {
        const model = SUPPORTED_MODELS.find(m => m.id === modelId);
        if (!model) {
            throw new Error(`Unknown model: ${modelId}. Supported: ${SUPPORTED_MODELS.map(m => m.id).join(', ')}`);
        }

        // If same model already loaded, skip
        if (this.#loadedModelId === modelId && this.#status === 'ready') {
            return;
        }

        this.#setStatus('loading', `Downloading ${model.name}…`);
        this.#loadProgress = 0;

        try {
            // Load WebLLM module (CDN or injected)
            const webllm = this.#webllm || await this.#loadWebLLM();

            // Create engine with progress callback
            this.#engine = await webllm.CreateMLCEngine(modelId, {
                initProgressCallback: (report) => {
                    this.#loadProgress = Math.round(report.progress * 100);
                    this.#onProgress(this.#loadProgress);
                    this.#onStatusChange('loading', `${model.name}: ${this.#loadProgress}%`);
                },
            });

            this.#loadedModelId = modelId;
            this.#loadProgress = 100;
            this.#setStatus('ready', `${model.name} loaded`);
        } catch (err) {
            this.#setStatus('error', err.message);
            throw err;
        }
    }

    /**
     * Run inference locally on the loaded model.
     *
     * @param {string} prompt
     * @param {Object} [opts]
     * @param {number} [opts.maxTokens=256]
     * @param {number} [opts.temperature=0.7]
     * @param {Function} [opts.onToken] - (token: string) => void — streaming callback
     * @returns {Promise<GenerateResult>}
     */
    async generate(prompt, { maxTokens = 256, temperature = 0.7, onToken } = {}) {
        if (!this.#engine || this.#status !== 'ready') {
            throw new Error('Engine not ready. Call init(modelId) first.');
        }

        this.#setStatus('inferring', 'Generating…');
        const startTime = performance.now();
        let fullText = '';
        let tokensGenerated = 0;

        try {
            const messages = [
                { role: 'system', content: 'You are a helpful AI assistant running on a decentralized compute network.' },
                { role: 'user', content: prompt },
            ];

            if (onToken) {
                // Streaming mode
                const stream = await this.#engine.chat.completions.create({
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                    stream: true,
                    stream_options: { include_usage: true },
                });

                for await (const chunk of stream) {
                    const delta = chunk.choices?.[0]?.delta?.content || '';
                    if (delta) {
                        fullText += delta;
                        tokensGenerated++;
                        onToken(delta);
                    }
                    // Check usage from final chunk
                    if (chunk.usage) {
                        tokensGenerated = chunk.usage.completion_tokens || tokensGenerated;
                    }
                }
            } else {
                // Non-streaming mode
                const response = await this.#engine.chat.completions.create({
                    messages,
                    max_tokens: maxTokens,
                    temperature,
                });

                fullText = response.choices?.[0]?.message?.content || '';
                tokensGenerated = response.usage?.completion_tokens || 0;
            }

            const latencyMs = performance.now() - startTime;
            const tokensPerSecond = tokensGenerated > 0 ? (tokensGenerated / (latencyMs / 1000)) : 0;

            this.#setStatus('ready', 'Inference complete');

            return {
                text: fullText,
                tokensGenerated,
                tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
                latencyMs: Math.round(latencyMs),
                model: this.#loadedModelId,
            };
        } catch (err) {
            this.#setStatus('error', err.message);
            throw err;
        }
    }

    /**
     * Dynamically import WebLLM from CDN (ESM).
     * @private
     * @returns {Promise<object>}
     */
    async #loadWebLLM() {
        return import('https://esm.run/@mlc-ai/web-llm');
    }

    /**
     * @private
     * @param {EngineStatus} status
     * @param {string} [detail]
     */
    #setStatus(status, detail = '') {
        this.#status = status;
        this.#onStatusChange(status, detail);
    }

    /** @returns {EngineStatus} */
    get status() { return this.#status; }

    /** @returns {number} 0-100 */
    get loadProgress() { return this.#loadProgress; }

    /** @returns {string|null} */
    get loadedModel() { return this.#loadedModelId; }

    /** @returns {boolean} */
    get isReady() { return this.#status === 'ready'; }

    /** @returns {boolean} */
    get webGPUAvailable() { return this.#webGPUAvailable; }

    /**
     * Get info about the loaded model.
     * @returns {Object|null}
     */
    getModelInfo() {
        if (!this.#loadedModelId) return null;
        return SUPPORTED_MODELS.find(m => m.id === this.#loadedModelId) || null;
    }

    /** Release GPU memory and engine resources. */
    async dispose() {
        if (this.#engine) {
            try {
                await this.#engine.unload();
            } catch { /* ignore cleanup errors */ }
            this.#engine = null;
        }
        this.#loadedModelId = null;
        this.#loadProgress = 0;
        this.#setStatus('idle');
    }
}
