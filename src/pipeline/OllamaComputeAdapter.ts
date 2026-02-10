/**
 * OllamaComputeAdapter — bridges Ollama's embedding API to the ComputeFn interface.
 *
 * Serializes Float32Array activations to a text representation, sends to Ollama
 * /api/embed, and returns the embedding as Float32Array. This allows real LLM 
 * computation to slot into the pipeline's LayerServer architecture.
 *
 * In "generate" mode (fallback), uses /api/generate with a structured prompt
 * that produces numeric output.
 */

import http from 'http';
import type { ComputeFn } from './LayerServer.js';

export interface OllamaComputeConfig {
    host: string;
    port: number;
    model: string;
    timeoutMs?: number;
    /** 'embed' uses /api/embed, 'generate' uses /api/generate */
    mode?: 'embed' | 'generate';
}

export class OllamaComputeAdapter {
    private readonly host: string;
    private readonly port: number;
    private readonly model: string;
    private readonly timeoutMs: number;
    private readonly apiMode: 'embed' | 'generate';

    constructor(config: OllamaComputeConfig) {
        this.host = config.host;
        this.port = config.port;
        this.model = config.model;
        this.timeoutMs = config.timeoutMs ?? 30_000;
        this.apiMode = config.mode ?? 'embed';
    }

    /**
     * Returns a ComputeFn that delegates to Ollama.
     * For embed mode: sends text representation of activation, returns embedding vector.
     * For generate mode: sends prompt with activation data, parses CSV floats from response.
     */
    toComputeFn(): ComputeFn {
        if (this.apiMode === 'generate') {
            return this.generateComputeFn();
        }
        return this.embedComputeFn();
    }

    /**
     * Embed mode: sends activation as text, returns embedding vector.
     */
    private embedComputeFn(): ComputeFn {
        return async (input: Float32Array, layerIdx: number): Promise<Float32Array> => {
            // Serialize Float32Array → text representation for embed API
            const inputText = `layer:${layerIdx} data:${Array.from(input).map(v => v.toFixed(4)).join(',')}`;

            const body = JSON.stringify({
                model: this.model,
                input: inputText,
            });

            const response = await this.httpPost('/api/embed', body);
            const parsed = JSON.parse(response);

            // Extract embedding from response  
            const embedding: number[] = Array.isArray(parsed.embeddings?.[0])
                ? parsed.embeddings[0]
                : parsed.embedding ?? [];

            return new Float32Array(embedding);
        };
    }

    /**
     * Generate mode: uses text generation to produce numeric output.
     * More reliable with models that don't support embeddings well.
     */
    private generateComputeFn(): ComputeFn {
        return async (input: Float32Array, layerIdx: number): Promise<Float32Array> => {
            const dataStr = Array.from(input).map(v => v.toFixed(4)).join(',');
            const prompt = `You are a neural network layer ${layerIdx}. Given input activations [${dataStr}], output the transformed activations as a comma-separated list of ${input.length} numbers. Output ONLY the numbers, nothing else.`;

            const body = JSON.stringify({
                model: this.model,
                prompt,
                stream: false,
                options: { temperature: 0.1, num_predict: input.length * 8 + 20 },
            });

            const response = await this.httpPost('/api/generate', body);
            const parsed = JSON.parse(response);
            const text = parsed.response?.trim() ?? '';

            // Parse comma-separated floats from LLM response
            const numbers = text.split(/[,\s]+/).map(Number).filter((v: number) => Number.isFinite(v));

            // If LLM didn't produce enough numbers, pad with input values
            while (numbers.length < input.length) {
                numbers.push(input[numbers.length] ?? 0);
            }

            return new Float32Array(numbers.slice(0, input.length));
        };
    }

    /**
     * Check if Ollama is reachable.
     */
    async isHealthy(): Promise<boolean> {
        try {
            await this.httpGet('/');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Create from environment variables.
     */
    static fromEnv(): OllamaComputeAdapter {
        return new OllamaComputeAdapter({
            host: process.env.OLLAMA_HOST ?? '127.0.0.1',
            port: parseInt(process.env.OLLAMA_PORT ?? '11434', 10),
            model: process.env.OLLAMA_MODEL ?? 'tinyllama',
            timeoutMs: parseInt(process.env.OLLAMA_TIMEOUT ?? '30000', 10),
            mode: (process.env.OLLAMA_API_MODE as 'embed' | 'generate') ?? 'generate',
        });
    }

    // ── Internal HTTP helpers ───────────────────────────────

    private httpPost(path: string, body: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path,
                method: 'POST',
                timeout: this.timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const data = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(data);
                    } else {
                        reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`));
                    }
                });
            });
            req.on('error', (err) => reject(new Error(`Ollama connection error: ${err.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
            req.write(body);
            req.end();
        });
    }

    private httpGet(path: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const req = http.request({
                hostname: this.host,
                port: this.port,
                path,
                method: 'GET',
                timeout: this.timeoutMs,
            }, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
            });
            req.on('error', (err) => reject(new Error(`Ollama connection error: ${err.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timeout')); });
            req.end();
        });
    }
}
