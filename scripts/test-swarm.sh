#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/test-swarm.sh [LEVEL]
#   L1 = 2 nodes (smoke)
#   L2 = 5 nodes (discovery)
#   L3 = 10 nodes (economy)
#   L4 = 20 nodes (scale)

LEVEL="${1:-L1}"
TOTAL_LAYERS=60
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${PROJECT_DIR}/docker-compose.generated.yml"

case "$LEVEL" in
    L1) NODES=2;;
    L2) NODES=5;;
    L3) NODES=10;;
    L4) NODES=20;;
    *)  echo "Unknown level: $LEVEL (use L1, L2, L3, L4)"; exit 1;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Swarm Test: Level $LEVEL ($NODES nodes)"
echo "  Layers: $TOTAL_LAYERS total"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. Build Docker image
echo "[1/5] Building Docker image..."
docker build -t swarm-node "$PROJECT_DIR" --quiet

# 2. Generate docker-compose
echo "[2/5] Generating docker-compose for $NODES nodes..."
cd "$PROJECT_DIR"
npx ts-node scripts/gen-compose.ts --nodes "$NODES" --layers "$TOTAL_LAYERS" --output "$COMPOSE_FILE"

# 3. Start containers
echo "[3/5] Starting $NODES containers..."
docker compose -f "$COMPOSE_FILE" up -d --build --remove-orphans

# 4. Wait for health checks
echo "[4/5] Waiting for nodes to become healthy..."
sleep 3
for i in $(seq 0 $((NODES - 1))); do
    PORT=$((9000 + i))
    RETRIES=0
    while ! nc -z 127.0.0.1 "$PORT" 2>/dev/null; do
        RETRIES=$((RETRIES + 1))
        if [ $RETRIES -gt 15 ]; then
            echo "FAIL: node-$i on port $PORT not reachable after 15 retries"
            docker compose -f "$COMPOSE_FILE" logs "node-$i"
            docker compose -f "$COMPOSE_FILE" down
            exit 1
        fi
        sleep 1
    done
    echo "  ✓ node-$i on port $PORT"
done

# 5. Run test script
echo "[5/5] Running L${LEVEL} test..."
SCRIPT="scripts/test-${LEVEL,,}-*.ts"
# shellcheck disable=SC2086
FOUND=$(ls $SCRIPT 2>/dev/null || echo "")
if [ -n "$FOUND" ]; then
    npx ts-node "$FOUND"
    RESULT=$?
else
    echo "No test script found for $LEVEL (expected $SCRIPT)"
    RESULT=0
fi

# Cleanup
echo ""
echo "Tearing down containers..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans

echo ""
if [ $RESULT -eq 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ✅ Level $LEVEL PASSED ($NODES nodes)"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
else
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  ❌ Level $LEVEL FAILED"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    exit 1
fi
