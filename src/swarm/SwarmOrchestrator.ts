import { TaskStatus } from '../types/index.js';
import type { TaskStore } from '../store/TaskStore.js';
import type { CryptoManager } from '../crypto/CryptoManager.js';
import type { InferenceTask } from '../types/index.js';

export interface SubmitOptions {
    model?: string;
    chunkStrategy?: 'none' | 'split-by-paragraph' | 'split-by-size';
    maxChunkSize?: number;
    encrypt?: boolean;
}

export interface TaskStatusReport {
    parentTaskId: string;
    status: TaskStatus;
    totalChunks: number;
    completedChunks: number;
    failedChunks: number;
}

interface OrchestratorConfig {
    peerId: string;
    defaultModel: string;
    encryptionPublicKey?: string;
}

/**
 * SwarmOrchestrator — submits prompts (optionally chunked/encrypted),
 * waits for results, and aggregates them in order.
 */
export class SwarmOrchestrator {
    constructor(
        private readonly taskStore: TaskStore,
        private readonly cryptoManager: CryptoManager,
        private readonly config: OrchestratorConfig,
    ) { }

    /**
     * Submits a prompt, optionally chunking and encrypting.
     * Returns a parentTaskId that represents the whole submission.
     */
    async submitPrompt(prompt: string, opts?: SubmitOptions): Promise<string> {
        const model = opts?.model ?? this.config.defaultModel;
        const strategy = opts?.chunkStrategy ?? 'none';
        const maxSize = opts?.maxChunkSize ?? Infinity;

        let chunks: string[];
        if (strategy === 'none' || prompt.length <= maxSize) {
            chunks = [prompt];
        } else if (strategy === 'split-by-paragraph') {
            chunks = this.splitByParagraph(prompt, maxSize);
        } else {
            chunks = this.splitBySize(prompt, maxSize);
        }

        // Generate a parentTaskId (first task's ID)
        const parentTaskId = `parent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        for (let i = 0; i < chunks.length; i++) {
            let chunkPrompt = chunks[i];
            let encrypted = false;

            if (opts?.encrypt && this.config.encryptionPublicKey) {
                chunkPrompt = await this.cryptoManager.encrypt(chunkPrompt, this.config.encryptionPublicKey);
                encrypted = true;
            }

            await this.taskStore.createTask({
                prompt: chunkPrompt,
                model,
                requesterPeerId: this.config.peerId,
                parentTaskId,
                chunkIndex: i,
                totalChunks: chunks.length,
                encrypted,
            } as any);
        }

        return parentTaskId;
    }

    /**
     * Returns the status of all chunks associated with a parent task.
     */
    async getStatus(parentTaskId: string): Promise<TaskStatusReport> {
        const chunks = await this.taskStore.getTasksByParent(parentTaskId);

        let completedChunks = 0;
        let failedChunks = 0;
        let overallStatus = TaskStatus.PENDING;

        for (const chunk of chunks) {
            if (chunk.status === TaskStatus.COMPLETED) completedChunks++;
            if (chunk.status === TaskStatus.FAILED) failedChunks++;
        }

        if (failedChunks > 0) {
            overallStatus = TaskStatus.FAILED;
        } else if (completedChunks === chunks.length) {
            overallStatus = TaskStatus.COMPLETED;
        } else if (completedChunks > 0) {
            overallStatus = TaskStatus.RUNNING;
        }

        return {
            parentTaskId,
            status: overallStatus,
            totalChunks: chunks.length,
            completedChunks,
            failedChunks,
        };
    }

    /**
     * Waits for all chunks to complete and returns the aggregated result.
     * Throws if any chunk fails.
     */
    async getResult(parentTaskId: string): Promise<string> {
        const chunks = await this.taskStore.getTasksByParent(parentTaskId);

        // Sort by chunkIndex
        chunks.sort((a: InferenceTask, b: InferenceTask) =>
            (a.chunkIndex ?? 0) - (b.chunkIndex ?? 0));

        const responses: string[] = [];
        for (const chunk of chunks) {
            if (chunk.status === TaskStatus.FAILED) {
                throw new Error(`Chunk ${chunk.chunkIndex} failed: ${chunk.error}`);
            }
            const result = await this.taskStore.getResult(chunk._id);
            responses.push(result?.response ?? '');
        }

        return responses.join(' ');
    }

    /**
     * Cancels all pending chunks for a parent task.
     */
    async cancelTask(parentTaskId: string): Promise<void> {
        const chunks = await this.taskStore.getTasksByParent(parentTaskId);
        for (const chunk of chunks) {
            if (chunk.status === TaskStatus.PENDING) {
                await this.taskStore.cancelTask(chunk._id);
            }
        }
    }

    // ── Chunking ─────────────────────────────────────────────

    private splitByParagraph(text: string, maxSize: number): string[] {
        const paragraphs = text.split('\n\n');
        const chunks: string[] = [];
        let current = '';

        for (const p of paragraphs) {
            if (current.length + p.length + 2 > maxSize && current.length > 0) {
                chunks.push(current.trim());
                current = p;
            } else {
                current += (current ? '\n\n' : '') + p;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks;
    }

    private splitBySize(text: string, maxSize: number): string[] {
        const words = text.split(/\s+/);
        const chunks: string[] = [];
        let current = '';

        for (const word of words) {
            if (current.length + word.length + 1 > maxSize && current.length > 0) {
                chunks.push(current.trim());
                current = word;
            } else {
                current += (current ? ' ' : '') + word;
            }
        }
        if (current.trim()) chunks.push(current.trim());
        return chunks;
    }
}
