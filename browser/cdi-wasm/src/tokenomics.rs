//! CDI Tokenomics — fee calculation, reward splits, halving schedule.
//!
//! Mirrors the Node.js TokenLedger logic but runs in WASM for browser nodes.
//! All constants match the whitepaper exactly.

use wasm_bindgen::prelude::*;

// ── Constants (match whitepaper) ──────────────────────────────────────
pub const MAX_SUPPLY: f64 = 21_000_000.0;
pub const GENESIS_BLOCK_REWARD: f64 = 50.0;
pub const PROVIDER_SHARE: f64 = 0.85;
pub const CREATOR_SHARE: f64 = 0.09;  // 60% of 15%
pub const IMPROVER_SHARE: f64 = 0.06; // 40% of 15%
pub const IMPROVER_DECAY: f64 = 0.70; // 70% decay per depth level

// ── Fee Split ─────────────────────────────────────────────────────────

/// Split an inference fee into provider, creator, and improver portions.
#[wasm_bindgen(js_name = "splitFee")]
pub fn split_fee(total_fee: f64) -> JsValue {
    let provider = total_fee * PROVIDER_SHARE;
    let creator = total_fee * CREATOR_SHARE;
    let improver = total_fee * IMPROVER_SHARE;

    // Return as JS object
    let obj = js_sys::Object::new();
    js_sys::Reflect::set(&obj, &"provider".into(), &JsValue::from_f64(provider)).ok();
    js_sys::Reflect::set(&obj, &"creator".into(), &JsValue::from_f64(creator)).ok();
    js_sys::Reflect::set(&obj, &"improver".into(), &JsValue::from_f64(improver)).ok();
    js_sys::Reflect::set(&obj, &"total".into(), &JsValue::from_f64(total_fee)).ok();
    obj.into()
}

// ── Shard Reward Calculation ──────────────────────────────────────────

/// Calculate reward per shard for a distributed inference.
/// Each shard gets a proportional share of the provider fee based on compute weight.
#[wasm_bindgen(js_name = "shardReward")]
pub fn shard_reward(total_fee: f64, shard_compute_weight: f64, total_compute_weight: f64) -> f64 {
    if total_compute_weight <= 0.0 {
        return 0.0;
    }
    let provider_pool = total_fee * PROVIDER_SHARE;
    provider_pool * (shard_compute_weight / total_compute_weight)
}

// ── Halving Schedule ──────────────────────────────────────────────────

/// Calculate block reward for a given epoch.
/// reward(epoch) = genesis_reward / 2^epoch
#[wasm_bindgen(js_name = "blockReward")]
pub fn block_reward(epoch: u32) -> f64 {
    let reward = GENESIS_BLOCK_REWARD / (2.0_f64.powi(epoch as i32));
    if reward < 1e-8 { 1e-8 } else { reward }  // minimum 1 satoshi CDI
}

/// Calculate the epoch number based on total inferences processed.
/// epoch_length = ips * epoch_duration_seconds
#[wasm_bindgen(js_name = "currentEpoch")]
pub fn current_epoch(total_inferences: u64, ips: f64, epoch_duration_secs: f64) -> u32 {
    if ips <= 0.0 || epoch_duration_secs <= 0.0 {
        return 0;
    }
    let epoch_length = (ips * epoch_duration_secs) as u64;
    if epoch_length == 0 { return 0; }
    (total_inferences / epoch_length) as u32
}

// ── Improver Royalty Cascade ──────────────────────────────────────────

/// Calculate improver royalty at a given depth level.
/// royalty(depth) = improver_pool * decay^depth
#[wasm_bindgen(js_name = "improverRoyaltyAtDepth")]
pub fn improver_royalty_at_depth(total_fee: f64, depth: u32) -> f64 {
    let improver_pool = total_fee * IMPROVER_SHARE;
    improver_pool * IMPROVER_DECAY.powi(depth as i32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fee_split_sums_to_total() {
        let fee = 100.0;
        let provider = fee * PROVIDER_SHARE;
        let creator = fee * CREATOR_SHARE;
        let improver = fee * IMPROVER_SHARE;
        let sum = provider + creator + improver;
        assert!((sum - fee).abs() < 1e-10, "fee split doesn't sum: {}", sum);
    }

    #[test]
    fn test_fee_split_ratios() {
        let fee = 100.0;
        assert!((fee * PROVIDER_SHARE - 85.0).abs() < 1e-10);
        assert!((fee * CREATOR_SHARE - 9.0).abs() < 1e-10);
        assert!((fee * IMPROVER_SHARE - 6.0).abs() < 1e-10);
    }

    #[test]
    fn test_shard_reward_proportional() {
        // 2 shards with equal weight → each gets half the provider pool
        let fee = 100.0;
        let r = shard_reward(fee, 1.0, 2.0);
        let expected = 85.0 / 2.0;
        assert!((r - expected).abs() < 1e-10);
    }

    #[test]
    fn test_shard_reward_zero_weight() {
        assert_eq!(shard_reward(100.0, 1.0, 0.0), 0.0);
    }

    #[test]
    fn test_block_reward_halving() {
        assert!((block_reward(0) - 50.0).abs() < 1e-10);
        assert!((block_reward(1) - 25.0).abs() < 1e-10);
        assert!((block_reward(2) - 12.5).abs() < 1e-10);
        assert!((block_reward(10) - 50.0 / 1024.0).abs() < 1e-10);
    }

    #[test]
    fn test_block_reward_minimum() {
        // After many halvings, reward floors at 1e-8
        let r = block_reward(100);
        assert_eq!(r, 1e-8);
    }

    #[test]
    fn test_current_epoch() {
        // 1000 inferences, 10 IPS, 10s epoch → epoch_length=100, epoch=10
        assert_eq!(current_epoch(1000, 10.0, 10.0), 10);
        assert_eq!(current_epoch(0, 10.0, 10.0), 0);
        assert_eq!(current_epoch(99, 10.0, 10.0), 0);
        assert_eq!(current_epoch(100, 10.0, 10.0), 1);
    }

    #[test]
    fn test_improver_royalty_decay() {
        let fee = 100.0;
        let d0 = improver_royalty_at_depth(fee, 0);
        let d1 = improver_royalty_at_depth(fee, 1);
        let d2 = improver_royalty_at_depth(fee, 2);

        assert!((d0 - 6.0).abs() < 1e-10);           // 6% at depth 0
        assert!((d1 - 6.0 * 0.7).abs() < 1e-10);     // 4.2% at depth 1
        assert!((d2 - 6.0 * 0.49).abs() < 1e-10);    // 2.94% at depth 2
    }

    #[test]
    fn test_max_supply_constant() {
        assert_eq!(MAX_SUPPLY, 21_000_000.0);
    }
}
