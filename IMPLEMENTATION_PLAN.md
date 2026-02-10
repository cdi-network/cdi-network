# OrbitDB-Orchestrated P2P Inference Swarm — Implementation Plan

> **Audience**: Team of 20 developers working in parallel.
> **Stack**: TypeScript (ESM) · OrbitDB v3 · Helia v6 · libp2p · Ollama REST API
> **Branching**: Each workstream → `automation/feature/<id>`, merge → `automation/development`, final → `main`

---

## Table of Contents
1. [System Architecture](#1-system-architecture)
2. [Shared Contracts (Interfaces & Types)](#2-shared-contracts)
3. [Workstreams](#3-workstreams)
4. [Dependency Graph](#4-dependency-graph)
5. [Data Model](#5-data-model)
6. [API Reference (Internal)](#6-api-reference)
7. [Verification Matrix](#7-verification-matrix)

---

## 1. System Architecture

```mermaid
graph TD
    subgraph Node
        CLI["CLI / API Gateway"]
        SO["SwarmOrchestrator"]
        ODB["OrbitDbManager"]
        OC["OllamaClient"]
        CM["CryptoManager"]
        LOG["Logger"]
    end

    subgraph External
        IPFS["Helia (IPFS)"]
        LP2P["libp2p (TCP/Noise/Yamux/GossipSub)"]
        OLL["Ollama (localhost:11434)"]
    end

    CLI --> SO
    SO --> ODB
    SO --> OC
    SO --> CM
    ODB --> IPFS
    IPFS --> LP2P
    OC --> OLL
    SO --> LOG
    ODB --> LOG
    OC --> LOG
```

### Design Principles
- **KISS**: Each module does one thing.
- **DRY**: Shared types in `src/types/`, shared utils in `src/utils/`.
- **YAGNI**: No external library if not necessary; only what is required.
- **Builder Pattern**: All managers use fluent builder APIs.
- **Dependency Injection**: All deps passed via constructor/factory params.
- **TDD**: Write test → red → implement → green → refactor.

---

## 2. Shared Contracts

> **CRITICAL**: This section must be implemented **FIRST** (Workstream 0). All other workstreams depend on it.

### File: `src/types/index.ts`

```typescript
// ── Task Lifecycle ──────────────────────────────────────────
export enum TaskStatus {
  PENDING   = 'PENDING',    // Created, waiting for a worker
  CLAIMED   = 'CLAIMED',    // Worker has claimed it
  RUNNING   = 'RUNNING',    // Inference in progress
  COMPLETED = 'COMPLETED',  // Result available
  FAILED    = 'FAILED',     // Error occurred
  CANCELLED = 'CANCELLED',  // Requester cancelled
}

export interface InferenceTask {
  _id: string;                // UUID v4 — OrbitDB Documents indexBy field
  prompt: string;             // The user prompt (may be encrypted)
  model: string;              // Ollama model name, e.g. 'tinyllama'
  status: TaskStatus;
  requesterPeerId: string;    // PeerId of the node that created the task
  workerPeerId?: string;      // PeerId of the node processing the task
  createdAt: number;          // Unix ms timestamp
  claimedAt?: number;
  completedAt?: number;
  options?: OllamaOptions;    // Temperature, top_p, etc.
  encrypted?: boolean;        // Whether prompt/result are encrypted
  parentTaskId?: string;      // If this is a chunk of a larger task
  chunkIndex?: number;        // Position in the chunk sequence
  totalChunks?: number;       // Total chunks for the parent task
}

export interface InferenceResult {
  _id: string;                // Same UUID as the task
  taskId: string;             // Reference to InferenceTask._id
  response: string;           // The LLM response (may be encrypted)
  model: string;
  workerPeerId: string;
  totalDurationNs?: number;   // From Ollama response
  evalCount?: number;         // Tokens generated
  promptEvalCount?: number;   // Tokens in prompt
  completedAt: number;
  error?: string;             // If status is FAILED
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
  stream: false;              // Always non-streaming for v1
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
  replication: { encrypt: (data: Uint8Array) => Promise<Uint8Array>; decrypt: (data: Uint8Array) => Promise<Uint8Array> };
  data: { encrypt: (data: Uint8Array) => Promise<Uint8Array>; decrypt: (data: Uint8Array) => Promise<Uint8Array> };
}

export interface KeyPair {
  publicKey: string;   // Base64-encoded
  privateKey: string;  // Base64-encoded
}

// ── Config ──────────────────────────────────────────────────
export interface NodeConfig {
  nodeId?: string;
  ollamaHost: string;
  ollamaPort: number;
  orbitDbDirectory: string;
  bootstrapPeers: string[];   // Multiaddrs
  listenAddresses: string[];  // e.g. ['/ip4/0.0.0.0/tcp/0']
  models: string[];           // Models this node can serve
  maxConcurrentTasks: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ── Events (internal pub/sub) ───────────────────────────────
export interface SwarmEvents {
  'task:created':   (task: InferenceTask) => void;
  'task:claimed':   (task: InferenceTask) => void;
  'task:completed': (task: InferenceTask, result: InferenceResult) => void;
  'task:failed':    (task: InferenceTask, error: Error) => void;
  'peer:joined':    (peerId: string) => void;
  'peer:left':      (peerId: string) => void;
}
```

---

## 3. Workstreams

Each workstream is **independent** and can be developed in parallel. Dependencies between workstreams are resolved through the shared contracts above and mock implementations.

---

### WS-0: Shared Types & Project Skeleton
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws0-types` |
| **Owner** | Dev 1 |
| **Depends on** | Nothing |
| **Blocks** | All other workstreams |
| **Estimated effort** | 2h |

#### Tasks
1. Create `src/types/index.ts` with all interfaces above
2. Create `src/utils/logger.ts` — Winston logger with configurable level
3. Create `src/utils/uuid.ts` — UUID v4 generator wrapper
4. Create `src/utils/timestamp.ts` — `Date.now()` wrapper (testable)
5. Create test stubs: ensure types compile, logger writes to stdout

#### Logger Contract
```typescript
// src/utils/logger.ts
import winston from 'winston';

export const createLogger = (level: string = 'info', label?: string): winston.Logger => {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.label({ label: label || 'swarm' }),
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, label, message, ...meta }) =>
        `${timestamp} [${label}] ${level}: ${message} ${Object.keys(meta).length ? JSON.stringify(meta) : ''}`
      )
    ),
    transports: [new winston.transports.Console()],
  });
};
```

#### Acceptance
- `npm run build` succeeds
- `npm test -- --testPathPattern=types` passes

---

### WS-1: OllamaClient
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws1-ollama-client` |
| **Owner** | Dev 2–3 |
| **Depends on** | WS-0 (types) |
| **Blocks** | WS-5 (Worker) |
| **Estimated effort** | 4h |

#### File: `src/llm/OllamaClient.ts`

##### Builder API
```typescript
class OllamaClientBuilder {
  private host = '127.0.0.1';
  private port = 11434;
  private timeout = 120_000; // ms
  private retryAttempts = 3;
  private retryDelay = 1000; // ms

  withHost(host: string): this;
  withPort(port: number): this;
  withTimeout(ms: number): this;
  withRetry(attempts: number, delayMs: number): this;
  build(): OllamaClient;
}
```

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `generate` | `(req: OllamaGenerateRequest) => Promise<OllamaGenerateResponse>` | Sends POST `/api/generate` |
| `listModels` | `() => Promise<OllamaModelInfo[]>` | GET `/api/tags` |
| `isAvailable` | `() => Promise<boolean>` | GET `/` — returns true if 200 |
| `hasModel` | `(name: string) => Promise<boolean>` | Checks if model is in `listModels()` |
| `pullModel` | `(name: string) => Promise<void>` | POST `/api/pull` |

##### Tests (TDD — write FIRST)
| Test file | Test | Mock strategy |
|---|---|---|
| `__tests__/llm/OllamaClient.test.ts` | `should build with defaults` | No mock |
| | `should return response for valid prompt` | HTTP mock (nock/msw) |
| | `should retry on connection error` | HTTP mock returns ECONNREFUSED then 200 |
| | `should timeout after configured ms` | HTTP mock with delayed response |
| | `should list available models` | HTTP mock |
| | `should report unavailable when server is down` | HTTP mock |
| | `should throw on invalid model` | HTTP mock returns 404 |

##### Implementation Details
- Use Node.js native `http` module (no axios — KISS)
- Retry with exponential backoff: `delay * 2^attempt`
- All errors wrapped in custom `OllamaError` class
- Log every request at `debug` level, errors at `error` level

---

### WS-2: OrbitDbManager
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws2-orbitdb-manager` |
| **Owner** | Dev 4–6 |
| **Depends on** | WS-0 (types) |
| **Blocks** | WS-4 (TaskStore), WS-6 (Orchestrator) |
| **Estimated effort** | 8h |

#### File: `src/core/OrbitDbManager.ts`

##### Builder API
```typescript
class OrbitDbManagerBuilder {
  private directory = './orbitdb';
  private listenAddresses = ['/ip4/0.0.0.0/tcp/0'];
  private bootstrapPeers: string[] = [];

  withDirectory(dir: string): this;
  withListenAddresses(addrs: string[]): this;
  withBootstrapPeers(peers: string[]): this;
  build(): Promise<OrbitDbManager>;
}
```

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `getPeerId` | `() => string` | Returns this node's PeerId |
| `openDocumentsDb` | `(name: string, indexBy?: string) => Promise<DocumentsDB>` | Opens/creates a Documents DB |
| `openEventsDb` | `(name: string) => Promise<EventsDB>` | Opens/creates an Events DB |
| `openKeyValueDb` | `(name: string) => Promise<KeyValueDB>` | Opens/creates a KeyValue DB |
| `getDbAddress` | `(db: any) => string` | Returns canonical OrbitDB address |
| `stop` | `() => Promise<void>` | Graceful shutdown: close all DBs, stop Helia |

##### Internal: Helia + libp2p Setup
```typescript
// Inside build():
import { createHelia } from 'helia';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@libp2p/yamux';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { identify } from '@libp2p/identify';
import { bootstrap } from '@libp2p/bootstrap';

const libp2p = await createLibp2p({
  addresses: { listen: this.listenAddresses },
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: this.bootstrapPeers.length > 0 ? [bootstrap({ list: this.bootstrapPeers })] : [],
  services: {
    pubsub: gossipsub({ allowPublishToZeroTopicPeers: true }),
    identify: identify(),
  },
});
const ipfs = await createHelia({ libp2p });
```

##### Tests (TDD)
| Test file | Test |
|---|---|
| `__tests__/core/OrbitDbManager.test.ts` | `should create an instance with default config` |
| | `should return a valid peerId` |
| | `should open a Documents database` |
| | `should open an Events database` |
| | `should write and read from Documents DB` |
| | `should sync between two in-process nodes` |
| | `should stop gracefully without hanging` |

##### Critical Notes
- Each test must create its own temporary directory (use `os.tmpdir()`)
- Each test must call `manager.stop()` in `afterEach` — otherwise libp2p hangs
- Sync test: create 2 OrbitDbManagers, connect them via bootstrap, write on A, verify read on B
- Use `{ syncAutomatically: true }` when opening DBs for sync tests

---

### WS-3: CryptoManager
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws3-crypto` |
| **Owner** | Dev 7–8 |
| **Depends on** | WS-0 (types) |
| **Blocks** | WS-4 (TaskStore — optional encryption), WS-6 (Orchestrator) |
| **Estimated effort** | 4h |

#### File: `src/crypto/CryptoManager.ts`

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `generateKeyPair` | `() => Promise<KeyPair>` | ED25519 via Node.js `crypto` |
| `encrypt` | `(plaintext: string, publicKey: string) => Promise<string>` | Hybrid: ECDH + AES-256-GCM |
| `decrypt` | `(ciphertext: string, privateKey: string) => Promise<string>` | Reverse of encrypt |
| `createEncryptionModule` | `(keyPair: KeyPair) => EncryptionModule` | Returns OrbitDB-compatible encrypt/decrypt |
| `sign` | `(data: string, privateKey: string) => Promise<string>` | ED25519 signature |
| `verify` | `(data: string, signature: string, publicKey: string) => Promise<boolean>` | Signature verification |

##### Tests (TDD)
| Test | Description |
|---|---|
| `should generate a valid key pair` | Keys are base64, correct length |
| `should encrypt and decrypt a string` | Roundtrip |
| `should fail decryption with wrong key` | Throws error |
| `should produce different ciphertext for same plaintext` | Due to random IV |
| `should sign and verify data` | Roundtrip |
| `should reject invalid signature` | Returns false |
| `should produce OrbitDB-compatible EncryptionModule` | Roundtrip with Uint8Array |

##### Implementation: Use Node.js `crypto` only (no external deps)
```typescript
import { generateKeyPairSync, createCipheriv, createDecipheriv, randomBytes, sign, verify } from 'crypto';
```

---

### WS-4: TaskStore (OrbitDB Abstraction)
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws4-task-store` |
| **Owner** | Dev 9–11 |
| **Depends on** | WS-0, WS-2 (OrbitDbManager) |
| **Blocks** | WS-5 (Worker), WS-6 (Orchestrator) |
| **Estimated effort** | 6h |

#### File: `src/store/TaskStore.ts`

This module wraps OrbitDB Documents DB to provide a typed, domain-specific API for tasks and results.

##### Constructor (DI)
```typescript
class TaskStore {
  constructor(
    private orbitDbManager: OrbitDbManager,
    private logger: winston.Logger,
    private cryptoManager?: CryptoManager
  ) {}
}
```

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `initialize` | `() => Promise<void>` | Opens `tasks` and `results` DBs |
| `createTask` | `(task: Omit<InferenceTask, '_id' \| 'createdAt'>) => Promise<InferenceTask>` | Adds to tasks DB |
| `claimTask` | `(taskId: string, workerPeerId: string) => Promise<InferenceTask>` | Atomic claim (optimistic) |
| `completeTask` | `(taskId: string, result: Omit<InferenceResult, '_id' \| 'completedAt'>) => Promise<void>` | Updates task + writes result |
| `failTask` | `(taskId: string, error: string) => Promise<void>` | Sets status FAILED |
| `getTask` | `(taskId: string) => Promise<InferenceTask \| null>` | Lookup by ID |
| `getResult` | `(taskId: string) => Promise<InferenceResult \| null>` | Lookup by task ID |
| `getPendingTasks` | `() => Promise<InferenceTask[]>` | Query status=PENDING |
| `getTasksByRequester` | `(peerId: string) => Promise<InferenceTask[]>` | All tasks from a requester |
| `onTaskUpdate` | `(callback: (task: InferenceTask) => void) => void` | Subscribe to DB updates |
| `close` | `() => Promise<void>` | Close underlying DBs |

##### OrbitDB Internals
- **Tasks DB**: `orbitdb.open('swarm-tasks', { type: 'documents' })` — indexed by `_id`
- **Results DB**: `orbitdb.open('swarm-results', { type: 'documents' })` — indexed by `_id`
- **Conflict resolution**: Last-write-wins (CRDT default). For `claimTask`, use optimistic locking: read → check status=PENDING → write CLAIMED. If two workers claim simultaneously, both write; the Orchestrator resolves by checking `claimedAt` timestamp.

##### Tests (TDD)
| Test | Mock strategy |
|---|---|
| `should create a task with auto-generated ID and timestamp` | Real OrbitDB (in-memory) |
| `should claim a PENDING task` | Real OrbitDB |
| `should reject claiming an already CLAIMED task` | Real OrbitDB |
| `should complete a task and store result` | Real OrbitDB |
| `should query pending tasks` | Real OrbitDB with 5 tasks |
| `should emit update event when remote task appears` | Two-node sync |
| `should encrypt task content when CryptoManager provided` | Mock crypto |

---

### WS-5: Worker (Task Consumer + Inference Engine)
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws5-worker` |
| **Owner** | Dev 12–14 |
| **Depends on** | WS-0, WS-1 (OllamaClient), WS-4 (TaskStore) |
| **Blocks** | WS-7 (Integration) |
| **Estimated effort** | 6h |

#### File: `src/swarm/Worker.ts`

##### Constructor (DI)
```typescript
class Worker {
  constructor(
    private taskStore: TaskStore,
    private ollamaClient: OllamaClient,
    private logger: winston.Logger,
    private config: { peerId: string; models: string[]; maxConcurrent: number }
  ) {}
}
```

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `start` | `() => void` | Begin polling / listening for tasks |
| `stop` | `() => void` | Stop accepting new tasks, wait for current |
| `getActiveTaskCount` | `() => number` | Number of currently processing tasks |

##### Internal Flow
```
1. Listen for TaskStore 'update' events
2. Filter: status=PENDING AND model in this.config.models
3. Attempt claimTask(taskId, peerId)
4. If claim succeeds:
   a. Update status → RUNNING
   b. Call ollamaClient.generate({ model, prompt, stream: false })
   c. On success → taskStore.completeTask(taskId, result)
   d. On error → taskStore.failTask(taskId, error.message)
5. Respect maxConcurrent limit (use semaphore/PQueue)
```

##### Tests (TDD)
| Test | Mock strategy |
|---|---|
| `should pick up a PENDING task matching its models` | Mock TaskStore + Mock OllamaClient |
| `should ignore tasks for models it doesn't serve` | Mock TaskStore |
| `should not exceed maxConcurrent tasks` | Mock with delayed responses |
| `should mark task COMPLETED on success` | Mock OllamaClient returns response |
| `should mark task FAILED on Ollama error` | Mock OllamaClient throws |
| `should stop gracefully mid-task` | Mock with slow OllamaClient |

---

### WS-6: SwarmOrchestrator (Task Producer + Aggregator)
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws6-orchestrator` |
| **Owner** | Dev 15–17 |
| **Depends on** | WS-0, WS-3 (CryptoManager), WS-4 (TaskStore) |
| **Blocks** | WS-7 (Integration) |
| **Estimated effort** | 8h |

#### File: `src/swarm/SwarmOrchestrator.ts`

##### Constructor (DI)
```typescript
class SwarmOrchestrator {
  constructor(
    private taskStore: TaskStore,
    private cryptoManager: CryptoManager,
    private logger: winston.Logger,
    private config: { peerId: string; defaultModel: string }
  ) {}
}
```

##### Public Methods
| Method | Signature | Description |
|---|---|---|
| `submitPrompt` | `(prompt: string, opts?: SubmitOptions) => Promise<string>` | Returns parentTaskId |
| `getStatus` | `(taskId: string) => Promise<TaskStatusReport>` | Status + progress |
| `getResult` | `(taskId: string) => Promise<string>` | Aggregated result (waits) |
| `cancelTask` | `(taskId: string) => Promise<void>` | Cancel pending chunks |

##### SubmitOptions
```typescript
interface SubmitOptions {
  model?: string;
  chunkStrategy?: 'none' | 'split-by-paragraph' | 'split-by-size';
  maxChunkSize?: number;     // characters
  encrypt?: boolean;
}
```

##### Chunking Logic
```
IF chunkStrategy === 'none' OR prompt.length < maxChunkSize:
  → Create 1 InferenceTask
ELSE IF chunkStrategy === 'split-by-paragraph':
  → Split by '\n\n', group into chunks ≤ maxChunkSize
ELSE IF chunkStrategy === 'split-by-size':
  → Split at word boundaries every maxChunkSize chars

Each chunk → InferenceTask with parentTaskId, chunkIndex, totalChunks
```

##### Result Aggregation
```
Poll/listen for all chunks with parentTaskId
When all chunks have status=COMPLETED:
  → Concatenate results in chunkIndex order
  → Return aggregated response
If any chunk FAILED:
  → Mark parent as FAILED
```

##### Tests (TDD)
| Test | Mock strategy |
|---|---|
| `should submit a single-chunk task` | Mock TaskStore |
| `should split prompt into N chunks` | No mock (pure logic) |
| `should respect word boundaries in split-by-size` | No mock |
| `should aggregate results in correct order` | Mock TaskStore with results |
| `should report FAILED if any chunk fails` | Mock TaskStore |
| `should encrypt prompt when flag is set` | Mock CryptoManager |
| `should cancel all pending chunks` | Mock TaskStore |

---

### WS-7: Node Bootstrap & CLI
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws7-cli` |
| **Owner** | Dev 18–19 |
| **Depends on** | WS-1, WS-2, WS-3, WS-4, WS-5, WS-6 |
| **Blocks** | Nothing (final assembly) |
| **Estimated effort** | 4h |

#### File: `src/node/SwarmNode.ts`

##### Role
Composes all modules into a running node. A single node can act as **both** Producer and Consumer.

```typescript
class SwarmNode {
  static async create(config: NodeConfig): Promise<SwarmNode>;
  async submitPrompt(prompt: string, opts?: SubmitOptions): Promise<string>;
  async getResult(taskId: string): Promise<string>;
  async shutdown(): Promise<void>;
}
```

##### Internal Wiring
```typescript
// Inside SwarmNode.create():
const logger = createLogger(config.logLevel, config.nodeId);
const orbitDb = await new OrbitDbManagerBuilder()
    .withDirectory(config.orbitDbDirectory)
    .withListenAddresses(config.listenAddresses)
    .withBootstrapPeers(config.bootstrapPeers)
    .build();
const ollama = new OllamaClientBuilder()
    .withHost(config.ollamaHost)
    .withPort(config.ollamaPort)
    .build();
const crypto = new CryptoManager();
const taskStore = new TaskStore(orbitDb, logger, crypto);
await taskStore.initialize();
const worker = new Worker(taskStore, ollama, logger, {
    peerId: orbitDb.getPeerId(),
    models: config.models,
    maxConcurrent: config.maxConcurrentTasks,
});
const orchestrator = new SwarmOrchestrator(taskStore, crypto, logger, {
    peerId: orbitDb.getPeerId(),
    defaultModel: config.models[0],
});
worker.start();
```

#### File: `src/cli.ts`

```
Usage:
  swarm start [--config config.json]       Start a swarm node
  swarm submit "prompt text" [--model m]   Submit inference task
  swarm status <taskId>                    Check task status
  swarm result <taskId>                    Get result
```

Implementation: Use `process.argv` parsing (no external CLI lib — YAGNI).

##### Tests
| Test | Description |
|---|---|
| `should create a SwarmNode with valid config` | Integration test |
| `should submit and complete a task on single node` | Self-dispatch test |

---

### WS-8: Integration & E2E Testing
| Field | Value |
|---|---|
| **Branch** | `automation/feature/ws8-e2e` |
| **Owner** | Dev 20 |
| **Depends on** | All workstreams |
| **Blocks** | Release |
| **Estimated effort** | 8h |

#### Test Scenarios

| # | Test | Setup | Assert |
|---|---|---|---|
| 1 | **Single-node self-dispatch** | 1 SwarmNode, mock Ollama | Submit → complete → result matches mock |
| 2 | **Two-node inference** | Node A (producer), Node B (worker), mock Ollama on B | A submits → B claims → B completes → A gets result |
| 3 | **Chunked prompt** | 1 SwarmNode, large prompt, mock Ollama | 3 chunks created → 3 results → aggregated correctly |
| 4 | **Encrypted task** | 2 SwarmNodes, encryption enabled | Only designated worker can decrypt |
| 5 | **Worker failure recovery** | Worker crashes mid-task | Task returns to PENDING after timeout (future: WS-9) |
| 6 | **Real Ollama** | 1 SwarmNode, `tinyllama` model | Full roundtrip with actual LLM response |

---

## 4. Dependency Graph

```mermaid
graph LR
    WS0["WS-0: Types & Skeleton"]
    WS1["WS-1: OllamaClient"]
    WS2["WS-2: OrbitDbManager"]
    WS3["WS-3: CryptoManager"]
    WS4["WS-4: TaskStore"]
    WS5["WS-5: Worker"]
    WS6["WS-6: SwarmOrchestrator"]
    WS7["WS-7: Node & CLI"]
    WS8["WS-8: E2E Tests"]

    WS0 --> WS1
    WS0 --> WS2
    WS0 --> WS3
    WS2 --> WS4
    WS0 --> WS4
    WS1 --> WS5
    WS4 --> WS5
    WS3 --> WS6
    WS4 --> WS6
    WS5 --> WS7
    WS6 --> WS7
    WS7 --> WS8
```

**Parallel execution**: After WS-0, workstreams WS-1, WS-2, WS-3 run **fully in parallel**. WS-4 starts when WS-2 is done. WS-5 and WS-6 run in parallel once WS-4 is done. WS-7 and WS-8 are sequential at the end.

---

## 5. Data Model

### OrbitDB Databases

| DB Name | Type | Index | Content |
|---|---|---|---|
| `swarm-tasks` | Documents | `_id` | `InferenceTask` objects |
| `swarm-results` | Documents | `_id` | `InferenceResult` objects |
| `swarm-events` | Events | — | Audit log (task lifecycle events) |

### OrbitDB API Cheatsheet (from v3.0.2 source)

```typescript
// Open
const db = await orbitdb.open('swarm-tasks', { type: 'documents', sync: true });

// Write
await db.put({ _id: 'uuid', prompt: '...', status: 'PENDING', ... });

// Read by key
const doc = await db.get('uuid');  // Returns { hash, key, value }

// Query (full scan — use sparingly)
const pending = await db.query(doc => doc.status === 'PENDING');

// Listen for updates (from remote peers)
db.events.on('update', (entry) => {
  const { op, key, value } = entry.payload;
  // op: 'PUT' | 'DEL', key: '_id value', value: document
});

// Sync events
db.events.on('join', (peerId, heads) => { /* peer connected */ });
db.events.on('leave', (peerId) => { /* peer disconnected */ });
```

---

## 6. API Reference (Internal)

### Ollama REST API (localhost:11434)

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/` | GET | — | `Ollama is running` (200) |
| `/api/tags` | GET | — | `{ models: OllamaModelInfo[] }` |
| `/api/generate` | POST | `OllamaGenerateRequest` | `OllamaGenerateResponse` |
| `/api/pull` | POST | `{ name: string }` | Stream of progress |

---

## 7. Verification Matrix

| Phase | What | Who | How | Pass Criteria |
|---|---|---|---|---|
| Unit | Each module | WS owner | `npm test -- --testPathPattern=<module>` | All green |
| Integration | OrbitDB sync | WS-2 | 2-node in-process test | Data replicates in < 5s |
| Integration | TaskStore + OrbitDB | WS-4 | Real OrbitDB, typed operations | CRUD + query works |
| E2E | Single node | WS-8 | Mock Ollama | Full lifecycle |
| E2E | Multi node | WS-8 | 2 processes, mock Ollama | Cross-node task completion |
| E2E | Real LLM | WS-8 | `tinyllama` | Actual response within 30s |
| Performance | Throughput | WS-8 | 100 tasks, 2 workers | All complete in < 60s |

---

## Appendix: Git Workflow

```bash
# Start a workstream
git checkout automation/development
git checkout -b automation/feature/ws1-ollama-client

# Commit often with descriptive messages
git commit -m "feat(ws1): add OllamaClient builder with host/port config"
git commit -m "test(ws1): add unit tests for generate endpoint"
git commit -m "feat(ws1): implement retry with exponential backoff"

# When complete, merge to development
git checkout automation/development
git merge automation/feature/ws1-ollama-client

# After all WSs merged and E2E passes
git checkout main
git merge automation/development
```
