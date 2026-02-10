/**
 * InferenceMarket — constant-product AMM for pricing inference compute.
 *
 * Liquidity pool: SWARM tokens ↔ compute units
 * Formula: x * y = k (Uniswap V2 style)
 * Fee: 0.3% on each swap
 */

const SWAP_FEE = 0.003; // 0.3%
const MIN_RESERVE = 1;   // minimum reserve to prevent draining

export interface PoolState {
    tokenReserve: number;
    computeReserve: number;
    price: number;        // tokens per compute unit
    k: number;            // constant product invariant
    totalFees: number;
    totalVolume: number;
}

export class InferenceMarket {
    private tokenReserve: number;
    private computeReserve: number;
    private k: number;
    private totalFees = 0;
    private totalVolume = 0;

    constructor(initialTokenReserve: number, initialComputeReserve: number) {
        this.tokenReserve = initialTokenReserve;
        this.computeReserve = initialComputeReserve;
        this.k = initialTokenReserve * initialComputeReserve;
    }

    /**
     * Current price: tokens per compute unit.
     */
    getPrice(): number {
        return this.tokenReserve / this.computeReserve;
    }

    /**
     * Buy compute units from the pool.
     * Returns the token cost (including fee).
     *
     * Constant-product: dx = x * dy / (y - dy)
     * With fee: user pays more tokens for the same compute.
     */
    buyCompute(computeUnits: number): number {
        if (computeUnits >= this.computeReserve) {
            throw new Error(
                `Cannot exceed reserve: requested ${computeUnits}, available ${this.computeReserve - MIN_RESERVE}`
            );
        }

        // Constant-product without fee
        const rawCost = (this.tokenReserve * computeUnits) / (this.computeReserve - computeUnits);

        // Add swap fee
        const fee = rawCost * SWAP_FEE;
        const totalCost = rawCost + fee;

        // Update reserves
        this.tokenReserve += totalCost;
        this.computeReserve -= computeUnits;
        this.totalFees += fee;
        this.totalVolume += totalCost;

        // k increases slightly due to fee (by design — LPs earn)
        this.k = this.tokenReserve * this.computeReserve;

        return totalCost;
    }

    /**
     * Sell compute units to the pool (node provides resources, gets tokens).
     * Returns the token payout.
     */
    sellCompute(computeUnits: number): number {
        // Constant-product: dx = x * dy / (y + dy)
        const rawPayout = (this.tokenReserve * computeUnits) / (this.computeReserve + computeUnits);
        const fee = rawPayout * SWAP_FEE;
        const actualPayout = rawPayout - fee;

        // Update reserves
        this.tokenReserve -= actualPayout;
        this.computeReserve += computeUnits;
        this.totalFees += fee;
        this.totalVolume += actualPayout;

        this.k = this.tokenReserve * this.computeReserve;

        return actualPayout;
    }

    /**
     * Get current pool state.
     */
    getPoolState(): PoolState {
        return {
            tokenReserve: this.tokenReserve,
            computeReserve: this.computeReserve,
            price: this.getPrice(),
            k: this.k,
            totalFees: this.totalFees,
            totalVolume: this.totalVolume,
        };
    }
}
