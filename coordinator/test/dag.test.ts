import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, DagError, resolveRefs, taskCost, validateDag } from "../src/queue/dag.ts";
import { readShared } from "../src/config.ts";

const t = (id: string, deps: string[] = [], input: Record<string, unknown> = { seed: "x", iterations: 1 }) =>
  ({ id, module: "sha_chain", input, deps });

test("örnek DAG'ler geçerli ve topolojik sıralı", () => {
  const { order } = validateDag(readShared("examples/three-task-dag.json"));
  assert.ok(order.indexOf("t1") < order.indexOf("t2"));
  assert.equal(order.length, 3);
});

test("döngü reddedilir", () => {
  assert.throws(() => validateDag({ version: 0, tasks: [t("a", ["b"]), t("b", ["a"])] }), /döngü/);
});

test("bilinmeyen bağımlılık ve yinelenen kimlik reddedilir", () => {
  assert.throws(() => validateDag({ version: 0, tasks: [t("a", ["zz"])] }), /bilinmeyen bağımlılık/);
  assert.throws(() => validateDag({ version: 0, tasks: [t("a"), t("a")] }), /yinelenen/);
});

test("deps içinde olmayan göreve $ref reddedilir", () => {
  const dag = { version: 0, tasks: [t("a"), t("b", [], { seed: { $ref: "a.output.hash" }, iterations: 1 })] };
  assert.throws(() => validateDag(dag), DagError);
});

test("şema hatası: bilinmeyen modül, eksik alan", () => {
  assert.throws(() => validateDag({ version: 0, tasks: [{ id: "a", module: "rm_rf", input: {} }] }), /şema/);
  assert.throws(() => validateDag({ version: 1, tasks: [] }), /şema/);
});

test("maliyet fonksiyonu: sha_chain → iterations, matmul → n³", () => {
  assert.equal(taskCost(t("a", [], { seed: "x", iterations: 500 })), 500);
  assert.equal(taskCost({ id: "m", module: "matmul", input: { seed: 1, n: 128 } }), 128 ** 3);
  assert.equal(taskCost({ id: "m", module: "matmul", input: { seed: 1, n: 8 }, cost: 7 }), 7);
});

test("$ref çözümü kabul edilmiş çıktının alanını yerleştirir", () => {
  const accepted = new Map([["t1", '{"hash":"abc","iterations":1}']]);
  const out = resolveRefs({ seed: { $ref: "t1.output.hash" }, iterations: 3 }, accepted);
  assert.deepEqual(out, { seed: "abc", iterations: 3 });
  assert.throws(() => resolveRefs({ s: { $ref: "t1.output.nope" } }, accepted), /alanı yok/);
  assert.throws(() => resolveRefs({ s: { $ref: "t9.output" } }, accepted), /kabul edilmedi/);
});

test("kanonik JSON: anahtarlar sıralı, boşluksuz", () => {
  assert.equal(canonicalJson({ seed: "hello", iterations: 1000 }), '{"iterations":1000,"seed":"hello"}');
});
