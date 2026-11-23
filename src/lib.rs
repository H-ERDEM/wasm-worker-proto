//! Task registry exported to JavaScript.
//!
//! Every task module exposes `run(input_json: &str) -> String` (output JSON) and
//! `try_run(input_json) -> Result<String, String>`; the wasm export below
//! dispatches by module name so the coordinator only sends (module, input).

use wasm_bindgen::prelude::*;

pub mod image_blur;
pub mod matmul;
pub mod sha_chain;

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

/// Run a task. Returns the canonical output JSON, or throws a JS error string.
#[wasm_bindgen]
pub fn run_task(module: &str, input_json: &str) -> Result<String, JsError> {
    let result = match module {
        "sha_chain" => sha_chain::try_run(input_json),
        "matmul" => matmul::try_run(input_json),
        "image_blur" => image_blur::try_run(input_json),
        // Deliberate panic, used to test the worker's crash handling.
        "debug_panic" => panic!("debug_panic requested"),
        other => Err(format!("unknown module: {other}")),
    };
    result.map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn list_modules() -> Vec<String> {
    vec!["sha_chain".to_string(), "matmul".to_string(), "image_blur".to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every vector in vectors.js (produced by scripts/ref_vectors.py) must match the
    /// native build too, so the Rust code is checked even where the wasm target is unavailable.
    #[test]
    fn native_build_matches_shared_vectors() {
        let src = include_str!("../vectors.js");
        let field = |line: &str| -> String {
            let (a, b) = (line.find('"').unwrap(), line.rfind('"').unwrap());
            line[a + 1..b].replace("\\\"", "\"")
        };
        let lines: Vec<&str> = src.lines().map(str::trim).collect();
        let mut checked = 0;
        for (i, l) in lines.iter().enumerate() {
            if let Some(rest) = l.strip_prefix("module: ") {
                let module = rest.trim_matches(|c| c == '"' || c == ',');
                let input = field(lines[i + 1]);
                let expected = field(lines[i + 2]);
                let got = match module {
                    "sha_chain" => sha_chain::try_run(&input),
                    "matmul" => matmul::try_run(&input),
                    "image_blur" => image_blur::try_run(&input),
                    other => panic!("unknown module in vectors.js: {other}"),
                }
                .unwrap();
                assert_eq!(got, expected, "{module} {input}");
                checked += 1;
            }
        }
        assert_eq!(checked, 13);
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        assert!(sha_chain::try_run("{}").is_err());
        assert!(matmul::try_run(r#"{"seed":1,"n":0}"#).is_err());
    }
}
