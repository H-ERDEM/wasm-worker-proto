//! Task 2: integer matrix multiplication with wrapping arithmetic.
//!
//! A and B are n x n u32 matrices drawn row-major (A first, then B) from the
//! mulberry32 PRNG seeded with `seed`. C = A * B mod 2^32. Output: SHA-256 of C
//! serialised as little-endian u32, row-major.

use crate::sha_chain::hex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_N: usize = 512;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    seed: u32,
    n: usize,
}

fn mulberry32(state: &mut u32) -> u32 {
    *state = state.wrapping_add(0x6D2B_79F5);
    let mut t = *state;
    t = (t ^ (t >> 15)).wrapping_mul(t | 1);
    t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
    t ^ (t >> 14)
}

pub fn try_run(input_json: &str) -> Result<String, String> {
    let input: Input =
        serde_json::from_str(input_json).map_err(|e| format!("invalid input: {e}"))?;
    let n = input.n;
    if n < 1 || n > MAX_N {
        return Err(format!("n must be in 1..={MAX_N}"));
    }
    let mut state = input.seed;
    let a: Vec<u32> = (0..n * n).map(|_| mulberry32(&mut state)).collect();
    let b: Vec<u32> = (0..n * n).map(|_| mulberry32(&mut state)).collect();
    let mut c = vec![0u32; n * n];
    for i in 0..n {
        for k in 0..n {
            let aik = a[i * n + k];
            for j in 0..n {
                c[i * n + j] = c[i * n + j].wrapping_add(aik.wrapping_mul(b[k * n + j]));
            }
        }
    }
    let mut hasher = Sha256::new();
    for v in &c {
        hasher.update(v.to_le_bytes());
    }
    let digest = hasher.finalize();
    Ok(serde_json::json!({ "hash": hex(&digest), "n": n, "seed": input.seed }).to_string())
}

pub fn run(input_json: &str) -> String {
    try_run(input_json).unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string())
}
