/**
 * ChunkRouter — Routes prompt chunks to expert workers via HNSW similarity.
 *
 * Flow: prompt → chunkPrompt() → embed each chunk → findBestExperts() → routing map
 *
 * Embedding generation uses a configurable function (for dependency injection),
 * allowing integration with Ollama or simulated embeddings for testing.
 */

import { ExpertIndex, type ExpertMatch } from './ExpertIndex.js';

export type EmbedFunction = (text: string) => Promise<number[]>;

export interface ChunkRouterConfig {
    expertIndex: ExpertIndex;
    embedFn: EmbedFunction;
    maxChunkLength?: number;
}

export interface ChunkRouting {
    chunk: string;
    expert: ExpertMatch;
}

export class ChunkRouter {
    private readonly expertIndex: ExpertIndex;
    private readonly embedFn: EmbedFunction;
    private readonly maxChunkLength: number;

    constructor(config: ChunkRouterConfig) {
        this.expertIndex = config.expertIndex;
        this.embedFn = config.embedFn;
        this.maxChunkLength = config.maxChunkLength ?? 512;
    }

    /**
     * Chunk a prompt into segments.
     * Simple sentence-boundary chunking for the prototype.
     */
    chunkPrompt(text: string): string[] {
        const sentences = text.split(/(?<=[.!?])\s+/);
        const chunks: string[] = [];
        let current = '';

        for (const sentence of sentences) {
            if ((current + ' ' + sentence).length > this.maxChunkLength && current) {
                chunks.push(current.trim());
                current = sentence;
            } else {
                current = current ? current + ' ' + sentence : sentence;
            }
        }
        if (current.trim()) {
            chunks.push(current.trim());
        }
        return chunks;
    }

    /**
     * Route each chunk to the best expert worker.
     *
     * @returns Array of ChunkRouting: which expert handles which chunk
     */
    async routeChunks(chunks: string[]): Promise<ChunkRouting[]> {
        const routings: ChunkRouting[] = [];

        for (const chunk of chunks) {
            const embedding = await this.embedFn(chunk);
            const experts = this.expertIndex.findBestExperts(embedding, 1);
            if (experts.length > 0) {
                routings.push({ chunk, expert: experts[0] });
            }
        }

        return routings;
    }

    /**
     * Full pipeline: prompt → chunking → embedding → routing.
     */
    async route(prompt: string): Promise<ChunkRouting[]> {
        const chunks = this.chunkPrompt(prompt);
        return this.routeChunks(chunks);
    }
}
