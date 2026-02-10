#!/bin/bash
# Build rapidsnark C++ prover binary for the current platform.
# Output: bin/rapidsnark
#
# Prerequisites:
#   macOS: brew install cmake gmp libsodium nasm
#   Linux: apt-get install cmake g++ libgmp-dev libsodium-dev nasm
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CLONE_DIR="/tmp/rapidsnark-build-$(date +%s)"

echo "=== Building rapidsnark C++ prover ==="

# Clone
echo "[1/3] Cloning iden3/rapidsnark..."
git clone git@github.com:iden3/rapidsnark.git "$CLONE_DIR"
cd "$CLONE_DIR"
git submodule init && git submodule update

# Build
echo "[2/3] Building (this takes ~30s)..."
mkdir -p build_prover && cd build_prover

GMP_INCLUDE=""
GMP_LIB=""
if command -v brew &>/dev/null; then
    GMP_INCLUDE="-I$(brew --prefix gmp)/include"
    GMP_LIB="-L$(brew --prefix gmp)/lib"
fi

cmake .. -DCMAKE_BUILD_TYPE=Release -DUSE_ASM=OFF \
    -DCMAKE_C_FLAGS="$GMP_INCLUDE" \
    -DCMAKE_CXX_FLAGS="$GMP_INCLUDE" \
    -DCMAKE_EXE_LINKER_FLAGS="$GMP_LIB"

make prover -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)"

# Install
echo "[3/3] Installing to $PROJECT_DIR/bin/rapidsnark"
mkdir -p "$PROJECT_DIR/bin"
cp src/prover "$PROJECT_DIR/bin/rapidsnark"
chmod +x "$PROJECT_DIR/bin/rapidsnark"

# Cleanup
rm -rf "$CLONE_DIR"

echo "=== Done! Binary: $PROJECT_DIR/bin/rapidsnark ==="
"$PROJECT_DIR/bin/rapidsnark" --help 2>&1 | head -3 || true
