// WGSL Compute Shaders for CDI Network ShardExecutor
// These are loaded by ShardExecutor when WebGPU is available.

// ── MatMul (Tiled) ────────────────────────────────────────────────────
// Workgroup size: 16x16
// Computes C = A * B for matrices in GPU buffers.

const MATMUL_SHADER = `
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> c: array<f32>;
@group(0) @binding(3) var<uniform> dims: vec3<u32>; // M, N, K

const TILE_SIZE: u32 = 16;

@compute @workgroup_size(16, 16)
fn matmul(@builtin(global_invocation_id) gid: vec3<u32>) {
    let row = gid.x;
    let col = gid.y;
    let M = dims.x;
    let N = dims.y;
    let K = dims.z;

    if (row >= M || col >= N) { return; }

    var sum: f32 = 0.0;
    for (var k: u32 = 0; k < K; k = k + 1) {
        sum = sum + a[row * K + k] * b[k * N + col];
    }
    c[row * N + col] = sum;
}
`;

// ── LayerNorm ─────────────────────────────────────────────────────────
const LAYERNORM_SHADER = `
@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<uniform> dim: u32;

@compute @workgroup_size(256)
fn layernorm(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= dim) { return; }

    // Two-pass: compute mean, then normalize
    var mean: f32 = 0.0;
    for (var i: u32 = 0; i < dim; i = i + 1) {
        mean = mean + x[i];
    }
    mean = mean / f32(dim);

    var variance: f32 = 0.0;
    for (var i: u32 = 0; i < dim; i = i + 1) {
        let diff = x[i] - mean;
        variance = variance + diff * diff;
    }
    variance = variance / f32(dim);

    let std = sqrt(variance + 1e-5);
    x[idx] = (x[idx] - mean) / std;
}
`;

// ── GELU Activation ───────────────────────────────────────────────────
const GELU_SHADER = `
@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<uniform> len: u32;

@compute @workgroup_size(256)
fn gelu(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= len) { return; }

    let val = x[idx];
    let cdf = 0.5 * (1.0 + tanh(sqrt(2.0 / 3.14159265) * (val + 0.044715 * val * val * val)));
    x[idx] = val * cdf;
}
`;

// ── Softmax (Numerically stable) ──────────────────────────────────────
const SOFTMAX_SHADER = `
@group(0) @binding(0) var<storage, read_write> x: array<f32>;
@group(0) @binding(1) var<uniform> len: u32;

@compute @workgroup_size(256)
fn softmax(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    if (idx >= len) { return; }

    // Find max for numerical stability
    var max_val: f32 = x[0];
    for (var i: u32 = 1; i < len; i = i + 1) {
        max_val = max(max_val, x[i]);
    }

    // Compute exp(x - max) and sum
    var sum: f32 = 0.0;
    for (var i: u32 = 0; i < len; i = i + 1) {
        sum = sum + exp(x[i] - max_val);
    }

    x[idx] = exp(x[idx] - max_val) / sum;
}
`;

export const COMPUTE_SHADERS = {
    matmul: MATMUL_SHADER,
    layernorm: LAYERNORM_SHADER,
    gelu: GELU_SHADER,
    softmax: SOFTMAX_SHADER,
};
