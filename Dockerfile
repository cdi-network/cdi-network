# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc

# Runtime stage
FROM node:20-slim
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Default env vars (overridden by docker-compose)
ENV NODE_ID=node-0
ENV START_LAYER=0
ENV END_LAYER=9
ENV LISTEN_PORT=9000
ENV HMAC_SECRET=swarm-secret

EXPOSE 9000

# Health check: verify WebSocket is up
HEALTHCHECK --interval=5s --timeout=3s --retries=3 \
    CMD node -e "const ws=new (require('ws'))('ws://127.0.0.1:9000');ws.on('open',()=>{ws.close();process.exit(0)});ws.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),2000)"

CMD ["node", "dist/pipeline/PipelineNode.js"]
