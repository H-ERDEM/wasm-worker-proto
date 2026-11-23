// Module Web Worker. Protocol:
//   main -> worker: { taskId, module, input, impl?, moduleHash? }   impl: "wasm" (default) | "js"
//   worker -> main: { taskId, status: "ok" | "error", output, durationMs, impl, loadMs?, fatal? }
// The WASM module is loaded lazily on the first task, so a load failure is
// reported as a normal error for that task instead of killing the worker.
// moduleHash ("sha256:<hex>" of pkg/vc_tasks_bg.wasm, sent by the coordinator) is checked
// before the first WASM task runs; the pure-JS SHA-256 is used because crypto.subtle is
// unavailable on plain-HTTP LAN pages (e.g. a phone opening http://<laptop-ip>:8787).

import { runJs, sha256, toHex } from "./js-baseline.js";

let wasmPromise = null;

function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = (async () => {
      const t0 = performance.now();
      const res = await fetch(new URL("./pkg/vc_tasks_bg.wasm", import.meta.url));
      if (!res.ok) throw new Error(`wasm fetch failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const hash = `sha256:${toHex(sha256(bytes))}`;
      const mod = await import("./pkg/vc_tasks.js");
      await mod.default({ module_or_path: bytes });
      return { mod, hash, loadMs: performance.now() - t0 };
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
      const { mod, hash, loadMs: lm } = await loadWasm();
      if (!wasmWasLoaded) loadMs = lm;
      if (msg.moduleHash && msg.moduleHash !== hash) {
        throw new Error(`module hash mismatch: expected ${msg.moduleHash}, loaded ${hash}`);
      }
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
