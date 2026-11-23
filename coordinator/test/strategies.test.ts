/**
 * Koordinatörün itibar modeli ve stratejileri simülatörle aynı ortak senaryoları geçer (9.2):
 * shared/test/reputation-vectors.json ve shared/test/strategy-scenarios.json.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readShared, loadConfig } from "../src/config.ts";
import { isTrusted, replicationEvents, score, update, validateParams, type RepParams } from "../src/reputation.ts";
import { schedulers, verifiers, type ReplicaState, type ReplicaView, type TaskView, type WorkerView } from "../src/strategies.ts";

type Row = [ReplicaState, string | null, boolean?];
interface Scenarios {
  on_result: { name: string; verifier: string; replicas: Row[]; expect: Record<string, unknown> }[];
  on_assign: { name: string; verifier: string; replicas: Row[]; worker: { trusted?: boolean }; u: number; expect: { extra: number; alone_ok: boolean } }[];
  pick: { name: string; scheduler: string; idle: [string, number | null, number, number][]; expect: string | null }[];
  replication_events: { name: string; accepted: string; returned: [string, string][]; expect: [string, string][] }[];
}

const S = readShared<Scenarios>("test/strategy-scenarios.json");
const V = readShared<{ params: RepParams; cases: { name: string; events: string[]; expect: { alpha: number; beta: number; R: number; trusted: boolean } }[] }>(
  "test/reputation-vectors.json",
);
const T: TaskView = { key: "j/t", module: "sha_chain", cost: 1000 };
const SIM_ONLY = new Set(["boinc_adaptive"]);

const replicas = (rows: Row[]): ReplicaView[] =>
  rows.map(([state, output, aloneOk], i) => ({ id: i + 1, taskId: "j/t", workerId: `w${i + 1}`, state, output, fatal: false, aloneOk: aloneOk ?? false }));

// ---------- İtibar ----------

test("itibar parametreleri parametre dosyasından ve ortak vektörlerle aynı", () => {
  assert.deepEqual(loadConfig().reputation, V.params);
  validateParams(V.params);
  assert.throws(() => validateParams({ ...V.params, lambda: 0 }));
  assert.throws(() => update(0, 0, "timeout", V.params));
});

for (const c of V.cases) {
  test(`itibar vektörü: ${c.name}`, () => {
    let a = 0, b = 0;
    for (const e of c.events) [a, b] = update(a, b, e, V.params);
    assert.ok(Math.abs(a - c.expect.alpha) < 1e-9, `alpha ${a} ≠ ${c.expect.alpha}`);
    assert.ok(Math.abs(b - c.expect.beta) < 1e-9, `beta ${b} ≠ ${c.expect.beta}`);
    assert.ok(Math.abs(score(a, b) - c.expect.R) < 1e-9);
    assert.equal(isTrusted(a, b, V.params), c.expect.trusted);
  });
}

// ---------- Ortak strateji senaryoları ----------

for (const sc of S.on_result.filter((s) => !SIM_ONLY.has(s.verifier))) {
  test(`onResult: ${sc.name}`, () => {
    const d = verifiers[sc.verifier].onResult(T, replicas(sc.replicas));
    const got: Record<string, unknown> = { kind: d.kind === "needMore" ? "need_more" : d.kind };
    if (d.kind === "accept") got.output = d.output;
    if (d.kind === "needMore") got.count = d.count;
    assert.deepEqual(got, sc.expect);
  });
}

for (const sc of S.on_assign.filter((s) => !SIM_ONLY.has(s.verifier))) {
  test(`onAssign: ${sc.name}`, () => {
    const w: WorkerView = { id: "w", speedEma: null, alpha: 0, beta: 0, trusted: sc.worker.trusted ?? false };
    const d = verifiers[sc.verifier].onAssign(T, replicas(sc.replicas), w, sc.u);
    assert.deepEqual({ extra: d.extra, alone_ok: d.aloneOk }, sc.expect);
  });
}

for (const sc of S.pick) {
  test(`pick: ${sc.name}`, () => {
    const idle: WorkerView[] = sc.idle.map(([id, speedEma, alpha, beta]) => ({ id, speedEma, alpha, beta, trusted: false }));
    assert.equal(schedulers[sc.scheduler].pick(T, idle)?.id ?? null, sc.expect);
  });
}

for (const sc of S.replication_events) {
  test(`replicationEvents: ${sc.name}`, () => {
    const got = replicationEvents(sc.accepted, sc.returned.map(([workerId, output]) => ({ workerId, output })));
    assert.deepEqual(got.map((e) => [e.workerId, e.kind]), sc.expect);
  });
}

test("koordinatördeki her strateji senaryolarda var", () => {
  assert.deepEqual(new Set(S.on_result.map((s) => s.verifier).filter((v) => !SIM_ONLY.has(v))), new Set(Object.keys(verifiers)));
  assert.deepEqual(new Set(S.pick.map((s) => s.scheduler)), new Set(Object.keys(schedulers)));
});
