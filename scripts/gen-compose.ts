#!/usr/bin/env node
/**
 * gen-compose.ts — Generate docker-compose YAML for N pipeline nodes.
 *
 * Usage:
 *   node scripts/gen-compose.ts --nodes 5 --layers 60
 *   node scripts/gen-compose.ts --nodes 5 --layers 60 --mode real
 *   node scripts/gen-compose.ts --nodes 10 --layers 60 --output docker-compose.generated.yml
 *
 * Modes:
 *   simulated (default): mock compute, no OrbitDB
 *   real: Ollama sidecar + COMPUTE_MODE=ollama
 */

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const nodeCount = parseInt(getArg('nodes', '5'), 10);
const totalLayers = parseInt(getArg('layers', '60'), 10);
const outputFile = getArg('output', '');
const hmacSecret = getArg('secret', 'swarm-secret');
const mode = getArg('mode', 'simulated') as 'simulated' | 'real';
const ollamaModel = getArg('model', 'tinyllama');
const layersPerNode = Math.ceil(totalLayers / nodeCount);

let yaml = `# Auto-generated: ${nodeCount} nodes, ${totalLayers} layers, ${layersPerNode} layers/node, mode=${mode}
version: "3.8"

networks:
  swarm-net:
    driver: bridge

services:
`;

// In real mode, add Ollama sidecar
if (mode === 'real') {
  yaml += `  ollama:
    image: ollama/ollama:latest
    container_name: swarm-ollama
    volumes:
      - ollama-data:/root/.ollama
    networks:
      - swarm-net
    healthcheck:
      test: ["CMD-SHELL", "curl -f http://localhost:11434/ || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:
          memory: 4G
`;
}

// Generate node services
for (let i = 0; i < nodeCount; i++) {
  const startLayer = i * layersPerNode;
  const endLayer = Math.min((i + 1) * layersPerNode - 1, totalLayers - 1);
  const port = 9000 + i;

  yaml += `  node-${i}:
    build: .
    container_name: swarm-node-${i}
    environment:
      NODE_ID: node-${i}
      START_LAYER: "${startLayer}"
      END_LAYER: "${endLayer}"
      LISTEN_PORT: "9000"
      HMAC_SECRET: "${hmacSecret}"
      COMPUTE_MODE: "${mode === 'real' ? 'ollama' : 'simulated'}"
      REGISTRY_MODE: "none"
`;

  if (mode === 'real') {
    yaml += `      OLLAMA_HOST: "ollama"
      OLLAMA_PORT: "11434"
      OLLAMA_MODEL: "${ollamaModel}"
`;
  }

  yaml += `    ports:
      - "${port}:9000"
    networks:
      - swarm-net
    restart: unless-stopped
`;

  if (mode === 'real') {
    yaml += `    depends_on:
      ollama:
        condition: service_healthy
`;
  }
}

// Add volumes section if real mode
if (mode === 'real') {
  yaml += `
volumes:
  ollama-data:
`;
}

if (outputFile) {
  const fs = await import('fs');
  fs.writeFileSync(outputFile, yaml);
  console.log(`Written to ${outputFile} (mode=${mode}, nodes=${nodeCount}, layers=${totalLayers})`);
} else {
  console.log(yaml);
}
