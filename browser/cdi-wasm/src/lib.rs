pub mod wallet;
pub mod signing;
pub mod tokenomics;

use wasm_bindgen::prelude::*;

/// Initialize the WASM module (called once from JS).
#[wasm_bindgen(start)]
pub fn init() {
    // Set panic hook for better error messages in browser console
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
