// Saf JS uygulaması ortak test vektörlerini geçer (WASM derlemesi gerektirmez; test:quick'te koşar).
// WASM derlemesi ayrıca test:vectors ile, Rust yerel derlemesi cargo test ile aynı vektörlere karşı denetlenir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { VECTORS } from "../../vectors.js";
import { runJs } from "../../js-baseline.js";

test("JS uygulaması tüm vektörlerde beklenen çıktıyı verir", () => {
  for (const v of VECTORS) assert.equal(runJs(v.module, v.input), v.expected, `${v.module} ${v.input}`);
});

test("her modülün en az bir vektörü var", () => {
  const modules = new Set(VECTORS.map((v) => v.module));
  for (const m of ["sha_chain", "matmul", "image_blur"]) assert.ok(modules.has(m), m);
});
