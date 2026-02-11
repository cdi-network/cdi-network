/**
 * AutoregressiveGenerator — Token-by-token generation loop for distributed inference.
 *
 * Uses DistributedPipeline to run forward passes through the model,
 * then samples the next token from the output logits.
 *
 * @module browser/llm/AutoregressiveGenerator
 */

interface TokenizerLike {
    encode(text: string): number[];
    decode(tokens: number[]): string;
    vocabSize: number;
    eosToken: number;
}

interface PipelineLike {
    executeStage(stageIdx: number, input: Float32Array): Promise<Float32Array | null>;
    stageCount: number;
}

interface GeneratorOpts {
    pipeline: PipelineLike;
    tokenizer: TokenizerLike;
    maxTokens?: number;
    temperature?: number;
    onToken?: (text: string) => void;
}

interface GenerateResult {
    tokens: number[];
    text: string;
    finishReason: 'eos' | 'max_tokens';
    tokensPerSecond?: number;
}

export class AutoregressiveGenerator {
    private pipeline: PipelineLike;
    private tokenizer: TokenizerLike;
    private maxTokens: number;
    private temperature: number;
    private onToken: ((text: string) => void) | null;

    constructor(opts: GeneratorOpts) {
        this.pipeline = opts.pipeline;
        this.tokenizer = opts.tokenizer;
        this.maxTokens = opts.maxTokens ?? 256;
        this.temperature = opts.temperature ?? 0.7;
        this.onToken = opts.onToken ?? null;
    }

    async generate(prompt: string): Promise<GenerateResult> {
        const inputTokens = this.tokenizer.encode(prompt);
        const generatedTokens: number[] = [];
        let finishReason: 'eos' | 'max_tokens' = 'max_tokens';

        const startTime = performance.now();

        for (let step = 0; step < this.maxTokens; step++) {
            // Build input: prompt tokens + generated tokens so far
            const allTokens = [...inputTokens, ...generatedTokens];

            // Convert token sequence to float array (embedding lookup would happen in real model)
            const input = new Float32Array(allTokens);

            // Run through all pipeline stages
            let activations: Float32Array | null = input;
            for (let s = 0; s < this.pipeline.stageCount; s++) {
                activations = await this.pipeline.executeStage(s, activations!);
                if (!activations) break; // Remote stage — async result
            }

            if (!activations) break;

            // Treat output as logits over vocabulary
            const logits = this.extractLogits(activations);

            // Sample next token
            const nextToken = this.sample(logits);

            // Check for EOS
            if (nextToken === this.tokenizer.eosToken) {
                finishReason = 'eos';
                break;
            }

            generatedTokens.push(nextToken);

            // Stream callback
            if (this.onToken) {
                const tokenText = this.tokenizer.decode([nextToken]);
                this.onToken(tokenText);
            }
        }

        const elapsed = (performance.now() - startTime) / 1000;
        const text = this.tokenizer.decode(generatedTokens);

        return {
            tokens: generatedTokens,
            text,
            finishReason,
            tokensPerSecond: generatedTokens.length > 0 ? generatedTokens.length / elapsed : 0,
        };
    }

    /**
     * Extract logits from activation output.
     * In a real model, the output head projects hidden state → vocab size.
     * Here we resize/pad to vocab size.
     */
    private extractLogits(activations: Float32Array): Float32Array {
        const vocabSize = this.tokenizer.vocabSize;
        const logits = new Float32Array(vocabSize);

        for (let i = 0; i < vocabSize; i++) {
            logits[i] = activations[i % activations.length] + (Math.random() * 0.01);
        }

        return logits;
    }

    /**
     * Sample a token from logits using temperature scaling.
     */
    private sample(logits: Float32Array): number {
        // Apply temperature
        const scaled = new Float32Array(logits.length);
        for (let i = 0; i < logits.length; i++) {
            scaled[i] = logits[i] / Math.max(this.temperature, 1e-8);
        }

        // Softmax
        let maxVal = -Infinity;
        for (let i = 0; i < scaled.length; i++) maxVal = Math.max(maxVal, scaled[i]);

        let sum = 0;
        const probs = new Float32Array(scaled.length);
        for (let i = 0; i < scaled.length; i++) {
            probs[i] = Math.exp(scaled[i] - maxVal);
            sum += probs[i];
        }
        for (let i = 0; i < probs.length; i++) probs[i] /= sum;

        // Multinomial sampling
        const r = Math.random();
        let cumSum = 0;
        for (let i = 0; i < probs.length; i++) {
            cumSum += probs[i];
            if (r < cumSum) return i;
        }

        return probs.length - 1;
    }
}
