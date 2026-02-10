# CDI Network

<p align="center">
  <img src="docs/assets/logo.png" width="120" alt="CDI Network">
</p>

<h3 align="center">Collaborative Distributed Inference</h3>
<p align="center">
  Run AI. Earn Crypto. — The first decentralized AI inference network.
</p>

<p align="center">
  <a href="docs/WHITEPAPER.md">Whitepaper</a> ·
  <a href="docs/index.html">Website</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#tokenomics">Tokenomics</a>
</p>

---

## What is CDI?

CDI Network is a **peer-to-peer AI inference protocol** where:

- 🖥️ **GPU owners** run nodes and earn **CDI tokens** (85% of inference fees)
- 🧠 **Model creators** earn **9% royalties** on every inference, forever
- 🔐 Every inference is **ZK-verified** — no trust required
- 💰 **21M max supply**, Bitcoin-style halving based on network usage

## Quick Start

```bash
# Install
npm install -g cdi-network

# Start a node (wallet auto-generated on first run)
cdi start

# Output:
# 🔑 Wallet loaded: a4f2c8d1...
# 🚀 CDI Node started
#    API:     http://localhost:3000
#    Models:  llama3.1:8b
```

Your node auto-connects to the swarm, serves inference, and earns CDI.

### Prerequisites

- **Node.js** ≥ 18
- **Ollama** — [Install Ollama](https://ollama.com/download)
- A model pulled: `ollama pull llama3.1:8b`

### From Source

```bash
git clone https://github.com/your-org/cdi-network.git
cd cdi-network
npm install
npm run build
node dist/cli.js start
```

## API

Once running, your node exposes a REST API:

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Node status + uptime |
| `GET` | `/balance` | CDI balance |
| `GET` | `/models` | Available models |
| `POST` | `/infer` | Submit inference (`{ "prompt": "..." }`) |
| `GET` | `/result/:id` | Get result |
| `GET` | `/stats` | Full node stats |

```bash
# Submit inference
curl -X POST http://localhost:3000/infer \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing"}'

# Check balance
curl http://localhost:3000/balance
```

## Tokenomics

| | |
|---|---|
| **Max Supply** | 21,000,000 CDI |
| **Genesis Reward** | 50 CDI/block |
| **Halving** | Dynamic (IPS-based) |
| **Fee Split** | 85% providers / 9% uploaders / 6% improvers |
| **Min Reward** | 10⁻⁸ CDI |

See [Whitepaper](docs/WHITEPAPER.md) for full details.

## Multi-Node (Docker)

```bash
# Launch 3-node testnet with shared Ollama
docker compose up -d

# Node APIs:
#   http://localhost:3001 (bootstrap)
#   http://localhost:3002 (node-2)
#   http://localhost:3003 (node-3)
```

## Architecture

```
┌─────────────────────────────────────────────┐
│                 SwarmNode                    │
│  ┌──────────┐  ┌────────────┐  ┌─────────┐ │
│  │LocalWallet│  │ModelRegistry│  │  Ollama │ │
│  │ Ed25519   │  │  OrbitDB   │  │  GPU/CPU│ │
│  └──────────┘  └────────────┘  └─────────┘ │
│  ┌──────────┐  ┌────────────┐  ┌─────────┐ │
│  │ModelRouter│  │Contribution│  │  Token  │ │
│  │ Load-aware│  │  Tracker   │  │  Ledger │ │
│  └──────────┘  └────────────┘  └─────────┘ │
│  ┌──────────┐  ┌────────────┐  ┌─────────┐ │
│  │AutoBalance│  │ ZK Prover  │  │ API     │ │
│  │ r         │  │  Circom    │  │ Server  │ │
│  └──────────┘  └────────────┘  └─────────┘ │
│          ┌────────────────┐                 │
│          │  OrbitDB / P2P │                 │
│          │ libp2p + IPFS  │                 │
│          └────────────────┘                 │
└─────────────────────────────────────────────┘
```

## Genesis Model Seeder

At launch, the founder registers 40+ open-weight models:

```bash
npx ts-node src/scripts/seed-models.ts

# Seeds: Llama 3.x, DeepSeek R1/V3, Qwen 2.5, Mistral,
#         Gemma 3, Phi 4, StarCoder2, embedding models...
```

The genesis uploader earns 9% royalties on every inference, forever.

## CLI Commands

```bash
cdi start [--config config.json]   # Start node + API
cdi submit "prompt" [--model m]    # Submit inference
cdi wallet                         # Show wallet info
cdi seed                           # Seed genesis models
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_HOST` | `127.0.0.1` | Ollama server host |
| `OLLAMA_PORT` | `11434` | Ollama server port |
| `ORBITDB_DIR` | `./orbitdb` | OrbitDB data directory |
| `WALLET_DIR` | `~/.cdi` | Wallet storage path |
| `API_PORT` | `3000` | REST API port |
| `LISTEN_PORT` | `0` (random) | P2P listen port |
| `BOOTSTRAP_PEERS` | (none) | Comma-separated multiaddrs |
| `MODELS` | `tinyllama` | Comma-separated model names |
| `LOG_LEVEL` | `info` | debug/info/warn/error |

## Development

```bash
npm install          # Install all dependencies
npm test             # Run 206 tests
npm run build        # Compile TypeScript
```

## License

MIT

---

<p align="center">
  <b>CDI Network</b> — Run AI. Earn Crypto.<br>
  <sub>Open source. Fair launch. No VC. No presale.</sub>
</p>
