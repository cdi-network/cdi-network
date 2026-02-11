/**
 * WebGPUShardExecutor + AutoregressiveGenerator — TDD tests
 *
 * WebGPUShardExecutor: Adapter that wires ShardExecutor ops to ComputeShaders WGSL
 * AutoregressiveGenerator: Token-by-token generation loop using DistributedPipeline
 */

// @ts-nocheck

import { WebGPUShardExecutor } from '../../browser/llm/WebGPUShardExecutor';
import { AutoregressiveGenerator } from '../../browser/llm/AutoregressiveGenerator';

// ── Mock factories ──

function createMockShardedEngine(layerCount = 2) {
    return {
        layerRange: [0, layerCount - 1] as [number, number],
        loadedLayerCount: layerCount,
        isReady: true,
        async forward(input: Float32Array) {
            // Simulate transformation: scale by 1.1 per layer
            const output = new Float32Array(input.length);
            for (let i = 0; i < input.length; i++) output[i] = input[i] * 1.1;
            return output;
        },
    };
}

function createMockTokenizer() {
    // Simple char-level tokenizer for testing
    const vocab = ['<pad>', '<eos>', 'h', 'e', 'l', 'o', ' ', 'w', 'r', 'd', '!'];
    return {
        encode(text: string): number[] {
            return text.split('').map(c => {
                const idx = vocab.indexOf(c);
                return idx >= 0 ? idx : 0;
            });
        },
        decode(tokens: number[]): string {
            return tokens.map(t => vocab[t] || '').join('');
        },
        vocabSize: vocab.length,
        eosToken: 1,
    };
}

function createMockDistributedPipeline(localEngine: any) {
    return {
        stageCount: 1,
        stages: [{ nodeId: 'node-1', layerRange: [0, 1] }],
        async executeStage(stageIdx: number, input: Float32Array) {
            return localEngine.forward(input);
        },
    };
}


describe('WebGPUShardExecutor', () => {

    it('initializes with CPU fallback when no WebGPU', async () => {
        const executor = new WebGPUShardExecutor();
        await executor.init();
        // In Node.js tests, WebGPU is not available
        expect(executor.isGpuAvailable).toBe(false);
        expect(executor.isInitialized).toBe(true);
        expect(executor.mode).toBe('cpu');
    });

    it('executes layerNorm on CPU fallback', async () => {
        const executor = new WebGPUShardExecutor();
        await executor.init();

        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const result = await executor.layerNorm(input);

        // Should be normalized: mean ~2.5, each value shifted
        expect(result.length).toBe(4);
        // Mean should be ~0 after normalization
        const mean = result.reduce((a, b) => a + b, 0) / result.length;
        expect(Math.abs(mean)).toBeLessThan(0.001);
    });

    it('executes matmul on CPU fallback', async () => {
        const executor = new WebGPUShardExecutor();
        await executor.init();

        // 2x2 matmul: A * B
        const A = new Float32Array([1, 2, 3, 4]);  // 2x2
        const B = new Float32Array([5, 6, 7, 8]);  // 2x2
        const result = await executor.matmul(A, B, 2, 2, 2);

        // Expected: [[1*5+2*7, 1*6+2*8], [3*5+4*7, 3*6+4*8]] = [[19,22],[43,50]]
        expect(result[0]).toBeCloseTo(19);
        expect(result[1]).toBeCloseTo(22);
        expect(result[2]).toBeCloseTo(43);
        expect(result[3]).toBeCloseTo(50);
    });

    it('executes gelu activation on CPU fallback', async () => {
        const executor = new WebGPUShardExecutor();
        await executor.init();

        const input = new Float32Array([0, 1, -1, 2]);
        const result = await executor.gelu(input);

        expect(result[0]).toBeCloseTo(0, 2);       // gelu(0) ≈ 0
        expect(result[1]).toBeCloseTo(0.841, 2);    // gelu(1) ≈ 0.841
        expect(result[2]).toBeCloseTo(-0.159, 2);   // gelu(-1) ≈ -0.159
    });

    it('executes full layer forward pass (layerNorm → attention → ffn)', async () => {
        const executor = new WebGPUShardExecutor();
        await executor.init();

        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);
        const weights = new Map<string, Uint8Array>();
        weights.set('test-weight', new Uint8Array(16));

        const result = await executor.execute(input, weights);
        expect(result.length).toBe(input.length);
    });
});


describe('AutoregressiveGenerator', () => {

    it('generates tokens one at a time', async () => {
        const engine = createMockShardedEngine();
        const tokenizer = createMockTokenizer();
        const pipeline = createMockDistributedPipeline(engine);

        const generator = new AutoregressiveGenerator({
            pipeline,
            tokenizer,
            maxTokens: 5,
        });

        const result = await generator.generate('hello');

        expect(result.tokens.length).toBeGreaterThan(0);
        expect(result.tokens.length).toBeLessThanOrEqual(5);
        expect(result.text).toBeDefined();
        expect(typeof result.text).toBe('string');
    });

    it('stops at EOS token', async () => {
        const engine = createMockShardedEngine();
        const tokenizer = createMockTokenizer();

        // Pipeline that always returns EOS logits
        const eosIdx = tokenizer.eosToken;
        const pipeline = {
            stageCount: 1,
            stages: [{ nodeId: 'node-1', layerRange: [0, 1] }],
            async executeStage(_idx: number, _input: Float32Array) {
                // Return logits where EOS has highest probability
                const logits = new Float32Array(tokenizer.vocabSize);
                logits[eosIdx] = 100.0;
                return logits;
            },
        };

        const generator = new AutoregressiveGenerator({
            pipeline,
            tokenizer,
            maxTokens: 100,
        });

        const result = await generator.generate('hello');
        // Should stop early at EOS, not reach maxTokens
        expect(result.tokens.length).toBeLessThan(100);
        expect(result.finishReason).toBe('eos');
    });

    it('stops at maxTokens limit', async () => {
        const engine = createMockShardedEngine();
        const tokenizer = createMockTokenizer();
        const pipeline = createMockDistributedPipeline(engine);

        const generator = new AutoregressiveGenerator({
            pipeline,
            tokenizer,
            maxTokens: 3,
        });

        const result = await generator.generate('hello');
        expect(result.tokens.length).toBeLessThanOrEqual(3);
        expect(result.finishReason).toBe('max_tokens');
    });

    it('calls onToken callback for streaming', async () => {
        const engine = createMockShardedEngine();
        const tokenizer = createMockTokenizer();
        const pipeline = createMockDistributedPipeline(engine);

        const streamedTokens: string[] = [];
        const generator = new AutoregressiveGenerator({
            pipeline,
            tokenizer,
            maxTokens: 3,
            onToken: (text: string) => streamedTokens.push(text),
        });

        await generator.generate('hello');
        expect(streamedTokens.length).toBeGreaterThan(0);
    });

    it('applies temperature to sampling', async () => {
        const engine = createMockShardedEngine();
        const tokenizer = createMockTokenizer();
        const pipeline = createMockDistributedPipeline(engine);

        const generator = new AutoregressiveGenerator({
            pipeline,
            tokenizer,
            maxTokens: 5,
            temperature: 0.1, // Low temp = more deterministic
        });

        const result = await generator.generate('hello');
        expect(result.tokens.length).toBeGreaterThan(0);
    });
});
