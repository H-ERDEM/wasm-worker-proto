// Module Web Worker. Protocol:
//   main -> worker: { taskId, module, input, impl? }          impl: "wasm" (default) | "js"
//   worker -> main: { taskId, status: "ok" | "error", output, durationMs, impl, loadMs?, fatal? }
// The WASM module is loaded lazily on the first task, so a load failure is
// reported as a normal error for that task instead of killing the worker.

import { runJs } from "./js-baseline.js";

let wasmPromise = null;

function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const t0 = performance.now();
      const mod = await import("./pkg/vc_tasks.js");
      await mod.default();
      return { mod, loadMs: performance.now() - t0 };
    })();
    wasmPromise.catch(() => {
      wasmPromise = null; // allow a retry after a failed load
    });
  }
  return wasmPromise;
}

self.onmessage = async (event) => {
  const msg = event.data;
  const taskId = msg && msg.taskId;
  const impl = msg && msg.impl === "js" ? "js" : "wasm";
  try {
    if (!msg || typeof msg.module !== "string" || typeof msg.input !== "string") {
      throw new Error("bad message: expected { taskId, module: string, input: string }");
    }
    let output;
    let loadMs;
    let durationMs;
    if (impl === "wasm") {
      const wasmWasLoaded = wasmPromise !== null;
      const { mod, loadMs: lm } = await loadWasm();
      if (!wasmWasLoaded) loadMs = lm;
      const t0 = performance.now();
      output = mod.run_task(msg.module, msg.input);
      durationMs = performance.now() - t0;
    } else {
      const t0 = performance.now();
      output = runJs(msg.module, msg.input);
      durationMs = performance.now() - t0;
    }
    self.postMessage({ taskId, status: "ok", output, durationMs, impl, loadMs });
  } catch (err) {
    // A wasm panic (panic=abort) surfaces as RuntimeError and leaves the instance
    // unusable; flag it so the page recreates the worker.
    const fatal = err instanceof WebAssembly.RuntimeError;
    const message = err && err.message ? err.message : String(err);
    self.postMessage({ taskId, status: "error", output: message, durationMs: 0, impl, fatal });
  }
};

self.onerror = (e) => {
  self.postMessage({ taskId: null, status: "error", output: String(e.message || e), durationMs: 0, fatal: true });
};
