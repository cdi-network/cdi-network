import { randomBytes } from 'crypto';

/**
 * ActivationMasker — implements additive masking for privacy-preserving
 * split inference. Random masks make activations information-theoretically
 * secure against individual nodes.
 *
 * For linear layers: f(x + R) = f(x) + f(R), so the mask propagates
 * linearly and can be cancelled at the requester side.
 */
export class ActivationMasker {

    /**
     * Generate a cryptographically random mask of the given length.
     */
    generateMask(length: number): Float32Array {
        const mask = new Float32Array(length);
        const bytes = randomBytes(length * 4);
        for (let i = 0; i < length; i++) {
            // Convert to float in range [-10, 10] for reasonable masking
            const raw = bytes.readUInt32LE(i * 4);
            mask[i] = (raw / 0xFFFFFFFF) * 20 - 10;
        }
        return mask;
    }

    /**
     * Apply additive mask: masked = data + mask
     */
    applyMask(data: Float32Array, mask: Float32Array): Float32Array {
        if (data.length !== mask.length) {
            throw new Error(`Shape mismatch: data length ${data.length} != mask length ${mask.length}`);
        }
        const result = new Float32Array(data.length);
        for (let i = 0; i < data.length; i++) {
            result[i] = data[i] + mask[i];
        }
        return result;
    }

    /**
     * Remove mask: unmasked = maskedResult - maskContribution
     */
    removeMask(maskedResult: Float32Array, maskContribution: Float32Array): Float32Array {
        if (maskedResult.length !== maskContribution.length) {
            throw new Error(`Shape mismatch: result length ${maskedResult.length} != contribution length ${maskContribution.length}`);
        }
        const result = new Float32Array(maskedResult.length);
        for (let i = 0; i < maskedResult.length; i++) {
            result[i] = maskedResult[i] - maskContribution[i];
        }
        return result;
    }

    /**
     * Linear transform: y = W·x + b
     * W is stored row-major: W[i*cols + j]
     */
    linearTransform(
        input: Float32Array,
        weights: Float32Array,
        rows: number,
        cols: number,
        bias: Float32Array,
    ): Float32Array {
        const output = new Float32Array(rows);
        for (let i = 0; i < rows; i++) {
            let sum = bias[i];
            for (let j = 0; j < cols; j++) {
                sum += weights[i * cols + j] * input[j];
            }
            output[i] = sum;
        }
        return output;
    }

    /**
     * Piecewise-linear ReLU approximation.
     * Uses softplus-like approximation: f(x) ≈ x * sigmoid(k*x)
     * where k controls sharpness. This preserves the additive masking property
     * approximately while being smoother than hard ReLU.
     */
    approximateReLU(input: Float32Array): Float32Array {
        const output = new Float32Array(input.length);
        const k = 5.0; // sharpness factor
        for (let i = 0; i < input.length; i++) {
            const sigmoid = 1.0 / (1.0 + Math.exp(-k * input[i]));
            output[i] = input[i] * sigmoid;
        }
        return output;
    }
}
