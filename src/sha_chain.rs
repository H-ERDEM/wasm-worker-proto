//! Task 1: SHA-256 hash chain.
//!
//! h0 = SHA-256(UTF-8(seed)); h_i = SHA-256(h_{i-1}) for i in 1..iterations.
//! Output: hex of the final 32-byte digest. Integer/byte operations only.

use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_ITERATIONS: u64 = 100_000_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    seed: String,
    iterations: u64,
}

pub fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

pub fn try_run(input_json: &str) -> Result<String, String> {
    let input: Input =
        serde_json::from_str(input_json).map_err(|e| format!("invalid input: {e}"))?;
    if input.iterations < 1 || input.iterations > MAX_ITERATIONS {
        return Err(format!("iterations must be in 1..={MAX_ITERATIONS}"));
    }
    let mut h: [u8; 32] = Sha256::digest(input.seed.as_bytes()).into();
    for _ in 1..input.iterations {
        h = Sha256::digest(h).into();
    }
    // serde_json maps are key-sorted, so the output string is canonical.
    Ok(serde_json::json!({ "hash": hex(&h), "iterations": input.iterations }).to_string())
}

pub fn run(input_json: &str) -> String {
    try_run(input_json).unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string())
}
