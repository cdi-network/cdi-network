/**
 * ExpertIndex — HNSW-based expert/worker routing index.
 *
 * Each worker registers its "expertise embedding" (generated from the
 * type of tasks it excels at). When a prompt chunk arrives, the index
 * finds the most similar expert workers using approximate nearest neighbor
 * search via HNSW.
 *
 * Uses the Builder pattern for configuration.
 */

// hnswlib-node is a native CJS module
import hnswlib from 'hnswlib-node';

const { HierarchicalNSW } = hnswlib;

export interface ExpertMatch {
    workerId: string;
    distance: number;
}

export interface ExpertIndexConfig {
    dimensions: number;
    maxElements?: number;
    efConstruction?: number;
    m?: number;
}

export class ExpertIndex {
    private readonly index: InstanceType<typeof HierarchicalNSW>;
    private readonly workerMap: Map<number, string> = new Map();
    private nextLabel = 0;
    private readonly dimensions: number;

    constructor(config: ExpertIndexConfig) {
        this.dimensions = config.dimensions;
        const maxElements = config.maxElements ?? 1000;
        const efConstruction = config.efConstruction ?? 200;
        const m = config.m ?? 16;

        this.index = new HierarchicalNSW('cosine', this.dimensions);
        this.index.initIndex(maxElements, m, efConstruction);
    }

    /**
     * Add an expert worker and its embedding to the index.
     */
    addExpert(workerId: string, embedding: number[]): void {
        if (embedding.length !== this.dimensions) {
            throw new Error(`Embedding must be ${this.dimensions}D, got ${embedding.length}D`);
        }
        const label = this.nextLabel++;
        this.index.addPoint(embedding, label);
        this.workerMap.set(label, workerId);
    }

    /**
     * Find the k most similar expert workers for a query embedding.
     */
    findBestExperts(queryEmbedding: number[], k: number = 1): ExpertMatch[] {
        if (queryEmbedding.length !== this.dimensions) {
            throw new Error(`Query must be ${this.dimensions}D, got ${queryEmbedding.length}D`);
        }

        const effectiveK = Math.min(k, this.workerMap.size);
        if (effectiveK === 0) return [];

        const result = this.index.searchKnn(queryEmbedding, effectiveK);

        return result.neighbors.map((label: number, i: number) => ({
            workerId: this.workerMap.get(label)!,
            distance: result.distances[i],
        }));
    }

    /**
     * Number of experts currently indexed.
     */
    get size(): number {
        return this.workerMap.size;
    }
}
