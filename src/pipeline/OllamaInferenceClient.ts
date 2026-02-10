/**
 * OllamaInferenceClient — HTTP client for Ollama generate + embed APIs.
 *
 * Replaces all mock functions with real Ollama HTTP calls.
 * Designed for dependency injection into DistributedInferenceOrchestrator.
 *
 * Usage:
 *   const client = new OllamaInferenceClient({ host: 'ollama', port: 11434, model: 'tinyllama' });
 *   const text = await client.generate('What is quantum computing?');
 *   const embedding = await client.embed('quantum computing');
 */

import http from 'http';
import crypto from 'crypto';
import type { NodeInferenceFn } from './DistributedInferenceOrchestrator.js';
import type { EmbedFunction } from '../routing/ChunkRouter.js';

export interface OllamaClientConfig {
    host: string;
    port: number;
    model: string;
    embedModel?: string;       // model for embeddings (defaults to main model)
    timeoutMs?: number;
    dimensions?: number;       // expected embedding dimensions
}

export class OllamaInferenceClient {
    private readonly host: string;
    private readonly port: number;
    private readonly model: string;
    private readonly embedModel: string;
    private readonly timeoutMs: number;
    private readonly dimensions: number;

    constructor(config: OllamaClientConfig) {
        this.host = config.host;
        this.port = config.port;
        this.model = config.model;
        this.embedModel = config.embedModel ?? config.model;
        this.timeoutMs = config.timeoutMs ?? 120_000;
        this.dimensions = config.dimensions ?? 4;
    }

    /**
     * Generate text via Ollama /api/generate.
     */
    async generate(prompt: string): Promise<string> {
        const body = JSON.stringify({
            model: this.model,
            prompt,
            stream: false,
            options: { temperature: 0.7, num_predict: 256 },
        });

        const response = await this.httpPost('/api/generate', body);
        const parsed = JSON.parse(response);
        return parsed.response?.trim() ?? '';
    }

    /**
     * Get embedding vector via Ollama /api/embed.
     */
    async embed(text: string): Promise<number[]> {
        const body = JSON.stringify({
            model: this.embedModel,
            input: text,
        });

        const response = await this.httpPost('/api/embed', body);
        const parsed = JSON.parse(response);

        // Ollama returns { embeddings: [[...]] } or { embedding: [...] }
        const embedding: number[] = Array.isArray(parsed.embeddings?.[0])
            ? parsed.embeddings[0]
            : parsed.embedding ?? [];

        return embedding;
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
     * Pull a model if not already available.
     */
    async pullModel(modelName?: string): Promise<void> {
        const body = JSON.stringify({
            name: modelName ?? this.model,
            stream: false,
        });
        await this.httpPost('/api/pull', body);
    }

    /**
     * Warm up model by running a minimal inference.
     */
    async warmUp(): Promise<void> {
        await this.generate('hello');
    }

    /**
     * Create a NodeInferenceFn for the DistributedInferenceOrchestrator.
     * Each call sends the chunk to Ollama and returns text + token representations.
     */
    toNodeInferenceFn(): NodeInferenceFn {
        return async (_nodeId: string, chunk: string) => {
            const text = await this.generate(chunk);

            // Create deterministic token representations from I/O for ZK proofs
            const inputHash = crypto.createHash('sha256').update(chunk).digest();
            const outputHash = crypto.createHash('sha256').update(text).digest();

            const inputTokens = new Float32Array(this.dimensions);
            const outputTokens = new Float32Array(this.dimensions);
            for (let i = 0; i < this.dimensions; i++) {
                inputTokens[i] = inputHash[i % inputHash.length] / 255;
                outputTokens[i] = outputHash[i % outputHash.length] / 255;
            }

            return { text, inputTokens, outputTokens };
        };
    }

    /**
     * Create an EmbedFunction for the ChunkRouter.
     * Each call sends text to Ollama /api/embed and returns the vector.
     */
    toEmbedFn(): EmbedFunction {
        return async (text: string) => this.embed(text);
    }

    // ── HTTP helpers ────────────────────────────────────────

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
            req.on('error', (err) => reject(new Error(`Ollama error: ${err.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
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
            req.on('error', (err) => reject(new Error(`Ollama error: ${err.message}`)));
            req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
            req.end();
        });
    }
}
