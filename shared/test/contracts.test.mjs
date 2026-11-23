// Ortak sözleşmelerin (şemalar, parametreler, örnekler) tutarlılık testleri.
// Hem koordinatör hem simülatör bu dosyalara dayandığı için ayrı test edilir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Ajv } from "ajv";

const read = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
const ajv = new Ajv();
const dagSchema = ajv.compile(read("schemas/dag.v0.schema.json"));
const msgSchema = ajv.compile(read("schemas/messages.v0.schema.json"));

test("tüm örnek DAG'ler şemaya uyar", () => {
  for (const f of readdirSync(new URL("../examples", import.meta.url))) {
    assert.ok(dagSchema(read(`examples/${f}`)), `${f}: ${JSON.stringify(dagSchema.errors)}`);
  }
});

test("parametre dosyası beklenen alanları ve kapsam dokümanındaki değerleri taşır", () => {
  const c = read("config/default.json");
  for (const k of ["scheduler", "verifier", "heartbeatMs", "missedHeartbeats", "taskTimeoutMs", "maxReplicas", "spotCheckRate", "unitPrice"]) {
    assert.ok(k in c, `eksik: ${k}`);
  }
  assert.deepEqual(c.reputation, { tau: 0.95, alphaMin: 10, lambda: 0.99, w: 5 });
  assert.equal(c.spotCheckRate, 0.1);
  assert.equal(c.maxReplicas, 10, "ROADMAP karar kaydı 2026-11-23");
});

test("itibar test vektörleri parametre dosyasıyla aynı parametreleri kullanır", () => {
  const v = read("test/reputation-vectors.json");
  assert.deepEqual(v.params, read("config/default.json").reputation);
  const kinds = new Set(["match", "mismatch", "spot_pass", "spot_fail"]);
  assert.ok(v.cases.length > 0);
  for (const c of v.cases) {
    assert.ok(c.events.every((e) => kinds.has(e)), `${c.name}: bilinmeyen olay`);
    for (const k of ["alpha", "beta", "R", "trusted"]) assert.ok(k in c.expect, `${c.name}: eksik ${k}`);
  }
});

test("mesaj şeması: geçerli worker mesajları kabul, bozuklar ret", () => {
  assert.ok(msgSchema({ type: "hello", consent: true, deviceClass: "mobile" }));
  assert.ok(msgSchema({ type: "result", replicaId: 3, status: "ok", output: "{}", durationMs: 12.5, loadMs: 3, impl: "wasm" }));
  assert.ok(msgSchema({ type: "pong", t: 1 }));
  assert.ok(msgSchema({ type: "status", available: false }));
  assert.ok(!msgSchema({ type: "status" }), "available zorunlu");
  assert.ok(!msgSchema({ type: "hello", consent: false }), "onaysız hello reddedilmeli");
  assert.ok(!msgSchema({ type: "result", replicaId: "x", status: "ok", output: "", durationMs: 1 }));
  assert.ok(!msgSchema({ type: "assign" }), "worker assign gönderemez");
});
