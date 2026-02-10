/**
 * WS-P3a: ActivationMasker TDD Tests
 *
 * Validates additive masking for data privacy:
 * 1. Masked activations indistinguishable from random
 * 2. Mask cancels out after linear transform pipeline
 * 3. Piecewise ReLU approximation matches within tolerance
 * 4. Refuses mismatched shapes
 */
import { ActivationMasker } from '../../src/pipeline/ActivationMasker.js';

describe('WS-P3a: ActivationMasker', () => {

    test('masked activations should be indistinguishable from random', () => {
        const masker = new ActivationMasker();
        const original = new Float32Array([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]);
        const mask = masker.generateMask(original.length);
        const masked = masker.applyMask(original, mask);

        // Masked values should differ from originals
        let anyDifferent = false;
        for (let i = 0; i < original.length; i++) {
            if (Math.abs(masked[i] - original[i]) > 0.001) {
                anyDifferent = true;
                break;
            }
        }
        expect(anyDifferent).toBe(true);

        // Statistical test: correlation between masked and original should be low
        const meanOrig = original.reduce((s, v) => s + v, 0) / original.length;
        const meanMask = masked.reduce((s, v) => s + v, 0) / masked.length;
        let num = 0, den1 = 0, den2 = 0;
        for (let i = 0; i < original.length; i++) {
            const a = original[i] - meanOrig;
            const b = masked[i] - meanMask;
            num += a * b;
            den1 += a * a;
            den2 += b * b;
        }
        const correlation = den1 > 0 && den2 > 0 ? Math.abs(num / Math.sqrt(den1 * den2)) : 0;
        // With random mask, correlation should be low (probabilistically < 0.8)
        // We use a generous threshold since this is a small sample
        expect(correlation).toBeLessThan(0.95);
    });

    test('mask should cancel out after linear transform pipeline', () => {
        const masker = new ActivationMasker();
        const input = new Float32Array([1.0, 2.0, 3.0, 4.0]);

        // Weights: 2x4 matrix (2 outputs, 4 inputs)
        const weights = new Float32Array([
            1, 2, 3, 4,  // row 0
            5, 6, 7, 8,  // row 1
        ]);
        const bias = new Float32Array([0.5, 1.0]);

        // Apply linear transform directly: y = W·x + b
        const directResult = masker.linearTransform(input, weights, 2, 4, bias);

        // Apply with masking: mask → transform masked → unmask
        const mask = masker.generateMask(input.length);
        const maskedInput = masker.applyMask(input, mask);

        // Transform masked input
        const maskedResult = masker.linearTransform(maskedInput, weights, 2, 4, bias);

        // Transform mask only (to get the mask contribution)
        const maskContribution = masker.linearTransform(mask, weights, 2, 4, new Float32Array(2)); // no bias for mask

        // Unmask: maskedResult - maskContribution = directResult
        const unmaskedResult = masker.removeMask(maskedResult, maskContribution);

        for (let i = 0; i < directResult.length; i++) {
            expect(unmaskedResult[i]).toBeCloseTo(directResult[i], 3);
        }
    });

    test('piecewise ReLU approximation should match within tolerance', () => {
        const masker = new ActivationMasker();

        // Test cases: positive values should pass through, negatives → 0 (approx)
        const input = new Float32Array([-2.0, -1.0, -0.1, 0, 0.1, 1.0, 2.0]);
        const result = masker.approximateReLU(input);

        // For clearly positive values: should be close to identity
        expect(result[4]).toBeCloseTo(0.1, 1); // 0.1
        expect(result[5]).toBeCloseTo(1.0, 1); // 1.0
        expect(result[6]).toBeCloseTo(2.0, 1); // 2.0

        // For clearly negative values: should be close to 0
        expect(result[0]).toBeCloseTo(0, 0); // -2.0 → ~0
        expect(result[1]).toBeCloseTo(0, 0); // -1.0 → ~0

        // For values near 0: approximation zone, just check reasonable range
        expect(result[3]).toBeGreaterThanOrEqual(-0.1);
        expect(result[3]).toBeLessThanOrEqual(0.1);
    });

    test('should refuse to generate mask with mismatched shape', () => {
        const masker = new ActivationMasker();
        const data = new Float32Array([1, 2, 3]);
        const wrongMask = new Float32Array([1, 2]); // wrong shape

        expect(() => masker.applyMask(data, wrongMask)).toThrow(/mismatch|length|shape/i);
    });
});
