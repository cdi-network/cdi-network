# Build stage — use slim (glibc) consistently with runtime to avoid musl/glibc native module mismatch
FROM node:22-slim AS builder
WORKDIR /app
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Runtime stage
FROM node:22-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Core env vars (overridden by docker-compose)
ENV NODE_ID=node-0
ENV START_LAYER=0
ENV END_LAYER=9
ENV LISTEN_PORT=9000
ENV HMAC_SECRET=swarm-secret

# v2: Compute and registry modes
ENV COMPUTE_MODE=simulated
ENV REGISTRY_MODE=none

# v2: Ollama config (used when COMPUTE_MODE=ollama)
ENV OLLAMA_HOST=ollama
ENV OLLAMA_PORT=11434
ENV OLLAMA_MODEL=tinyllama
ENV OLLAMA_API_MODE=generate

# v2: OrbitDB config (used when REGISTRY_MODE=orbitdb)
ENV ORBITDB_DIR=/app/orbitdb
ENV BOOTSTRAP_PEERS=
ENV ADVERTISE_HOST=

EXPOSE 9000

# Health check: verify WebSocket is up
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
    CMD node -e "const ws=new (require('ws'))('ws://127.0.0.1:9000');ws.on('open',()=>{ws.close();process.exit(0)});ws.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)"

CMD ["node", "dist/pipeline/PipelineNode.js"]
