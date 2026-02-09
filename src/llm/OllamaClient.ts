import http from 'http';
import { createLogger } from '../utils/logger.js';
import { OllamaError } from './OllamaError.js';
import type {
    OllamaGenerateRequest,
    OllamaGenerateResponse,
    OllamaModelInfo,
} from '../types/index.js';
import type winston from 'winston';

// ── Builder ─────────────────────────────────────────────────

export class OllamaClientBuilder {
    private host = '127.0.0.1';
    private port = 11434;
    private timeout = 120_000;
    private retryAttempts = 3;
    private retryDelay = 1000;
    private logger?: winston.Logger;

    withHost(host: string): this {
        this.host = host;
        return this;
    }

    withPort(port: number): this {
        this.port = port;
        return this;
    }

    withTimeout(ms: number): this {
        this.timeout = ms;
        return this;
    }

    withRetry(attempts: number, delayMs: number): this {
        this.retryAttempts = attempts;
        this.retryDelay = delayMs;
        return this;
    }

    withLogger(logger: winston.Logger): this {
        this.logger = logger;
        return this;
    }

    build(): OllamaClient {
        return new OllamaClient(
            this.host,
            this.port,
            this.timeout,
            this.retryAttempts,
            this.retryDelay,
            this.logger || createLogger('info', 'ollama-client'),
        );
    }
}

// ── Client ──────────────────────────────────────────────────

export class OllamaClient {
    constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly timeout: number,
        private readonly retryAttempts: number,
        private readonly retryDelay: number,
        private readonly logger: winston.Logger,
    ) { }

    /**
     * Sends a generation request to Ollama.
     */
    async generate(req: OllamaGenerateRequest): Promise<OllamaGenerateResponse> {
        const body = JSON.stringify(req);
        const data = await this.request('POST', '/api/generate', body);
        return JSON.parse(data) as OllamaGenerateResponse;
    }

    /**
     * Lists all locally available models.
     */
    async listModels(): Promise<OllamaModelInfo[]> {
        const data = await this.request('GET', '/api/tags');
        const parsed = JSON.parse(data) as { models: OllamaModelInfo[] };
        return parsed.models;
    }

    /**
     * Checks if the Ollama server is reachable.
     */
    async isAvailable(): Promise<boolean> {
        try {
            await this.request('GET', '/');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Checks if a specific model is available locally.
     */
    async hasModel(name: string): Promise<boolean> {
        const models = await this.listModels();
        return models.some((m) => m.name === name);
    }

    /**
     * Pulls a model from the Ollama registry.
     */
    async pullModel(name: string): Promise<void> {
        const body = JSON.stringify({ name });
        await this.request('POST', '/api/pull', body);
    }

    // ── Internal HTTP helper with retry ─────────────────────

    private async request(method: string, path: string, body?: string): Promise<string> {
        let lastError: Error | undefined;

        for (let attempt = 0; attempt < this.retryAttempts; attempt++) {
            try {
                this.logger.debug(`${method} ${path}`, { attempt: attempt + 1 });
                return await this.doRequest(method, path, body);
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                this.logger.error(`Request failed: ${lastError.message}`, {
                    attempt: attempt + 1,
                    path,
                });

                // Don't retry on HTTP 4xx errors (client errors)
                if (lastError instanceof OllamaError && lastError.statusCode && lastError.statusCode >= 400 && lastError.statusCode < 500) {
                    throw lastError;
                }

                // Wait with exponential backoff before retrying
                if (attempt < this.retryAttempts - 1) {
                    const delay = this.retryDelay * Math.pow(2, attempt);
                    await this.sleep(delay);
                }
            }
        }

        throw lastError ?? new OllamaError('Unknown error', path);
    }

    private doRequest(method: string, path: string, body?: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const options: http.RequestOptions = {
                hostname: this.host,
                port: this.port,
                path,
                method,
                timeout: this.timeout,
                headers: body
                    ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
                    : undefined,
            };

            const req = http.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                    const responseBody = Buffer.concat(chunks).toString('utf-8');
                    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(responseBody);
                    } else {
                        reject(
                            new OllamaError(
                                `HTTP ${res.statusCode}: ${responseBody}`,
                                path,
                                res.statusCode,
                            ),
                        );
                    }
                });
            });

            req.on('error', (err) => {
                reject(new OllamaError(`Connection error: ${err.message}`, path, undefined, err));
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new OllamaError(`Request timeout after ${this.timeout}ms`, path));
            });

            if (body) {
                req.write(body);
            }
            req.end();
        });
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
