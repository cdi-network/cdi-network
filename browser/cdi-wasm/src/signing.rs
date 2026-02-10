//! Transaction signing — creates signed CDI transaction envelopes.
//!
//! Every CDI operation (transfer, inference payment, shard reward) is wrapped
//! in a signed envelope that any node can verify.

use serde::{Serialize, Deserialize};
use sha2::{Sha256, Digest};
use wasm_bindgen::prelude::*;

use crate::wallet::CdiWallet;

/// A signed transaction envelope.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SignedTransaction {
    pub tx_id: String,
    pub from: String,          // peerId of sender
    pub pub_key: String,       // hex public key (for verification)
    pub to: String,            // peerId of recipient
    pub amount: f64,           // CDI amount
    pub tx_type: String,       // "transfer" | "inference_fee" | "shard_reward" | "royalty"
    pub timestamp: f64,        // Unix epoch ms
    pub signature: String,     // hex Ed25519 signature
}

/// Raw transaction data (before signing).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TransactionData {
    pub from: String,
    pub to: String,
    pub amount: f64,
    pub tx_type: String,
    pub timestamp: f64,
}

impl TransactionData {
    /// Create canonical bytes for signing (deterministic).
    pub fn signing_bytes(&self) -> Vec<u8> {
        let canonical = format!(
            "{}:{}:{}:{}:{}",
            self.from, self.to, self.amount, self.tx_type, self.timestamp as u64
        );
        canonical.into_bytes()
    }

    /// Derive transaction ID: hex(SHA-256(signing_bytes))
    pub fn tx_id(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(&self.signing_bytes());
        hex::encode(hasher.finalize())
    }
}

/// Sign a transaction (core, works on all targets).
pub fn sign_transaction_core(wallet: &CdiWallet, to: &str, amount: f64, tx_type: &str, timestamp: f64) -> String {
    let tx_data = TransactionData {
        from: wallet.get_peer_id().to_string(),
        to: to.to_string(),
        amount,
        tx_type: tx_type.to_string(),
        timestamp,
    };

    let sig = wallet.sign_data(&tx_data.signing_bytes());
    let signed = SignedTransaction {
        tx_id: tx_data.tx_id(),
        from: tx_data.from,
        pub_key: wallet.get_public_key_hex(),
        to: tx_data.to,
        amount: tx_data.amount,
        tx_type: tx_data.tx_type,
        timestamp: tx_data.timestamp,
        signature: sig,
    };

    serde_json::to_string(&signed).unwrap_or_default()
}

/// Verify a signed transaction JSON (core, works on all targets).
/// Checks: 1) signature matches pub_key, 2) peerId derives from pub_key
pub fn verify_transaction_core(signed_tx_json: &str) -> bool {
    let signed: SignedTransaction = match serde_json::from_str(signed_tx_json) {
        Ok(s) => s,
        Err(_) => return false,
    };

    // Verify peerId = sha256(pubkey)
    let pk_bytes = match hex::decode(&signed.pub_key) {
        Ok(b) => b,
        Err(_) => return false,
    };
    let mut hasher = Sha256::new();
    hasher.update(&pk_bytes);
    let expected_peer_id = hex::encode(hasher.finalize());
    if expected_peer_id != signed.from {
        return false;
    }

    let tx_data = TransactionData {
        from: signed.from,
        to: signed.to,
        amount: signed.amount,
        tx_type: signed.tx_type,
        timestamp: signed.timestamp,
    };

    CdiWallet::verify_with_public_key(&signed.pub_key, &tx_data.signing_bytes(), &signed.signature)
}

// ── WASM bindings ─────────────────────────────────────────────────────

#[wasm_bindgen(js_name = "signTransaction")]
pub fn sign_transaction(wallet: &CdiWallet, to: &str, amount: f64, tx_type: &str, timestamp: f64) -> String {
    sign_transaction_core(wallet, to, amount, tx_type, timestamp)
}

#[wasm_bindgen(js_name = "verifyTransaction")]
pub fn verify_transaction(signed_tx_json: &str) -> bool {
    verify_transaction_core(signed_tx_json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::CdiWallet;

    #[test]
    fn test_sign_and_verify_transaction() {
        let wallet = CdiWallet::generate();
        let json = sign_transaction_core(&wallet, "recipient_peer_id", 10.5, "transfer", 1700000000000.0);
        assert!(verify_transaction_core(&json));
    }

    #[test]
    fn test_tampered_transaction_fails() {
        let wallet = CdiWallet::generate();
        let json = sign_transaction_core(&wallet, "recipient", 10.0, "transfer", 1700000000000.0);
        let tampered = json.replace("10.0", "999.0");
        assert!(!verify_transaction_core(&tampered));
    }

    #[test]
    fn test_tx_id_is_deterministic() {
        let tx = TransactionData {
            from: "alice".into(),
            to: "bob".into(),
            amount: 50.0,
            tx_type: "transfer".into(),
            timestamp: 1700000000000.0,
        };
        let id1 = tx.tx_id();
        let id2 = tx.tx_id();
        assert_eq!(id1, id2);
        assert_eq!(id1.len(), 64);
    }

    #[test]
    fn test_different_tx_types() {
        let wallet = CdiWallet::generate();
        for tx_type in &["transfer", "inference_fee", "shard_reward", "royalty"] {
            let json = sign_transaction_core(&wallet, "peer", 1.0, tx_type, 1700000000000.0);
            assert!(verify_transaction_core(&json), "Failed for tx_type: {}", tx_type);
        }
    }

    #[test]
    fn test_verify_invalid_json() {
        assert!(!verify_transaction_core("not json"));
        assert!(!verify_transaction_core("{}"));
    }
}
