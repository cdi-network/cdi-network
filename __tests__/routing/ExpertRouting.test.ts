/**
 * R-2: HNSW Expert Routing — TDD Tests
 *
 * Tests:
 * 1. ExpertIndex: add/search nearest expert with cosine distance
 * 2. ExpertIndex: dimension validation
 * 3. ExpertIndex: multiple experts, k=2 returns top-2
 * 4. ChunkRouter: sentence-boundary chunking
 * 5. ChunkRouter: routes chunks to nearest expert via mock embeddings
 * 6. ChunkRouter: full pipeline (prompt → route)
 */
import { ExpertIndex } from '../../src/routing/ExpertIndex.js';
import { ChunkRouter, type EmbedFunction } from '../../src/routing/ChunkRouter.js';

describe('R-2: ExpertIndex', () => {
    test('add expert and find nearest match', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        index.addExpert('worker-math', [1.0, 0.0, 0.0]);
        index.addExpert('worker-code', [0.0, 1.0, 0.0]);
        index.addExpert('worker-text', [0.0, 0.0, 1.0]);

        // Query similar to math expert
        const results = index.findBestExperts([0.9, 0.1, 0.0], 1);

        expect(results).toHaveLength(1);
        expect(results[0].workerId).toBe('worker-math');
        expect(results[0].distance).toBeGreaterThanOrEqual(0);
    });

    test('rejects wrong dimension embedding', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        expect(() => index.addExpert('w1', [1.0, 0.0])).toThrow('3D');
    });

    test('rejects wrong dimension query', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        index.addExpert('w1', [1.0, 0.0, 0.0]);
        expect(() => index.findBestExperts([1.0, 0.0], 1)).toThrow('3D');
    });

    test('returns top-k experts', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        index.addExpert('w1', [1.0, 0.0, 0.0]);
        index.addExpert('w2', [0.8, 0.2, 0.0]);
        index.addExpert('w3', [0.0, 0.0, 1.0]);

        const results = index.findBestExperts([0.9, 0.1, 0.0], 2);
        expect(results).toHaveLength(2);
        // Both w1 and w2 should be closer than w3
        const ids = results.map(r => r.workerId);
        expect(ids).toContain('w1');
        expect(ids).toContain('w2');
    });

    test('returns empty when no experts', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        const results = index.findBestExperts([1.0, 0.0, 0.0], 1);
        expect(results).toHaveLength(0);
    });

    test('size tracks added experts', () => {
        const index = new ExpertIndex({ dimensions: 2 });
        expect(index.size).toBe(0);
        index.addExpert('w1', [1.0, 0.0]);
        expect(index.size).toBe(1);
        index.addExpert('w2', [0.0, 1.0]);
        expect(index.size).toBe(2);
    });
});

describe('R-2: ChunkRouter', () => {
    // Mock embed function: simple hash-like deterministic embedding
    const mockEmbedFn: EmbedFunction = async (text: string) => {
        // Create a simple 3D "embedding" based on first chars
        const chars = text.toLowerCase().split('');
        const sum = chars.reduce((acc, c) => acc + c.charCodeAt(0), 0);
        return [
            Math.sin(sum) * 0.5 + 0.5,
            Math.cos(sum) * 0.5 + 0.5,
            Math.sin(sum * 2) * 0.5 + 0.5,
        ];
    };

    test('chunkPrompt splits on sentence boundaries', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        const router = new ChunkRouter({
            expertIndex: index,
            embedFn: mockEmbedFn,
            maxChunkLength: 50,
        });

        const chunks = router.chunkPrompt('Hello world. How are you? I am fine.');
        expect(chunks.length).toBeGreaterThanOrEqual(1);
        // Should preserve all text
        expect(chunks.join(' ')).toContain('Hello world');
    });

    test('chunkPrompt handles single sentence', () => {
        const index = new ExpertIndex({ dimensions: 3 });
        const router = new ChunkRouter({
            expertIndex: index,
            embedFn: mockEmbedFn,
        });

        const chunks = router.chunkPrompt('Just one sentence');
        expect(chunks).toEqual(['Just one sentence']);
    });

    test('routeChunks assigns each chunk to best expert', async () => {
        const index = new ExpertIndex({ dimensions: 3 });
        index.addExpert('expert-a', [1.0, 0.0, 0.0]);
        index.addExpert('expert-b', [0.0, 1.0, 0.0]);

        const router = new ChunkRouter({
            expertIndex: index,
            embedFn: mockEmbedFn,
        });

        const routings = await router.routeChunks(['chunk 1', 'chunk 2']);
        expect(routings).toHaveLength(2);
        routings.forEach(r => {
            expect(r.chunk).toBeDefined();
            expect(r.expert.workerId).toMatch(/^expert-/);
            expect(typeof r.expert.distance).toBe('number');
        });
    });

    test('route performs full pipeline: prompt → chunks → routing', async () => {
        const index = new ExpertIndex({ dimensions: 3 });
        index.addExpert('math-node', [1.0, 0.0, 0.0]);
        index.addExpert('text-node', [0.0, 1.0, 0.0]);
        index.addExpert('code-node', [0.0, 0.0, 1.0]);

        const router = new ChunkRouter({
            expertIndex: index,
            embedFn: mockEmbedFn,
            maxChunkLength: 100,
        });

        const routings = await router.route(
            'Calculate the integral of x squared. Then write the code to implement it.',
        );

        expect(routings.length).toBeGreaterThanOrEqual(1);
        routings.forEach(r => {
            expect(r.chunk.length).toBeGreaterThan(0);
            expect(r.expert.workerId).toMatch(/node$/);
        });
    });
});
