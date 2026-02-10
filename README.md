# CDI Network

<p align="center">
  <img src="docs/assets/logo.png" width="120" alt="CDI Network">
</p>

<h3 align="center">Collaborative Distributed Inference</h3>
<p align="center">
  The first <strong>100% browser-native</strong> decentralized AI inference network.<br>
  No downloads. No servers. Just open a tab and start earning.
</p>

<p align="center">
  <a href="https://cdi-network.github.io/cdi-network">🌐 Launch App</a> ·
  <a href="docs/WHITEPAPER.md">📄 Whitepaper</a> ·
  <a href="#how-it-works">⚡ How It Works</a> ·
  <a href="#tokenomics">💰 Tokenomics</a>
</p>

---

## What is CDI?

CDI Network is a **peer-to-peer AI inference protocol** that runs entirely in your browser:

- 🌐 **Open a tab** → your browser becomes part of the network (WebGPU + libp2p + OrbitDB)
- 🧠 **Run AI models** → inference runs on your GPU via WebGPU compute shaders
- 💰 **Earn CDI tokens** → 85% of inference fees go directly to you
- 🔐 **ZK-verified** → every inference is cryptographically proven, no trust required
- 📦 **40+ models** → LLaMA, Mistral, Qwen, DeepSeek, Gemma, Phi, and more

**No Node.js. No Docker. No CLI. Just a browser.**

## How It Works

```
┌─────────────────────────────────────────────────┐
│              Your Browser Tab                    │
│                                                  │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │  WebGPU  │  │   libp2p   │  │   OrbitDB    │ │
│  │ Compute  │  │  WebRTC P2P│  │  IPFS/Helia  │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │  Model   │  │ Reputation │  │    CDI       │ │
│  │ Catalog  │  │   System   │  │   Wallet     │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
│  ┌──────────┐  ┌────────────┐  ┌──────────────┐ │
│  │  Shard   │  │    ZKP     │  │   Token      │ │
│  │ Executor │  │  Verifier  │  │   Bridge     │ │
│  └──────────┘  └────────────┘  └──────────────┘ │
└─────────────────────────────────────────────────┘
         ↕ WebRTC          ↕ GossipSub
    ┌────────────────────────────────┐
    │    Other Browser Nodes (P2P)   │
    └────────────────────────────────┘
```

### Three Steps

| Step | Action | What Happens |
|------|--------|-------------|
| **1** | Visit [cdi-network.github.io/cdi-network](https://cdi-network.github.io/cdi-network) | App loads in your browser |
| **2** | Click "Join Network" | WebRTC connects you to peers, wallet auto-generated |
| **3** | Start earning | Your GPU serves inference via WebGPU, CDI flows to your wallet |

## Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Compute** | WebGPU + WGSL shaders | GPU-accelerated inference (matmul, layernorm, gelu, softmax) |
| **Networking** | libp2p + WebRTC + Circuit Relay | Browser-to-browser P2P, NAT traversal |
| **Storage** | Helia (IPFS) + OrbitDB | Decentralized model shards + state |
| **Security** | ZKP commitments + PoW Sybil guard | Trustless verification |
| **Crypto** | CDI token + Ed25519 wallets | Incentive layer |

## Tokenomics

| | |
|---|---|
| **Max Supply** | 21,000,000 CDI |
| **Genesis Reward** | 50 CDI/block |
| **Halving** | Dynamic (IPS-based) |
| **Fee Split** | 85% providers / 9% uploaders / 6% improvers |
| **Min Reward** | 10⁻⁸ CDI |
| **Token Bridge** | CDI ↔ ERC-20 (L2) |

See [Whitepaper](docs/WHITEPAPER.md) for full details.

## Model Catalog

40+ open-weight models available at genesis across 15+ families:

| Category | Models |
|----------|--------|
| **Chat** | LLaMA 3.1 (8B/70B), Mistral 7B, Qwen 2.5, Gemma 2 |
| **Code** | StarCoder2 15B, DeepSeek Coder V2, Qwen2.5-Coder |
| **Reasoning** | DeepSeek R1, Phi-4, Qwen QwQ |
| **Vision** | LLaVA 1.6, InternVL2 |
| **Audio** | Whisper Large V3 |
| **Medical** | Meditron 70B |
| **Math** | DeepSeek Math, Qwen2.5-Math |
| **Embeddings** | Nomic Embed, BGE Large |

## Security

- **RateLimiter** — Token-bucket per-peer, per-category (inference/gossip/relay)
- **ReputationSystem** — Tiered access (trusted → banned), epoch decay
- **SybilGuard** — PoW challenges + IP rate-limit + CDI stake
- **ProofAggregator** — ZKP pipeline commitment chain verification

## Development

```bash
git clone https://github.com/cdi-network/cdi-network.git
cd cdi-network
npm install
npm test             # 161 tests across 31 suites
```

### Test Suites

| Suite | Tests | Coverage |
|-------|-------|----------|
| P2P (libp2p, WebRTC, Relay) | 20 | ✅ |
| Storage (Helia, Ledger) | 14 | ✅ |
| Compute (WebGPU, Shaders) | 14 | ✅ |
| E2E Pipeline | 8 | ✅ |
| Sharding + Governance | 38 | ✅ |
| Testnet | 15 | ✅ |
| Model Catalog | 16 | ✅ |
| Security | 23 | ✅ |
| Mainnet | 13 | ✅ |
| **Total** | **161** | **✅** |

## License

MIT

---

<p align="center">
  <b>CDI Network</b> — AI inference, powered by your browser.<br>
  <sub>Open source. Fair launch. No VC. No presale. No downloads.</sub>
</p>
