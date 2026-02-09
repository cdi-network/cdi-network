// ── Task Lifecycle ──────────────────────────────────────────
export enum TaskStatus {
    PENDING = 'PENDING',
    CLAIMED = 'CLAIMED',
    RUNNING = 'RUNNING',
    COMPLETED = 'COMPLETED',
    FAILED = 'FAILED',
    CANCELLED = 'CANCELLED',
}

export interface InferenceTask {
    _id: string;
    prompt: string;
    model: string;
    status: TaskStatus;
    requesterPeerId: string;
    workerPeerId?: string;
    createdAt: number;
    claimedAt?: number;
    completedAt?: number;
    options?: OllamaOptions;
    encrypted?: boolean;
    parentTaskId?: string;
    chunkIndex?: number;
    totalChunks?: number;
    error?: string;
}

export interface InferenceResult {
    _id: string;
    taskId: string;
    response: string;
    model: string;
    workerPeerId: string;
    totalDurationNs?: number;
    evalCount?: number;
    promptEvalCount?: number;
    completedAt: number;
    error?: string;
}

// ── Ollama ──────────────────────────────────────────────────
export interface OllamaOptions {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
}

export interface OllamaGenerateRequest {
    model: string;
    prompt: string;
    stream: false;
    options?: OllamaOptions;
    system?: string;
    format?: 'json';
}

export interface OllamaGenerateResponse {
    model: string;
    response: string;
    done: boolean;
    total_duration: number;
    eval_count: number;
    prompt_eval_count: number;
}

export interface OllamaModelInfo {
    name: string;
    size: number;
    digest: string;
    modified_at: string;
}

// ── Crypto ──────────────────────────────────────────────────
export interface EncryptionModule {
    replication: {
        encrypt: (data: Uint8Array) => Promise<Uint8Array>;
        decrypt: (data: Uint8Array) => Promise<Uint8Array>;
    };
    data: {
        encrypt: (data: Uint8Array) => Promise<Uint8Array>;
        decrypt: (data: Uint8Array) => Promise<Uint8Array>;
    };
}

export interface KeyPair {
    publicKey: string;
    privateKey: string;
}

// ── Config ──────────────────────────────────────────────────
export interface NodeConfig {
    nodeId?: string;
    ollamaHost: string;
    ollamaPort: number;
    orbitDbDirectory: string;
    bootstrapPeers: string[];
    listenAddresses: string[];
    models: string[];
    maxConcurrentTasks: number;
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ── Events (internal pub/sub) ───────────────────────────────
export interface SwarmEvents {
    'task:created': (task: InferenceTask) => void;
    'task:claimed': (task: InferenceTask) => void;
    'task:completed': (task: InferenceTask, result: InferenceResult) => void;
    'task:failed': (task: InferenceTask, error: Error) => void;
    'peer:joined': (peerId: string) => void;
    'peer:left': (peerId: string) => void;
}
