/* tslint:disable */
/* eslint-disable */

/**
 * Browser wallet backed by Ed25519.
 */
export class CdiWallet {
    free(): void;
    [Symbol.dispose](): void;
    export_json(): string;
    static fromJson(json: string): CdiWallet;
    /**
     * Generate a new random wallet (JS constructor).
     */
    constructor();
    sign(data: Uint8Array): string;
    verify(data: Uint8Array, signature_hex: string): boolean;
    static verifyWithKey(public_key_hex: string, data: Uint8Array, signature_hex: string): boolean;
    readonly peer_id: string;
    readonly public_key_hex: string;
}

/**
 * Calculate block reward for a given epoch.
 * reward(epoch) = genesis_reward / 2^epoch
 */
export function blockReward(epoch: number): number;

/**
 * Calculate the epoch number based on total inferences processed.
 * epoch_length = ips * epoch_duration_seconds
 */
export function currentEpoch(total_inferences: bigint, ips: number, epoch_duration_secs: number): number;

/**
 * Calculate improver royalty at a given depth level.
 * royalty(depth) = improver_pool * decay^depth
 */
export function improverRoyaltyAtDepth(total_fee: number, depth: number): number;

/**
 * Initialize the WASM module (called once from JS).
 */
export function init(): void;

/**
 * Calculate reward per shard for a distributed inference.
 * Each shard gets a proportional share of the provider fee based on compute weight.
 */
export function shardReward(total_fee: number, shard_compute_weight: number, total_compute_weight: number): number;

export function signTransaction(wallet: CdiWallet, to: string, amount: number, tx_type: string, timestamp: number): string;

/**
 * Split an inference fee into provider, creator, and improver portions.
 */
export function splitFee(total_fee: number): any;

export function verifyTransaction(signed_tx_json: string): boolean;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly currentEpoch: (a: bigint, b: number, c: number) => number;
    readonly shardReward: (a: number, b: number, c: number) => number;
    readonly splitFee: (a: number) => any;
    readonly blockReward: (a: number) => number;
    readonly improverRoyaltyAtDepth: (a: number, b: number) => number;
    readonly __wbg_cdiwallet_free: (a: number, b: number) => void;
    readonly cdiwallet_export_json: (a: number) => [number, number];
    readonly cdiwallet_fromJson: (a: number, b: number) => [number, number, number];
    readonly cdiwallet_new: () => number;
    readonly cdiwallet_peer_id: (a: number) => [number, number];
    readonly cdiwallet_public_key_hex: (a: number) => [number, number];
    readonly cdiwallet_sign: (a: number, b: number, c: number) => [number, number];
    readonly cdiwallet_verify: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly cdiwallet_verifyWithKey: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly signTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly verifyTransaction: (a: number, b: number) => number;
    readonly init: () => void;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
