// Checks the WASM build and the pure-JS baseline against the fixed vectors in Node.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import { VECTORS } from "../vectors.js";
import { runJs } from "../js-baseline.js";
import { initSync, run_task } from "../pkg/vc_tasks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
initSync({ module: readFileSync(join(root, "pkg", "vc_tasks_bg.wasm")) });

let failed = 0;
for (const v of VECTORS) {
  const wasm = run_task(v.module, v.input);
  const js = runJs(v.module, v.input);
  const ok = wasm === v.expected && js === v.expected;
  if (!ok) failed++;
  console.log(`${ok ? "OK  " : "FAIL"} ${v.module} ${v.input}`);
  if (!ok) console.log({ expected: v.expected, wasm, js });
}

// Error paths must throw, not return garbage.
assert.throws(() => run_task("nope", "{}"), /unknown module/);
assert.throws(() => run_task("sha_chain", "not json"), /invalid input/);
assert.throws(() => run_task("sha_chain", '{"seed":"a","iterations":0}'), /iterations/);
assert.throws(() => run_task("matmul", '{"seed":1,"n":513}'), /n must be/);
assert.throws(() => run_task("matmul", '{"seed":1,"n":2,"extra":1}'), /unknown field/);
assert.throws(() => runJs("matmul", '{"seed":1,"n":513}'), /n must be/);
console.log("error-path checks OK");

if (failed) {
  console.error(`${failed} vector(s) failed`);
  process.exit(1);
}
console.log(`all ${VECTORS.length} vectors match (WASM and JS)`);
