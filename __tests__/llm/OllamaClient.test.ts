import nock from 'nock';
import { OllamaClientBuilder } from '../../src/llm/OllamaClient.js';
import type { OllamaGenerateRequest } from '../../src/types/index.js';

const BASE_URL = 'http://127.0.0.1:11434';

describe('OllamaClient', () => {
    afterEach(() => {
        nock.abortPendingRequests();
        nock.cleanAll();
    });

    // ── Builder ─────────────────────────────────────────────
    test('should build with defaults', () => {
        const client = new OllamaClientBuilder().build();
        expect(client).toBeDefined();
    });

    test('should build with custom host and port', () => {
        const client = new OllamaClientBuilder()
            .withHost('192.168.1.10')
            .withPort(9999)
            .build();
        expect(client).toBeDefined();
    });

    // ── generate ────────────────────────────────────────────
    test('should return response for valid prompt', async () => {
        const mockResponse = {
            model: 'tinyllama',
            response: 'Hello! How can I help?',
            done: true,
            total_duration: 500_000_000,
            eval_count: 10,
            prompt_eval_count: 5,
        };

        nock(BASE_URL)
            .post('/api/generate')
            .reply(200, mockResponse);

        const client = new OllamaClientBuilder().build();
        const req: OllamaGenerateRequest = {
            model: 'tinyllama',
            prompt: 'Hello',
            stream: false,
        };

        const result = await client.generate(req);
        expect(result.response).toBe('Hello! How can I help?');
        expect(result.model).toBe('tinyllama');
        expect(result.done).toBe(true);
        expect(result.eval_count).toBe(10);
    });

    // ── Retry ───────────────────────────────────────────────
    test('should retry on connection error then succeed', async () => {
        const mockResponse = {
            model: 'tinyllama',
            response: 'ok',
            done: true,
            total_duration: 100,
            eval_count: 1,
            prompt_eval_count: 1,
        };

        // First call fails, second succeeds
        nock(BASE_URL)
            .post('/api/generate')
            .replyWithError('ECONNREFUSED');

        nock(BASE_URL)
            .post('/api/generate')
            .reply(200, mockResponse);

        const client = new OllamaClientBuilder()
            .withRetry(3, 50) // fast retry for test
            .build();

        const result = await client.generate({
            model: 'tinyllama',
            prompt: 'test',
            stream: false,
        });

        expect(result.response).toBe('ok');
    });

    // ── Timeout ─────────────────────────────────────────────
    test('should timeout after configured ms', async () => {
        nock(BASE_URL)
            .post('/api/generate')
            .delay(2000) // delay longer than timeout
            .reply(200, { response: 'too late' });

        const client = new OllamaClientBuilder()
            .withTimeout(200)     // 200ms timeout
            .withRetry(1, 50)     // no retries
            .build();

        await expect(
            client.generate({ model: 'tinyllama', prompt: 'test', stream: false })
        ).rejects.toThrow();
    });

    // ── listModels ──────────────────────────────────────────
    test('should list available models', async () => {
        nock(BASE_URL)
            .get('/api/tags')
            .reply(200, {
                models: [
                    { name: 'tinyllama', size: 637_000_000, digest: 'abc123', modified_at: '2025-01-01' },
                    { name: 'llama2', size: 3_800_000_000, digest: 'def456', modified_at: '2025-01-02' },
                ],
            });

        const client = new OllamaClientBuilder().build();
        const models = await client.listModels();

        expect(models).toHaveLength(2);
        expect(models[0].name).toBe('tinyllama');
        expect(models[1].name).toBe('llama2');
    });

    // ── isAvailable ─────────────────────────────────────────
    test('should report available when server responds 200', async () => {
        nock(BASE_URL)
            .get('/')
            .reply(200, 'Ollama is running');

        const client = new OllamaClientBuilder().build();
        const available = await client.isAvailable();
        expect(available).toBe(true);
    });

    test('should report unavailable when server is down', async () => {
        nock(BASE_URL)
            .get('/')
            .replyWithError('ECONNREFUSED');

        const client = new OllamaClientBuilder()
            .withRetry(1, 50)
            .build();

        const available = await client.isAvailable();
        expect(available).toBe(false);
    });

    // ── hasModel ────────────────────────────────────────────
    test('should return true when model exists', async () => {
        nock(BASE_URL)
            .get('/api/tags')
            .reply(200, {
                models: [
                    { name: 'tinyllama', size: 637_000_000, digest: 'abc', modified_at: '2025-01-01' },
                ],
            });

        const client = new OllamaClientBuilder().build();
        expect(await client.hasModel('tinyllama')).toBe(true);
    });

    test('should return false when model does not exist', async () => {
        nock(BASE_URL)
            .get('/api/tags')
            .reply(200, { models: [] });

        const client = new OllamaClientBuilder().build();
        expect(await client.hasModel('nonexistent')).toBe(false);
    });

    // ── Error handling ──────────────────────────────────────
    test('should throw OllamaError on 404 from generate', async () => {
        nock(BASE_URL)
            .post('/api/generate')
            .reply(404, { error: 'model not found' });

        const client = new OllamaClientBuilder()
            .withRetry(1, 50)
            .build();

        await expect(
            client.generate({ model: 'nonexistent', prompt: 'test', stream: false })
        ).rejects.toThrow(/404/);
    });
});
