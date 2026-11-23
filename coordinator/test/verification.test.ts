/**
 * 9. hafta: koordinatörde gerçek doğrulama stratejileri, itibar, sınama işi, geriye dönük iptal ve
 * iş sonunda ödeme. Gerçek HTTP + WebSocket sunucusu, Node'daki sahte worker'lar (hata modlarıyla).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runJs } from "../../js-baseline.js";
import type { Config } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { jsOracle } from "../src/oracle.ts";
import { startFakeWorker, type FakeWorker, type FakeWorkerOptions } from "./fake-worker.ts";

const FAST: Partial<Config> = { heartbeatMs: 200, missedHeartbeats: 3, taskTimeoutMs: 10000 };
type Server = Awaited<ReturnType<typeof createServer>>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, what: string, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`zaman aşımı: ${what}`);
    await sleep(10);
  }
}

async function withSetup(cfg: Partial<Config>, workers: FakeWorkerOptions[], fn: (s: Server, ws: FakeWorker[], ids: string[]) => Promise<void>, random?: () => number) {
  const s = await createServer({ config: { ...FAST, ...cfg }, oracle: jsOracle, random });
  const ws = workers.map((o) => startFakeWorker(s.wsUrl, o));
  try {
    const ids = await Promise.all(ws.map((w) => w.id));
    await fn(s, ws, ids);
  } finally {
    ws.forEach((w) => w.close());
    await s.close();
  }
}

const independent = (n: number, prefix = "t", extra: object[] = []) => ({
  version: 0,
  tasks: [
    ...Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, module: "sha_chain", input: { seed: `${prefix}-${i}`, iterations: 50 } })),
    ...extra,
  ],
});

async function waitJob(s: Server, jobId: string, timeoutMs = 15000) {
  await waitFor(() => s.coord.getJob(jobId)!.status !== "RUNNING", `iş ${jobId}`, timeoutMs);
  return s.coord.getJob(jobId)!;
}

/** Her kabul edilen görevin çıktısı, koordinatörün çözdüğü girdiden bağımsız olarak yeniden hesaplanır. */
function assertAllCorrect(s: Server, jobId: string) {
  const rows = s.db.all("SELECT dag_task_id, module, input_resolved, accepted_output, state FROM tasks WHERE job_id = ?", jobId);
  for (const r of rows) {
    assert.equal(r.state, "ACCEPTED", `${r.dag_task_id}`);
    assert.equal(r.accepted_output, runJs(String(r.module), String(r.input_resolved)), `${r.dag_task_id} yanlış kabul edilmiş`);
  }
}

const events = (s: Server, workerId: string, kind?: string) =>
  s.db.all(`SELECT * FROM rep_events WHERE worker_id = ?${kind ? " AND kind = ?" : ""} ORDER BY id`, ...(kind ? [workerId, kind] : [workerId]));

// ---------- Sabit replikasyon ----------

test("fixed2: hileli worker'ın sonucu kabul edilmez, itibarı düşer, emeği ödenmez", () =>
  withSetup({}, [{}, {}, { fault: "random" }], async (s, _ws, [h1, h2, liar]) => {
    const jobId = s.coord.submitJob(independent(8), { verifier: "fixed2" }).jobId;
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.verifier, "fixed2");
    assertAllCorrect(s, jobId);
    const liarRows = s.db.all("SELECT paid FROM replicas WHERE worker_id = ? AND state = 'RETURNED_OK'", liar);
    assert.ok(liarRows.length > 0, "hileli worker en az bir kopya almalı");
    assert.ok(liarRows.every((r) => r.paid === 0), "yanlış kopya ödenmez");
    assert.ok(events(s, liar, "mismatch").length > 0);
    assert.equal(events(s, liar, "match").length, 0);
    for (const h of [h1, h2]) assert.equal(events(s, h, "mismatch").length, 0, "dürüst worker hiç mismatch almaz");
    const beta = Number(s.db.all("SELECT beta FROM workers WHERE id = ?", liar)[0].beta);
    assert.ok(beta > 0);
    // Ödeme iş sonunda: kabul edilen her görev için tam 2 eşleşen kopya ödendi.
    const paid = s.db.all("SELECT COUNT(*) AS n FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? AND r.paid = 1", jobId)[0].n;
    assert.equal(paid, 16);
  }));

test("fixed2: iki colluder aynı göreve denk gelince yanlış sonuç kabul edilir (beklenen zayıflık, RQ2)", () =>
  withSetup({}, [{ fault: "collude" }, { fault: "collude" }], async (s) => {
    const jobId = s.coord.submitJob(independent(2), { verifier: "fixed2" }).jobId;
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    for (const t of job.tasks) assert.equal((t.output as { wrong?: boolean }).wrong, true);
  }));

test("fixed3: üç kopyanın hepsi dönünce çoğunluk; görev başına 3 ödenen kopya", () =>
  withSetup({}, [{}, {}, {}], async (s) => {
    const jobId = s.coord.submitJob(independent(3), { verifier: "fixed3" }).jobId;
    assert.equal((await waitJob(s, jobId)).status, "COMPLETED");
    assertAllCorrect(s, jobId);
    const paid = s.db.all("SELECT COUNT(*) AS n FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? AND r.paid = 1", jobId)[0].n;
    assert.equal(paid, 9);
  }));

// ---------- Uyarlanabilir doğrulama ----------

test("adaptive: dürüst worker sınama işini geçer; sınama aynı boyutta, iş sonunda ödenir", () => {
  // İlk rastgele çağrı 0 → ilk atama sınama işi; sonrakiler 0,99 → sınama yok.
  let first = true;
  const random = () => (first ? ((first = false), 0) : 0.99);
  return withSetup({}, [{}, {}], async (s, _ws, [h1, h2]) => {
    const jobId = s.coord.submitJob(independent(1), { verifier: "adaptive" }).jobId;
    assert.equal((await waitJob(s, jobId)).status, "COMPLETED");
    assertAllCorrect(s, jobId);
    const spots = s.db.all("SELECT * FROM replicas WHERE is_spotcheck = 1");
    assert.equal(spots.length, 1);
    const spot = spots[0];
    assert.match(String(spot.task_id), /^spot\//);
    assert.equal(spot.output, spot.expected_output);
    assert.equal(spot.paid, 1, "geçilen sınama işi iş bitince ödenir");
    assert.equal(JSON.parse(String(spot.expected_output)).iterations, 50, "sınama işi gerçek görevle aynı boyutta");
    const passed = [...events(s, h1, "spot_pass"), ...events(s, h2, "spot_pass")];
    assert.equal(passed.length, 1);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM tasks WHERE id LIKE 'spot/%'")[0].n, 0, "sınama işleri tasks tablosuna girmez");
  }, random);
});

test("adaptive: güven kazanıp hileye başlayan worker sınamada yakalanır, tek kopyalı sonuçları yeniden hesaplanır", () =>
  withSetup(
    { reputation: { tau: 0.6, alphaMin: 1, lambda: 0.99, w: 5 }, spotCheckRate: 0 },
    [{ delayMs: 120 }, { delayMs: 120 }, { delayMs: 0 }],
    async (s, ws, [, , sneaky]) => {
      // 1. Herkes güvensiz başlar; 2 kopyalı görevlerle eşleşme kazanıp güvenilir olur (τ = 0,6 için tek eşleşme yeter).
      const warm = s.coord.submitJob(independent(9, "w"), { verifier: "adaptive" }).jobId;
      assert.equal((await waitJob(s, warm)).status, "COMPLETED");
      assertAllCorrect(s, warm);
      assert.ok(s.coord.listWorkers().every((w) => w.trusted), "ısınmadan sonra herkes güvenilir");

      // 2. Hızlı worker hileye başlar; güvenilir olduğu için sonuçları tek kopyayla kabul edilir.
      ws[2].setFault("random");
      const extra = [{ id: "join", module: "sha_chain", input: { seed: "join", iterations: 50 }, deps: Array.from({ length: 12 }, (_, i) => `t${i}`) }];
      const jobId = s.coord.submitJob(independent(12, "t", extra), { verifier: "adaptive" }).jobId;
      const wrongSingle = () => s.db.all(
        `SELECT COUNT(*) AS n FROM tasks t JOIN replicas r ON r.task_id = t.id
         WHERE t.job_id = ? AND t.state = 'ACCEPTED' AND r.worker_id = ? AND r.output = t.accepted_output`, jobId, sneaky)[0].n as number;
      await waitFor(() => wrongSingle() > 0, "hileli worker'ın tek kopyalı kabulü");

      // 3. Sınama işleri açılır; hileli worker'ın bir sonraki ataması sınamadır ve başarısız olur.
      s.coord.cfg.spotCheckRate = 1;
      await waitFor(() => events(s, sneaky, "spot_fail").length > 0, "spot_fail");
      s.coord.cfg.spotCheckRate = 0;

      const job = await waitJob(s, jobId);
      assert.equal(job.status, "COMPLETED");
      assertAllCorrect(s, jobId);
      assert.ok(s.coord.stats.tasksInvalidated > 0, "geriye dönük iptal tek kopyalı yanlış sonuçları geçersiz saymalı");
      const me = s.coord.listWorkers().find((w) => w.id === sneaky)!;
      assert.equal(me.flagged, true);
      assert.equal(me.trusted, false);
      const paidWrong = s.db.all(
        `SELECT COUNT(*) AS n FROM replicas r JOIN tasks t ON t.id = r.task_id
         WHERE t.job_id = ? AND r.worker_id = ? AND r.paid = 1 AND r.output <> t.accepted_output`, jobId, sneaky)[0].n;
      assert.equal(paidWrong, 0, "iptal edilen sonuçlar ödenmez");
      const log = s.db.all("SELECT event FROM log WHERE event = 'retroactive_cancel'");
      assert.ok(log.length > 0);
    },
  ));

// ---------- İş başına strateji ----------

test("iş başına strateji: HTTP sorgu parametresi; bilinmeyen strateji 400", async () => {
  const s = await createServer({ config: FAST, oracle: jsOracle });
  try {
    const post = (q: string) => fetch(`${s.url}/jobs${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(independent(1)) });
    const ok = await post("?scheduler=reputation&verifier=fixed3");
    assert.equal(ok.status, 201);
    const { jobId } = (await ok.json()) as { jobId: string };
    const job = s.coord.getJob(jobId)!;
    assert.deepEqual([job.scheduler, job.verifier], ["reputation", "fixed3"]);
    assert.deepEqual({ ...s.db.all("SELECT strategy_sched, strategy_verif FROM jobs WHERE id = ?", jobId)[0] }, { strategy_sched: "reputation", strategy_verif: "fixed3" });
    const bad = await post("?verifier=boinc_adaptive");
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /bilinmeyen doğrulayıcı/);
    // Varsayılan: shared/config
    const d = await post("");
    const dj = s.coord.getJob(((await d.json()) as { jobId: string }).jobId)!;
    assert.deepEqual([dj.scheduler, dj.verifier], [loadConfig().scheduler, loadConfig().verifier]);
  } finally {
    await s.close();
  }
});
