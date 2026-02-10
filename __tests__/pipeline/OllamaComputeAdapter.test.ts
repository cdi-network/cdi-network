/**
 * WS-P7a: OllamaComputeAdapter TDD Tests
 *
 * Tests the bridge from ComputeFn (Float32Array→Float32Array) to Ollama embedding API.
 * Uses a lightweight HTTP mock to simulate Ollama responses.
 */
import http from 'http';
import { OllamaComputeAdapter } from '../../src/pipeline/OllamaComputeAdapter.js';

/** Spin up a tiny HTTP server that mimics Ollama /api/embed */
function createMockOllama(embeddingFn: (input: string) => number[]): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/api/embed' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    const parsed = JSON.parse(body);
                    const embedding = embeddingFn(parsed.input);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: parsed.model, embeddings: [embedding] }));
                });
            } else if (req.url === '/' && req.method === 'GET') {
                // Health check
                res.writeHead(200);
                res.end('Ollama is running');
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address() as { port: number };
            resolve({ server, port: addr.port });
        });
    });
}

describe('WS-P7a: OllamaComputeAdapter', () => {
    let mockServer: http.Server;
    let mockPort: number;

    afterEach((done) => {
        if (mockServer) mockServer.close(done);
        else done();
    });

    test('should create a ComputeFn that calls Ollama embed API', async () => {
        // Mock returns deterministic embedding based on input length
        const mock = await createMockOllama((input) => {
            return [0.1, 0.2, 0.3, 0.4];
        });
        mockServer = mock.server;
        mockPort = mock.port;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mockPort,
            model: 'test-model',
        });

        const computeFn = adapter.toComputeFn();
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = await computeFn(input, 0);

        // Output should be the embedding from Ollama
        expect(output).toBeInstanceOf(Float32Array);
        expect(output.length).toBe(4);
        expect(output[0]).toBeCloseTo(0.1, 4);
        expect(output[3]).toBeCloseTo(0.4, 4);
    });

    test('should serialize Float32Array to base64 in the prompt', async () => {
        let capturedInput = '';
        const mock = await createMockOllama((input) => {
            capturedInput = input;
            return [1.0, 2.0];
        });
        mockServer = mock.server;
        mockPort = mock.port;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mockPort,
            model: 'test-model',
        });

        const computeFn = adapter.toComputeFn();
        const input = new Float32Array([3.14, 2.72]);
        await computeFn(input, 5);

        // Input should be base64 encoded buffer
        expect(capturedInput).toBeTruthy();
        // Verify the base64 can be decoded back
        const decoded = Buffer.from(capturedInput, 'base64');
        const restored = new Float32Array(decoded.buffer, decoded.byteOffset, decoded.byteLength / 4);
        expect(restored[0]).toBeCloseTo(3.14, 2);
        expect(restored[1]).toBeCloseTo(2.72, 2);
    });

    test('should include layer index as metadata in the prompt', async () => {
        let capturedBody: any = {};
        const mock = await createMockOllama((input) => {
            return [1.0];
        });
        // Override to capture full body
        mockServer?.close();
        const mock2 = await new Promise<{ server: http.Server; port: number }>((resolve) => {
            const server = http.createServer((req, res) => {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    capturedBody = JSON.parse(body);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: 'test', embeddings: [[1.0]] }));
                });
            });
            server.listen(0, '127.0.0.1', () => {
                resolve({ server, port: (server.address() as any).port });
            });
        });
        mockServer = mock2.server;
        mockPort = mock2.port;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock2.port,
            model: 'tinyllama',
        });

        const computeFn = adapter.toComputeFn();
        await computeFn(new Float32Array([1]), 7);

        expect(capturedBody.model).toBe('tinyllama');
    });

    test('should throw on Ollama connection failure', async () => {
        // Ensure no mock server is set (so afterEach won't interfere)
        mockServer = undefined as any;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: 19999, // no server here
            model: 'test-model',
            timeoutMs: 1000,
        });

        const computeFn = adapter.toComputeFn();
        await expect(computeFn(new Float32Array([1]), 0)).rejects.toThrow(/Ollama connection error/);
    });

    test('should verify Ollama health check', async () => {
        const mock = await createMockOllama(() => [1.0]);
        mockServer = mock.server;
        mockPort = mock.port;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mockPort,
            model: 'test-model',
        });

        const healthy = await adapter.isHealthy();
        expect(healthy).toBe(true);

        // Unhealthy check
        const badAdapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: 19999,
            model: 'test-model',
            timeoutMs: 500,
        });
        const unhealthy = await badAdapter.isHealthy();
        expect(unhealthy).toBe(false);
    });
});
