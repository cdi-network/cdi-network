/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const currentEpoch: (a: bigint, b: number, c: number) => number;
export const shardReward: (a: number, b: number, c: number) => number;
export const splitFee: (a: number) => any;
export const blockReward: (a: number) => number;
export const improverRoyaltyAtDepth: (a: number, b: number) => number;
export const __wbg_cdiwallet_free: (a: number, b: number) => void;
export const cdiwallet_export_json: (a: number) => [number, number];
export const cdiwallet_fromJson: (a: number, b: number) => [number, number, number];
export const cdiwallet_new: () => number;
export const cdiwallet_peer_id: (a: number) => [number, number];
export const cdiwallet_public_key_hex: (a: number) => [number, number];
export const cdiwallet_sign: (a: number, b: number, c: number) => [number, number];
export const cdiwallet_verify: (a: number, b: number, c: number, d: number, e: number) => number;
export const cdiwallet_verifyWithKey: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
export const signTransaction: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
export const verifyTransaction: (a: number, b: number) => number;
export const init: () => void;
export const __wbindgen_exn_store: (a: number) => void;
export const __externref_table_alloc: () => number;
export const __wbindgen_externrefs: WebAssembly.Table;
export const __wbindgen_free: (a: number, b: number, c: number) => void;
export const __wbindgen_malloc: (a: number, b: number) => number;
export const __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
export const __externref_table_dealloc: (a: number) => void;
export const __wbindgen_start: () => void;
