//! Task registry exported to JavaScript.
//!
//! Every task module exposes `run(input_json: &str) -> String` (output JSON) and
//! `try_run(input_json) -> Result<String, String>`; the wasm export below
//! dispatches by module name so the coordinator only sends (module, input).

use wasm_bindgen::prelude::*;

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
        // Deliberate panic, used to test the worker's crash handling.
        "debug_panic" => panic!("debug_panic requested"),
        other => Err(format!("unknown module: {other}")),
    };
    result.map_err(|e| JsError::new(&e))
}

#[wasm_bindgen]
pub fn list_modules() -> Vec<String> {
    vec!["sha_chain".to_string(), "matmul".to_string()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_inputs_are_rejected() {
        assert!(sha_chain::try_run("{}").is_err());
        assert!(matmul::try_run(r#"{"seed":1,"n":0}"#).is_err());
    }
}
