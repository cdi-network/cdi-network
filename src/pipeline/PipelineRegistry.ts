import { generateId } from '../utils/uuid.js';

/**
 * Registration info for a node in the pipeline.
 */
export interface NodeRegistration {
    _id?: string;
    nodeId: string;
    peerId: string;
    host: string;
    port: number;
    startLayer: number;
    endLayer: number;
    model: string;
    status: 'online' | 'offline';
}

export type NodeRegistrationInput = Omit<NodeRegistration, '_id' | 'status'>;

/**
 * A minimal store interface (matches OrbitDB KeyValue shape).
 */
interface RegistryStore {
    put(entry: any): Promise<void>;
    get(id: string): Promise<any>;
    del(id: string): Promise<void>;
    all(): Promise<Array<{ key: string; value: any }>>;
}

/**
 * PipelineRegistry — registers which nodes serve which model layer ranges
 * and discovers complete pipeline topologies.
 */
export class PipelineRegistry {
    constructor(private readonly store: RegistryStore) { }

    /**
     * Register a node as serving a specific layer range for a model.
     */
    async registerNode(input: NodeRegistrationInput): Promise<NodeRegistration> {
        const reg: NodeRegistration = {
            _id: input.nodeId,
            nodeId: input.nodeId,
            peerId: input.peerId,
            host: input.host,
            port: input.port,
            startLayer: input.startLayer,
            endLayer: input.endLayer,
            model: input.model,
            status: 'online',
        };
        await this.store.put(reg);
        return reg;
    }

    /**
     * Get all registered nodes.
     */
    async getRegisteredNodes(): Promise<NodeRegistration[]> {
        const entries = await this.store.all();
        return entries.map((e) => e.value as NodeRegistration);
    }

    /**
     * Mark a node as offline so it's excluded from pipeline discovery.
     */
    async markOffline(nodeId: string): Promise<void> {
        const existing = await this.store.get(nodeId);
        if (existing) {
            existing.status = 'offline';
            await this.store.put(existing);
        }
    }

    /**
     * Remove a node registration entirely.
     */
    async unregisterNode(nodeId: string): Promise<void> {
        await this.store.del(nodeId);
    }

    /**
     * Discover a complete pipeline for the given model.
     * Returns nodes ordered by startLayer, verifying full coverage [0..totalLayers-1].
     */
    async discoverPipeline(model: string, totalLayers: number): Promise<NodeRegistration[]> {
        const allNodes = await this.getRegisteredNodes();

        // Filter by model and online status
        const candidates = allNodes
            .filter((n) => n.model === model && n.status === 'online')
            .sort((a, b) => a.startLayer - b.startLayer);

        if (candidates.length === 0) {
            throw new Error(`No online nodes found for model "${model}"`);
        }

        // Verify contiguous coverage from 0 to totalLayers - 1
        let expectedStart = 0;
        for (const node of candidates) {
            if (node.startLayer > expectedStart) {
                throw new Error(
                    `Layer coverage gap: expected layer ${expectedStart} but next node starts at ${node.startLayer}`
                );
            }
            expectedStart = node.endLayer + 1;
        }

        if (expectedStart < totalLayers) {
            throw new Error(
                `Layer coverage missing: only covered up to layer ${expectedStart - 1}, need ${totalLayers - 1}`
            );
        }

        return candidates;
    }
}
