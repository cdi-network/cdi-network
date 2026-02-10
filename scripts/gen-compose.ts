#!/usr/bin/env node
/**
 * gen-compose.ts — Generate docker-compose YAML for N pipeline nodes.
 *
 * Usage:
 *   npx ts-node scripts/gen-compose.ts --nodes 5 --layers 60
 *   npx ts-node scripts/gen-compose.ts --nodes 10 --layers 60 --output docker-compose.generated.yml
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
const layersPerNode = Math.ceil(totalLayers / nodeCount);

let yaml = `# Auto-generated: ${nodeCount} nodes, ${totalLayers} layers, ${layersPerNode} layers/node
version: "3.8"

networks:
  swarm-net:
    driver: bridge

services:
`;

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
    ports:
      - "${port}:9000"
    networks:
      - swarm-net
    restart: unless-stopped
`;
}

if (outputFile) {
    const fs = await import('fs');
    fs.writeFileSync(outputFile, yaml);
    console.log(`Written to ${outputFile}`);
} else {
    console.log(yaml);
}
