/**
 * OllamaComputeAdapter — bridges Ollama's embedding API to the ComputeFn interface.
 *
 * Serializes Float32Array activations to base64, sends to Ollama /api/embed,
 * and returns the embedding as Float32Array. This allows real LLM computation
 * to slot into the pipeline's LayerServer architecture.
 */

import http from 'http';
import type { ComputeFn } from './LayerServer.js';

export interface OllamaComputeConfig {
    host: string;
    port: number;
    model: string;
    timeoutMs?: number;
}

export class OllamaComputeAdapter {
    private readonly host: string;
    private readonly port: number;
    private readonly model: string;
    private readonly timeoutMs: number;

    constructor(config: OllamaComputeConfig) {
        this.host = config.host;
        this.port = config.port;
        this.model = config.model;
        this.timeoutMs = config.timeoutMs ?? 30_000;
    }

    /**
     * Returns a ComputeFn that delegates to Ollama's /api/embed endpoint.
     * The Float32Array is serialized as base64 for transport.
     */
    toComputeFn(): ComputeFn {
        return async (input: Float32Array, layerIdx: number): Promise<Float32Array> => {
            // Serialize Float32Array → base64 string
            const buffer = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
            const b64 = buffer.toString('base64');

            // Call Ollama /api/embed
            const body = JSON.stringify({
                model: this.model,
                input: b64,
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
