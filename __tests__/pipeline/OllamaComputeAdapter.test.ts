/**
 * WS-P7a: OllamaComputeAdapter TDD Tests
 *
 * Tests the bridge from ComputeFn (Float32Array→Float32Array) to Ollama API.
 * Uses a lightweight HTTP mock to simulate Ollama responses.
 * Tests both 'embed' and 'generate' API modes.
 */
import http from 'http';
import { OllamaComputeAdapter } from '../../src/pipeline/OllamaComputeAdapter.js';

/** Spin up a tiny HTTP server that mimics Ollama /api/embed and /api/generate */
function createMockOllama(handlers: {
    embed?: (input: string) => number[];
    generate?: (prompt: string) => string;
}): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            if (req.url === '/api/embed' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    const parsed = JSON.parse(body);
                    const embedding = handlers.embed?.(parsed.input) ?? [0.1];
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: parsed.model, embeddings: [embedding] }));
                });
            } else if (req.url === '/api/generate' && req.method === 'POST') {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    const parsed = JSON.parse(body);
                    const response = handlers.generate?.(parsed.prompt) ?? '0.1,0.2,0.3';
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: parsed.model, response, done: true }));
                });
            } else if (req.url === '/' && req.method === 'GET') {
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

    afterEach((done) => {
        if (mockServer) mockServer.close(done);
        else done();
    });

    test('embed mode: should call Ollama embed API and return Float32Array', async () => {
        const mock = await createMockOllama({
            embed: () => [0.1, 0.2, 0.3, 0.4],
        });
        mockServer = mock.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock.port,
            model: 'test-model',
            mode: 'embed',
        });

        const computeFn = adapter.toComputeFn();
        const output = await computeFn(new Float32Array([1.0, 2.0, 3.0]), 0);

        expect(output).toBeInstanceOf(Float32Array);
        expect(output.length).toBe(4);
        expect(output[0]).toBeCloseTo(0.1, 4);
        expect(output[3]).toBeCloseTo(0.4, 4);
    });

    test('embed mode: should serialize activation as text', async () => {
        let capturedInput = '';
        const mock = await createMockOllama({
            embed: (input) => { capturedInput = input; return [1.0]; },
        });
        mockServer = mock.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock.port,
            model: 'test-model',
            mode: 'embed',
        });

        const computeFn = adapter.toComputeFn();
        await computeFn(new Float32Array([3.14, 2.72]), 5);

        expect(capturedInput).toContain('layer:5');
        expect(capturedInput).toContain('3.1400');
        expect(capturedInput).toContain('2.7200');
    });

    test('generate mode: should call /api/generate and parse CSV response', async () => {
        const mock = await createMockOllama({
            generate: () => '0.5, 0.6, 0.7',
        });
        mockServer = mock.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock.port,
            model: 'test-model',
            mode: 'generate',
        });

        const computeFn = adapter.toComputeFn();
        const output = await computeFn(new Float32Array([1.0, 2.0, 3.0]), 0);

        expect(output).toBeInstanceOf(Float32Array);
        expect(output.length).toBe(3);
        expect(output[0]).toBeCloseTo(0.5, 4);
        expect(output[1]).toBeCloseTo(0.6, 4);
        expect(output[2]).toBeCloseTo(0.7, 4);
    });

    test('generate mode: should pad output if LLM returns fewer numbers', async () => {
        const mock = await createMockOllama({
            generate: () => '0.5',
        });
        mockServer = mock.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock.port,
            model: 'test-model',
            mode: 'generate',
        });

        const computeFn = adapter.toComputeFn();
        const input = new Float32Array([1.0, 2.0, 3.0]);
        const output = await computeFn(input, 0);

        expect(output.length).toBe(3);
        expect(output[0]).toBeCloseTo(0.5, 4);
        // Padded with input values
        expect(output[1]).toBeCloseTo(2.0, 4);
        expect(output[2]).toBeCloseTo(3.0, 4);
    });

    test('should throw on Ollama connection failure', async () => {
        mockServer = undefined as any;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: 19999,
            model: 'test-model',
            timeoutMs: 1000,
        });

        const computeFn = adapter.toComputeFn();
        await expect(computeFn(new Float32Array([1]), 0)).rejects.toThrow(/Ollama connection error/);
    });

    test('should verify Ollama health check', async () => {
        const mock = await createMockOllama({});
        mockServer = mock.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock.port,
            model: 'test-model',
        });

        expect(await adapter.isHealthy()).toBe(true);

        const badAdapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: 19999,
            model: 'test-model',
            timeoutMs: 500,
        });
        expect(await badAdapter.isHealthy()).toBe(false);
    });

    test('should include model name in request', async () => {
        let capturedModel = '';
        const mock = await createMockOllama({
            embed: () => [1.0],
        });
        // Override to capture model
        mockServer = mock.server;
        mockServer.close();
        const mock2 = await new Promise<{ server: http.Server; port: number }>((resolve) => {
            const server = http.createServer((req, res) => {
                let body = '';
                req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
                req.on('end', () => {
                    const parsed = JSON.parse(body);
                    capturedModel = parsed.model;
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ model: 'test', embeddings: [[1.0]] }));
                });
            });
            server.listen(0, '127.0.0.1', () => {
                resolve({ server, port: (server.address() as any).port });
            });
        });
        mockServer = mock2.server;

        const adapter = new OllamaComputeAdapter({
            host: '127.0.0.1',
            port: mock2.port,
            model: 'tinyllama',
            mode: 'embed',
        });

        await adapter.toComputeFn()(new Float32Array([1]), 0);
        expect(capturedModel).toBe('tinyllama');
    });
});
