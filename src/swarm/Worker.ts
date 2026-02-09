import type { TaskStore } from '../store/TaskStore.js';
import type { OllamaClient } from '../llm/OllamaClient.js';
import type { InferenceTask } from '../types/index.js';
import { TaskStatus } from '../types/index.js';

interface WorkerConfig {
    peerId: string;
    models: string[];
    maxConcurrent: number;
    pollIntervalMs?: number;
}

/**
 * Worker — polls TaskStore for PENDING tasks, runs inference via OllamaClient,
 * and writes results back. Respects model filtering and concurrency limits.
 */
export class Worker {
    private running = false;
    private activeTasks = 0;
    private timer: ReturnType<typeof setInterval> | null = null;
    private readonly pollIntervalMs: number;

    constructor(
        private readonly taskStore: TaskStore,
        private readonly ollamaClient: OllamaClient,
        private readonly config: WorkerConfig,
    ) {
        this.pollIntervalMs = config.pollIntervalMs ?? 1000;
    }

    /**
     * Begin polling for tasks.
     */
    start(): void {
        this.running = true;
        this.poll(); // immediate first poll
        this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    }

    /**
     * Stop accepting new tasks. In-flight tasks will finish.
     */
    stop(): void {
        this.running = false;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /**
     * Returns the number of currently processing tasks.
     */
    getActiveTaskCount(): number {
        return this.activeTasks;
    }

    // ── Internal ─────────────────────────────────────────────

    private async poll(): Promise<void> {
        if (!this.running) return;
        if (this.activeTasks >= this.config.maxConcurrent) return;

        try {
            const pending = await this.taskStore.getPendingTasks();

            for (const task of pending) {
                if (!this.running) break;
                if (this.activeTasks >= this.config.maxConcurrent) break;
                if (!this.config.models.includes(task.model)) continue;

                // Fire-and-forget: process task concurrently
                this.processTask(task);
            }
        } catch {
            // Swallow poll errors — will retry on next interval
        }
    }

    private async processTask(task: InferenceTask): Promise<void> {
        this.activeTasks++;

        try {
            // Claim the task
            await this.taskStore.claimTask(task._id, this.config.peerId);

            // Run inference
            const result = await this.ollamaClient.generate({
                model: task.model,
                prompt: task.prompt,
                stream: false as const,
                options: task.options,
            });

            // Complete the task
            await this.taskStore.completeTask(task._id, {
                taskId: task._id,
                response: result.response,
                model: result.model,
                workerPeerId: this.config.peerId,
                evalCount: result.eval_count,
                totalDurationNs: result.total_duration,
            });
        } catch (err) {
            // Fail the task
            const message = err instanceof Error ? err.message : String(err);
            try {
                await this.taskStore.failTask(task._id, message);
            } catch {
                // Swallow secondary failure
            }
        } finally {
            this.activeTasks--;
        }
    }
}
