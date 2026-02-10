# CDI Network Whitepaper v1.0

**Collaborative Distributed Inference**

*A peer-to-peer AI inference network with Bitcoin-inspired tokenomics*

---

## Abstract

CDI Network is a decentralized, permissionless AI inference protocol where participants earn tokens by contributing GPU resources. Every inference request is ZK-verified, fees are distributed automatically, and model creators earn perpetual royalties on usage. With a fixed supply of 21 million CDI tokens and a halving schedule tied to network throughput (IPS), CDI aligns the economic incentives of node operators, model creators, and users.

---

## 1. Introduction

Large Language Model (LLM) inference is dominated by centralized providers charging margin-rich API fees. CDI replaces this with a P2P network where:

- **Any GPU owner** runs a node and earns CDI tokens
- **Model creators** publish models and earn royalties on every inference
- **Users** pay inference fees directly to the network, not a corporation

The result: cheaper inference, censorship resistance, and a self-sustaining economy for open AI.

## 2. Architecture

### 2.1 Node Composition

A CDI Node is a single process that composes:

| Component | Purpose |
|---|---|
| **OrbitDB** | Decentralized P2P database (CRDT-based) for tasks, results, and registry |
| **Ollama** | Local LLM inference engine (runs models on GPU/CPU) |
| **LocalWallet** | Ed25519 identity + CDI balance management |
| **ModelRegistry** | On-chain model catalog with metadata and versioning |
| **ModelRouter** | Load-aware routing: 60% load + 30% latency + 10% VRAM |
| **ContributionTracker** | Royalty distribution engine |
| **AutoBalancer** | Network self-balancing (replicate, evict, migrate) |
| **ZK Prover/Verifier** | Circom-based zero-knowledge inference proofs |

### 2.2 Inference Flow

```
User pays CDI → Orchestrator → ChunkRouter → N parallel nodes
  → each node: Ollama inference + ZK proof generation
  → Verifier checks all proofs
  → Aggregate results → Settle fees → Return response
```

### 2.3 P2P Networking

- **Transport:** libp2p TCP with Noise encryption and Yamux multiplexing
- **Discovery:** Bootstrap peers + mDNS (LAN) + GossipSub (WAN)
- **Persistence:** OrbitDB KeyValue stores over IPFS/Helia
- **Replication:** CRDT-based automatic sync across all peers

## 3. Tokenomics

### 3.1 Supply

| Parameter | Value |
|---|---|
| **Token Name** | CDI (Collaborative Distributed Inference) |
| **Max Supply** | 21,000,000 CDI |
| **Genesis Block Reward** | 50 CDI |
| **Halving** | Dynamic, based on IPS (Inferences Per Second) |
| **Minimum Block Reward** | 1 satoshi CDI (10⁻⁸ CDI) |

### 3.2 Fee Distribution (85/15 Split)

Every inference fee is split:

| Recipient | Share | Description |
|---|---|---|
| **Inference Providers** | 85% | Nodes that perform the computation |
| **Model Uploader** | 9% | Creator who published the model (60% of 15%) |
| **Model Improvers** | 6% | Fine-tuners, LoRA creators (40% of 15%, cascading decay) |

### 3.3 Dynamic Halving (IPS-Based)

Unlike Bitcoin's time-based halving, CDI halves based on network throughput:

```
epoch_length = IPS * EPOCH_DURATION_SECONDS
reward(epoch) = genesis_reward / 2^epoch_number
```

This means: the more the network is used, the faster halving occurs. Early operators earn the most.

### 3.4 Dynamic Fee Oracle

Inference fees adjust automatically based on network congestion:

```
fee = base_fee × (1 + congestion_multiplier × utilization²)
```

Premium models (e.g., DeepSeek-R1 671B) carry fee multipliers relative to base models.

## 4. Identity & Security

### 4.1 LocalWallet

Each node generates an Ed25519 keypair on first run:

- **PeerId** = SHA-256 hash of public key (hex)
- Keypair saved to `~/.cdi/wallet.json`
- Signs all transactions with Ed25519 signatures
- No external dependencies (Node.js built-in `crypto`)

### 4.2 Zero-Knowledge Inference Proofs

Every inference produces a ZK proof via Circom/SnarkJS:

1. Node runs inference, producing activation tensors
2. Prover hashes activations → generates ZK proof
3. Verifier checks proof without seeing raw data
4. Invalid proofs → node slashed (fee withheld)

This ensures: **No node can fake inference results.**

## 5. Model Economy

### 5.1 Genesis Models

At network launch, the genesis operator registers 40+ open-weight models:
- **Llama 3.x** (1B → 405B)
- **DeepSeek R1/V3** (7B → 671B)
- **Qwen 2.5** (0.5B → 72B)
- **Mistral/Mixtral** (7B → 8x22B)
- **Gemma 3** (1B → 27B)
- **Phi 4** (3.8B → 14B)
- **StarCoder2** (3B → 15B)
- **Embedding models** (Nomic, MxBAI)

### 5.2 Royalty Mechanics

```
uploader_royalty = fee × 0.15 × 0.60 = 9% per inference
improver_royalty = fee × 0.15 × 0.40 = 6% (shared, cascading)
```

Model improvers (fine-tuners, LoRA creators) share the 6% pool with a 70% decay factor per depth level, incentivizing early contributions.

### 5.3 Model Router

The router scores each node per model:

```
score = 0.6 × (1 - load) + 0.3 × (1/latency) + 0.1 × (vram_free/48GB)
```

When all nodes serving a model exceed 90% load, the AutoBalancer triggers replication to idle nodes.

## 6. Network Operations

### 6.1 AutoBalancer

The self-balancing engine continuously monitors and produces actions:

| Action | Trigger | Effect |
|---|---|---|
| **Replicate** | Node > 80% load | Copy model to idle node |
| **Evict** | Model has 0 inferences | Free VRAM |
| **Migrate** | Node > 90% avg load | Move least-popular model |

### 6.2 Multi-Node Deployment

```yaml
# docker compose up -d
services:
  ollama:    # Shared GPU backend
  node-bootstrap:  # Seed peer
  node-2:    # Inference node
  node-3:    # Inference node
```

Each node persists identity, balances, and model catalog independently via OrbitDB.

## 7. API

### 7.1 REST Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Node status + uptime |
| GET | `/balance` | CDI balance for this node |
| GET | `/models` | Available models in the network |
| POST | `/infer` | Submit inference request |
| GET | `/result/:id` | Get inference result |
| GET | `/stats` | Comprehensive node statistics |

### 7.2 CLI

```bash
cdi start               # Start node + API
cdi submit "Hello"       # Submit inference
cdi wallet               # Show wallet address
cdi seed                 # Register genesis models
```

## 8. Roadmap

| Phase | Status | Description |
|---|---|---|
| **Core Protocol** | ✅ Done | P2P, OrbitDB, Ollama, ZK, tokenomics |
| **Reward System** | ✅ Done | 85/15 split, royalties, dynamic fees |
| **Persistence** | ✅ Done | OrbitDB stores, wallet persistence |
| **Infrastructure** | ✅ Done | Docker, API, CLI, genesis seeder |
| **Testnet Launch** | 🔶 Next | Multi-node testing, community onboarding |
| **DEX Listing** | 📋 Planned | CDI trading pairs |
| **Mainnet** | 📋 Planned | Production hardening, governance |

## 9. Conclusion

CDI Network creates the first truly decentralized AI inference economy. By combining Bitcoin's scarcity model with usage-proportional rewards, ZK verification, and perpetual royalties for model creators, CDI aligns incentives for all participants. Run a node. Upload a model. Earn CDI.

---

*CDI Network — Run AI. Earn Crypto.*

*Open source, MIT License, 2026.*
