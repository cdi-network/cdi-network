//! CDI Wallet — Ed25519 keypair management for browser nodes.
//!
//! Compatible with the Node.js `LocalWallet` (same Ed25519 curve, same peerId derivation).
//! PeerId = hex(SHA-256(raw_public_key_32_bytes))

use ed25519_dalek::{SigningKey, VerifyingKey, Signer, Verifier, Signature};
use sha2::{Sha256, Digest};
use rand::rngs::OsRng;
use serde::{Serialize, Deserialize};
use wasm_bindgen::prelude::*;

/// Serializable wallet data for localStorage persistence.
#[derive(Serialize, Deserialize, Clone)]
pub struct WalletData {
    pub public_key: String,  // hex
    pub private_key: String, // hex
    pub peer_id: String,     // hex(sha256(pubkey))
}

/// Browser wallet backed by Ed25519.
#[wasm_bindgen]
pub struct CdiWallet {
    signing_key: SigningKey,
    verifying_key: VerifyingKey,
    peer_id: String,
}

// ── Core logic (works on all targets) ─────────────────────────────────

impl CdiWallet {
    /// Generate a new random wallet (core implementation).
    pub fn generate() -> CdiWallet {
        let signing_key = SigningKey::generate(&mut OsRng);
        let verifying_key = signing_key.verifying_key();
        let peer_id = Self::derive_peer_id(&verifying_key);
        CdiWallet { signing_key, verifying_key, peer_id }
    }

    /// Get peer ID.
    pub fn get_peer_id(&self) -> &str {
        &self.peer_id
    }

    /// Get public key as hex.
    pub fn get_public_key_hex(&self) -> String {
        hex::encode(self.verifying_key.as_bytes())
    }

    /// Sign data, return hex signature.
    pub fn sign_data(&self, data: &[u8]) -> String {
        let sig = self.signing_key.sign(data);
        hex::encode(sig.to_bytes())
    }

    /// Verify signature against this wallet's public key.
    pub fn verify_data(&self, data: &[u8], signature_hex: &str) -> bool {
        Self::verify_with_public_key(&self.get_public_key_hex(), data, signature_hex)
    }

    /// Verify a signature against an arbitrary public key.
    pub fn verify_with_public_key(public_key_hex: &str, data: &[u8], signature_hex: &str) -> bool {
        let pk_bytes = match hex::decode(public_key_hex) {
            Ok(b) => b,
            Err(_) => return false,
        };
        if pk_bytes.len() != 32 { return false; }
        let pk = match VerifyingKey::from_bytes(&pk_bytes.try_into().unwrap()) {
            Ok(k) => k,
            Err(_) => return false,
        };
        let sig_bytes = match hex::decode(signature_hex) {
            Ok(b) => b,
            Err(_) => return false,
        };
        let sig = match Signature::from_slice(&sig_bytes) {
            Ok(s) => s,
            Err(_) => return false,
        };
        pk.verify(data, &sig).is_ok()
    }

    /// Export wallet as JSON string.
    pub fn to_json(&self) -> String {
        let data = WalletData {
            public_key: hex::encode(self.verifying_key.as_bytes()),
            private_key: hex::encode(self.signing_key.to_bytes()),
            peer_id: self.peer_id.clone(),
        };
        serde_json::to_string(&data).unwrap_or_default()
    }

    /// Import wallet from JSON string.
    pub fn from_json_str(json: &str) -> Result<CdiWallet, String> {
        let data: WalletData = serde_json::from_str(json)
            .map_err(|e| format!("Invalid wallet JSON: {}", e))?;

        let priv_bytes = hex::decode(&data.private_key)
            .map_err(|_| "Invalid private key hex".to_string())?;

        let key_array: [u8; 32] = priv_bytes.try_into()
            .map_err(|_| "Private key must be 32 bytes".to_string())?;

        let signing_key = SigningKey::from_bytes(&key_array);
        let verifying_key = signing_key.verifying_key();
        let peer_id = Self::derive_peer_id(&verifying_key);

        Ok(CdiWallet { signing_key, verifying_key, peer_id })
    }

    /// Derive peerId: hex(SHA-256(raw_pubkey_32bytes))
    fn derive_peer_id(vk: &VerifyingKey) -> String {
        let mut hasher = Sha256::new();
        hasher.update(vk.as_bytes());
        hex::encode(hasher.finalize())
    }
}

// ── WASM-specific bindings (only compiled for wasm32) ─────────────────

#[wasm_bindgen]
impl CdiWallet {
    /// Generate a new random wallet (JS constructor).
    #[wasm_bindgen(constructor)]
    pub fn new() -> CdiWallet {
        Self::generate()
    }

    #[wasm_bindgen(getter)]
    pub fn peer_id(&self) -> String {
        self.peer_id.clone()
    }

    #[wasm_bindgen(getter)]
    pub fn public_key_hex(&self) -> String {
        self.get_public_key_hex()
    }

    pub fn sign(&self, data: &[u8]) -> String {
        self.sign_data(data)
    }

    pub fn verify(&self, data: &[u8], signature_hex: &str) -> bool {
        self.verify_data(data, signature_hex)
    }

    #[wasm_bindgen(js_name = "verifyWithKey")]
    pub fn verify_with_key(public_key_hex: &str, data: &[u8], signature_hex: &str) -> bool {
        Self::verify_with_public_key(public_key_hex, data, signature_hex)
    }

    pub fn export_json(&self) -> String {
        self.to_json()
    }

    #[wasm_bindgen(js_name = "fromJson")]
    pub fn from_json(json: &str) -> Result<CdiWallet, JsValue> {
        Self::from_json_str(json).map_err(|e| JsValue::from_str(&e))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_wallet() {
        let w = CdiWallet::generate();
        assert_eq!(w.get_peer_id().len(), 64);
        assert_eq!(w.get_public_key_hex().len(), 64);
    }

    #[test]
    fn test_two_wallets_differ() {
        let w1 = CdiWallet::generate();
        let w2 = CdiWallet::generate();
        assert_ne!(w1.get_peer_id(), w2.get_peer_id());
    }

    #[test]
    fn test_sign_verify_roundtrip() {
        let w = CdiWallet::generate();
        let msg = b"hello CDI network";
        let sig = w.sign_data(msg);
        assert!(w.verify_data(msg, &sig));
    }

    #[test]
    fn test_verify_wrong_data_fails() {
        let w = CdiWallet::generate();
        let sig = w.sign_data(b"correct data");
        assert!(!w.verify_data(b"wrong data", &sig));
    }

    #[test]
    fn test_verify_with_public_key_static() {
        let w = CdiWallet::generate();
        let msg = b"cross-verify test";
        let sig = w.sign_data(msg);
        let pk = w.get_public_key_hex();
        assert!(CdiWallet::verify_with_public_key(&pk, msg, &sig));
    }

    #[test]
    fn test_export_import_roundtrip() {
        let w1 = CdiWallet::generate();
        let json = w1.to_json();
        let w2 = CdiWallet::from_json_str(&json).expect("import failed");
        assert_eq!(w1.get_peer_id(), w2.get_peer_id());
        assert_eq!(w1.get_public_key_hex(), w2.get_public_key_hex());

        let msg = b"persistence test";
        let sig = w1.sign_data(msg);
        assert!(w2.verify_data(msg, &sig));
    }

    #[test]
    fn test_import_invalid_json_fails() {
        let result = CdiWallet::from_json_str("not json");
        assert!(result.is_err());
    }

    #[test]
    fn test_verify_invalid_signature_hex() {
        let w = CdiWallet::generate();
        assert!(!w.verify_data(b"data", "not-hex"));
        assert!(!w.verify_data(b"data", "abcd"));
    }

    #[test]
    fn test_peer_id_is_sha256_of_pubkey() {
        let w = CdiWallet::generate();
        let pk_bytes = hex::decode(w.get_public_key_hex()).unwrap();
        let mut hasher = Sha256::new();
        hasher.update(&pk_bytes);
        let expected = hex::encode(hasher.finalize());
        assert_eq!(w.get_peer_id(), expected);
    }
}
