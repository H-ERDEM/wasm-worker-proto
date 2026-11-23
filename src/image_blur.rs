//! Task 3: integer image filter (3x3 box blur), no floating point.
//!
//! A w x h u8 greyscale image is drawn row-major from the mulberry32 PRNG seeded
//! with `seed` (each pixel = top byte of the next draw). The filter is applied
//! `passes` times: every output pixel is the floor of the mean of its 3x3
//! neighbourhood, with coordinates clamped at the borders (edge replication).
//! Output: SHA-256 of the final image bytes, row-major.

use crate::matmul::mulberry32;
use crate::sha_chain::hex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_SIDE: usize = 1024;
const MAX_PASSES: u32 = 16;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    seed: u32,
    w: usize,
    h: usize,
    passes: u32,
}

fn blur(src: &[u8], w: usize, h: usize) -> Vec<u8> {
    let mut dst = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut sum: u32 = 0;
            for dy in [-1i64, 0, 1] {
                let yy = (y as i64 + dy).clamp(0, h as i64 - 1) as usize;
                for dx in [-1i64, 0, 1] {
                    let xx = (x as i64 + dx).clamp(0, w as i64 - 1) as usize;
                    sum += src[yy * w + xx] as u32;
                }
            }
            dst[y * w + x] = (sum / 9) as u8;
        }
    }
    dst
}

pub fn try_run(input_json: &str) -> Result<String, String> {
    let input: Input =
        serde_json::from_str(input_json).map_err(|e| format!("invalid input: {e}"))?;
    let (w, h) = (input.w, input.h);
    if w < 1 || w > MAX_SIDE || h < 1 || h > MAX_SIDE {
        return Err(format!("w and h must be in 1..={MAX_SIDE}"));
    }
    if input.passes < 1 || input.passes > MAX_PASSES {
        return Err(format!("passes must be in 1..={MAX_PASSES}"));
    }
    let mut state = input.seed;
    let mut img: Vec<u8> = (0..w * h).map(|_| (mulberry32(&mut state) >> 24) as u8).collect();
    for _ in 0..input.passes {
        img = blur(&img, w, h);
    }
    let digest = Sha256::digest(&img);
    Ok(serde_json::json!({
        "hash": hex(&digest), "h": h, "passes": input.passes, "seed": input.seed, "w": w
    })
    .to_string())
}

pub fn run(input_json: &str) -> String {
    try_run(input_json).unwrap_or_else(|e| serde_json::json!({ "error": e }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_image_is_unchanged() {
        let img = vec![200u8; 12];
        assert_eq!(blur(&img, 4, 3), img);
    }

    #[test]
    fn single_pixel_is_its_own_mean() {
        assert_eq!(blur(&[7], 1, 1), vec![7]);
    }

    #[test]
    fn floor_of_mean_with_edge_clamp() {
        // 3x1 image [0, 9, 0]: left pixel sees (0,0,9) x3 rows = 27 -> 3,
        // middle sees (0,9,0) x3 = 27 -> 3, right same as left.
        assert_eq!(blur(&[0, 9, 0], 3, 1), vec![3, 3, 3]);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        assert!(try_run(r#"{"seed":1,"w":0,"h":4,"passes":1}"#).is_err());
        assert!(try_run(r#"{"seed":1,"w":4,"h":1025,"passes":1}"#).is_err());
        assert!(try_run(r#"{"seed":1,"w":4,"h":4,"passes":0}"#).is_err());
        assert!(try_run(r#"{"seed":1,"w":4,"h":4,"passes":17}"#).is_err());
        assert!(try_run(r#"{"seed":1,"w":4,"h":4,"passes":1,"x":0}"#).is_err());
    }

    #[test]
    fn output_keys_are_sorted() {
        let out = try_run(r#"{"seed":1,"w":2,"h":2,"passes":1}"#).unwrap();
        assert!(out.starts_with(r#"{"h":2,"hash":""#), "{out}");
        assert!(out.ends_with(r#","passes":1,"seed":1,"w":2}"#), "{out}");
    }
}
