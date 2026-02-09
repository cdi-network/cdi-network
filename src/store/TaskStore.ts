import { generateId } from '../utils/uuid.js';
import { now } from '../utils/timestamp.js';
import { TaskStatus } from '../types/index.js';
import type { InferenceTask, InferenceResult } from '../types/index.js';
import type { OrbitDbManager } from '../core/OrbitDbManager.js';

/**
 * Strips undefined values from an object so IPLD/dag-cbor can encode it.
 */
function stripUndefined<T extends Record<string, any>>(obj: T): T {
    return Object.fromEntries(
        Object.entries(obj).filter(([, v]) => v !== undefined)
    ) as T;
}

const TASKS_DB = 'swarm-tasks';
const RESULTS_DB = 'swarm-results';

interface CreateTaskInput {
    prompt: string;
    model: string;
    status?: TaskStatus;
    requesterPeerId: string;
    options?: Record<string, unknown>;
}

interface CompleteTaskInput {
    taskId: string;
    response: string;
    model: string;
    workerPeerId: string;
    evalCount?: number;
    totalDurationNs?: number;
}

/**
 * TaskStore — typed facade over OrbitDB Documents DBs for tasks and results.
 */
export class TaskStore {
    private tasksDb: any;
    private resultsDb: any;

    constructor(private readonly manager: OrbitDbManager) { }

    /**
     * Opens the underlying OrbitDB databases.
     * Must be called before any other method.
     */
    async initialize(): Promise<void> {
        this.tasksDb = await this.manager.openDocumentsDb(TASKS_DB);
        this.resultsDb = await this.manager.openDocumentsDb(RESULTS_DB);
    }

    /**
     * Creates a new inference task and writes it to the Tasks DB.
     */
    async createTask(input: CreateTaskInput): Promise<InferenceTask> {
        const task: InferenceTask = {
            _id: generateId(),
            prompt: input.prompt,
            model: input.model,
            status: input.status ?? TaskStatus.PENDING,
            requesterPeerId: input.requesterPeerId,
            createdAt: now(),
            options: input.options,
        };

        await this.tasksDb.put(stripUndefined(task));
        return task;
    }

    /**
     * Retrieves a task by ID. Returns null if not found.
     */
    async getTask(taskId: string): Promise<InferenceTask | null> {
        const results = await this.tasksDb.query((entry: any) => entry._id === taskId);
        if (!results || results.length === 0) return null;
        return this.extractDoc(results[0]);
    }

    /**
     * Claims a PENDING task for a worker. Throws if not in PENDING status.
     */
    async claimTask(taskId: string, workerPeerId: string): Promise<InferenceTask> {
        const task = await this.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.status !== TaskStatus.PENDING) {
            throw new Error(`Task ${taskId} is not PENDING (current: ${task.status})`);
        }

        const claimed: InferenceTask = {
            ...task,
            status: TaskStatus.CLAIMED,
            workerPeerId,
            claimedAt: now(),
        };

        await this.tasksDb.put(stripUndefined(claimed));
        return claimed;
    }

    /**
     * Marks a task as COMPLETED and stores the result.
     */
    async completeTask(taskId: string, result: CompleteTaskInput): Promise<void> {
        const task = await this.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        const completed: InferenceTask = {
            ...task,
            status: TaskStatus.COMPLETED,
            completedAt: now(),
        };

        await this.tasksDb.put(stripUndefined(completed));

        const inferenceResult: InferenceResult = {
            _id: generateId(),
            taskId: result.taskId,
            response: result.response,
            model: result.model,
            workerPeerId: result.workerPeerId,
            evalCount: result.evalCount,
            totalDurationNs: result.totalDurationNs,
            completedAt: now(),
        };

        await this.resultsDb.put(stripUndefined(inferenceResult));
    }

    /**
     * Marks a task as FAILED.
     */
    async failTask(taskId: string, error: string): Promise<void> {
        const task = await this.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);

        const failed: InferenceTask = {
            ...task,
            status: TaskStatus.FAILED,
            completedAt: now(),
            error,
        };

        await this.tasksDb.put(stripUndefined(failed));
    }

    /**
     * Returns all pending tasks.
     */
    async getPendingTasks(): Promise<InferenceTask[]> {
        const results = await this.tasksDb.query((entry: any) => entry.status === TaskStatus.PENDING);
        return (results || []).map((r: any) => this.extractDoc(r));
    }

    /**
     * Returns tasks created by a specific requester.
     */
    async getTasksByRequester(requesterPeerId: string): Promise<InferenceTask[]> {
        const results = await this.tasksDb.query((entry: any) => entry.requesterPeerId === requesterPeerId);
        return (results || []).map((r: any) => this.extractDoc(r));
    }

    /**
     * Returns tasks with a specific parentTaskId.
     */
    async getTasksByParent(parentTaskId: string): Promise<InferenceTask[]> {
        const results = await this.tasksDb.query((entry: any) => entry.parentTaskId === parentTaskId);
        return (results || []).map((r: any) => this.extractDoc(r));
    }

    /**
     * Cancels a PENDING task.
     */
    async cancelTask(taskId: string): Promise<void> {
        const task = await this.getTask(taskId);
        if (!task) throw new Error(`Task not found: ${taskId}`);
        if (task.status !== TaskStatus.PENDING) return; // Only cancel pending tasks

        const cancelled: InferenceTask = {
            ...task,
            status: TaskStatus.CANCELLED,
            completedAt: now(),
        };

        await this.tasksDb.put(stripUndefined(cancelled));
    }

    /**
     * Returns the result for a task, if any.
     */
    async getResult(taskId: string): Promise<InferenceResult | null> {
        const results = await this.resultsDb.query((entry: any) => entry.taskId === taskId);
        if (!results || results.length === 0) return null;
        return this.extractDoc(results[0]);
    }

    /**
     * Closes the underlying databases.
     */
    async close(): Promise<void> {
        if (this.tasksDb) await this.tasksDb.close();
        if (this.resultsDb) await this.resultsDb.close();
    }

    /**
     * OrbitDB Documents returns results wrapped in { value: doc } or as flat doc.
     */
    private extractDoc<T>(result: any): T {
        return (result?.value ?? result) as T;
    }
}
