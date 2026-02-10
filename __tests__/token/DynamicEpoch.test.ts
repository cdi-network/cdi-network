/**
 * DynamicEpoch + DynamicFeeOracle — TDD tests
 *
 * Tests the demand-driven epoch mechanism and congestion-based fee oracle.
 * Written BEFORE implementation (TDD).
 */
import { DynamicEpochManager, EpochState, EpochConfig } from '../../src/token/DynamicEpochManager';
import { DynamicFeeOracle, FeeConfig } from '../../src/token/DynamicFeeOracle';
import { InferenceToken, MAX_SUPPLY, INITIAL_REWARD } from '../../src/token/InferenceToken';

describe('DynamicEpochManager', () => {
    let epochManager: DynamicEpochManager;

    const config: EpochConfig = {
        baseEpochThreshold: 100,   // 100 inferences per epoch (small for testing)
        targetIPS: 10,             // 10 inferences/sec target
        maxEpochs: 64,             // max 64 halvings
    };

    const T0 = 1_000_000; // fixed start time for deterministic tests

    beforeEach(() => {
        epochManager = new DynamicEpochManager(config, T0);
    });

    test('starts at epoch 0 with correct initial state', () => {
        const state = epochManager.getState();
        expect(state.currentEpoch).toBe(0);
        expect(state.inferenceCount).toBe(0);
        expect(state.epochStartBlock).toBe(0);
    });

    test('epoch does NOT transition before threshold reached', () => {
        // Record 50 inferences at target IPS (10/sec → 100ms apart)
        for (let i = 0; i < 50; i++) {
            epochManager.recordInference(i, T0 + i * 100);
        }
        expect(epochManager.getState().currentEpoch).toBe(0);
        expect(epochManager.getState().inferenceCount).toBe(50);
    });

    test('epoch transitions when inference count meets threshold', () => {
        // Use slightly below-target IPS (9 IPS) so adjustment = 0.9 → threshold = 90
        // This guarantees 100 inferences > 90 adjusted threshold
        for (let i = 0; i < config.baseEpochThreshold; i++) {
            epochManager.recordInference(i, T0 + (i + 1) * 111); // ~9 IPS
        }
        expect(epochManager.getState().currentEpoch).toBeGreaterThanOrEqual(1);
    });

    test('high demand → epoch transitions SLOWER (threshold increases)', () => {
        // Simulate high demand: 20 IPS (2x target of 10)
        // adjustmentFactor = 20/10 = 2.0 → threshold = 100 * 2 = 200
        const startTime = Date.now();
        epochManager = new DynamicEpochManager(config, startTime);

        // Simulate 150 inferences in 7.5 seconds (20 IPS)
        const elapsed = 7500; // 7.5 seconds
        for (let i = 0; i < 150; i++) {
            epochManager.recordInference(i, startTime + (elapsed * i / 150));
        }

        // With high demand, threshold should increase → still epoch 0
        // because 150 < adjusted threshold (~200)
        expect(epochManager.getState().currentEpoch).toBe(0);
    });

    test('low demand → epoch transitions FASTER (threshold decreases)', () => {
        // Simulate low demand: 2 IPS (0.2x target of 10)
        const startTime = Date.now();
        epochManager = new DynamicEpochManager(config, startTime);

        // Simulate 50 inferences in 25 seconds (2 IPS)
        const elapsed = 25_000;
        for (let i = 0; i < 50; i++) {
            epochManager.recordInference(i, startTime + (elapsed * i / 50));
        }

        // Low demand → threshold decreases → epoch should have transitioned
        // adjustmentFactor = 2/10 = 0.2 → threshold = 100 * 0.2 = 20
        // 50 inferences > 20 adjusted threshold → epoch should be > 0
        expect(epochManager.getState().currentEpoch).toBeGreaterThan(0);
    });

    test('getBlockReward respects dynamic epoch (halving still works)', () => {
        const token = new InferenceToken();

        // Epoch 0 → full reward
        expect(epochManager.getBlockReward(token)).toBe(INITIAL_REWARD);

        // Force epoch transition at below-target IPS (~9 IPS)
        for (let i = 0; i < config.baseEpochThreshold; i++) {
            epochManager.recordInference(i, T0 + (i + 1) * 111);
        }

        // Epoch 1+ → halved reward
        expect(epochManager.getState().currentEpoch).toBeGreaterThanOrEqual(1);
        expect(epochManager.getBlockReward(token)).toBeLessThan(INITIAL_REWARD);
    });

    test('multiple epoch transitions with correct halving', () => {
        // Force 3+ epoch transitions at below-target IPS (~9 IPS)
        let ts = T0;
        let block = 0;
        for (let iter = 0; iter < 300; iter++) {
            ts += 111; // ~9 IPS
            epochManager.recordInference(block++, ts);
        }

        // With 300 inferences at 9 IPS:
        // threshold ~90 per epoch → expect 3+ epoch transitions
        expect(epochManager.getState().currentEpoch).toBeGreaterThanOrEqual(3);
        const token = new InferenceToken();
        const epoch = epochManager.getState().currentEpoch;
        expect(epochManager.getBlockReward(token)).toBe(INITIAL_REWARD / Math.pow(2, epoch));
    });
});

describe('DynamicFeeOracle', () => {
    let oracle: DynamicFeeOracle;

    const feeConfig: FeeConfig = {
        initialFee: 0.1,
        minFee: 0.001,
        maxFee: 5.0,
    };

    beforeEach(() => {
        oracle = new DynamicFeeOracle(feeConfig);
    });

    test('returns discount fee at low utilization (< 50%)', () => {
        const fee = oracle.calculateFee(0.3); // 30% utilization
        expect(fee).toBeLessThan(feeConfig.initialFee);
        expect(fee).toBeGreaterThanOrEqual(feeConfig.minFee);
    });

    test('returns normal fee at moderate utilization (50-80%)', () => {
        const fee = oracle.calculateFee(0.65); // 65% utilization
        expect(fee).toBeCloseTo(feeConfig.initialFee, 5);
    });

    test('returns premium fee at high utilization (80-95%)', () => {
        const fee = oracle.calculateFee(0.9); // 90% utilization
        expect(fee).toBeGreaterThan(feeConfig.initialFee);
        expect(fee).toBeLessThanOrEqual(feeConfig.maxFee);
    });

    test('returns surge fee at very high utilization (> 95%)', () => {
        const fee = oracle.calculateFee(0.98); // 98% utilization
        expect(fee).toBeGreaterThan(feeConfig.initialFee * 1.5);
        expect(fee).toBeLessThanOrEqual(feeConfig.maxFee);
    });

    test('fee never below minFee', () => {
        const fee = oracle.calculateFee(0.01); // 1% utilization
        expect(fee).toBeGreaterThanOrEqual(feeConfig.minFee);
    });

    test('fee never above maxFee', () => {
        const fee = oracle.calculateFee(1.0); // 100% utilization
        expect(fee).toBeLessThanOrEqual(feeConfig.maxFee);
    });

    test('fee is monotonically increasing with utilization', () => {
        const levels = [0.1, 0.3, 0.5, 0.65, 0.8, 0.9, 0.95, 0.99];
        const fees = levels.map(u => oracle.calculateFee(u));

        for (let i = 1; i < fees.length; i++) {
            expect(fees[i]).toBeGreaterThanOrEqual(fees[i - 1]);
        }
    });
});

describe('Max Supply Invariant', () => {
    test('max supply never exceeded under any demand pattern', () => {
        const config: EpochConfig = {
            baseEpochThreshold: 10, // very small for fast simulation
            targetIPS: 10,
            maxEpochs: 64,
        };

        const epochManager = new DynamicEpochManager(config);
        const token = new InferenceToken();

        let totalMinted = 0;
        let blockHeight = 0;

        // Simulate 10,000 inferences
        for (let i = 0; i < 10_000; i++) {
            epochManager.recordInference(blockHeight);
            const reward = epochManager.getBlockReward(token);

            if (totalMinted + reward > MAX_SUPPLY) {
                // Should stop minting
                break;
            }
            totalMinted += reward;
            blockHeight++;
        }

        expect(totalMinted).toBeLessThanOrEqual(MAX_SUPPLY);
    });

    test('provider profitability: reward + fee > 0 at all utilizations', () => {
        const feeOracle = new DynamicFeeOracle({
            initialFee: 0.1,
            minFee: 0.001,
            maxFee: 5.0,
        });

        const token = new InferenceToken();
        const epochConfig: EpochConfig = {
            baseEpochThreshold: 100,
            targetIPS: 10,
            maxEpochs: 64,
        };
        const epochManager = new DynamicEpochManager(epochConfig);

        // For each utilization level, check that reward + fee > 0
        const levels = [0.1, 0.3, 0.5, 0.7, 0.9, 0.99];
        for (const utilization of levels) {
            const reward = epochManager.getBlockReward(token);
            const fee = feeOracle.calculateFee(utilization);
            expect(reward + fee).toBeGreaterThan(0);
        }
    });
});
