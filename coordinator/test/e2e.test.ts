/**
 * Uçtan uca testler (Hafta 6–7 raporu §2.3.5). Gerçek HTTP + WebSocket sunucusu, Node sahte worker'ları.
 * Tarayıcıyla yapılan aynı testler 3. aşamada Playwright ile eklenecek.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "../src/server.ts";
import type { Config } from "../src/config.ts";
import { readShared } from "../src/config.ts";
import WebSocket from "ws";
import { startFakeWorker, type FakeWorker } from "./fake-worker.ts";

const FAST: Partial<Config> = { heartbeatMs: 100, missedHeartbeats: 2, taskTimeoutMs: 5000 };

// README test vektörleri
const HELLO_1 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_1000 = "f6eec10c841b542f37ffb4ca00f82c5b6b4b11b79636d20201078b667ac37159";
const MATMUL_42_64 = "21bfb70784701c76d11da1401dec6eb95c570e074e7a831c5ac69a56514433cb";

type Server = Awaited<ReturnType<typeof createServer>>;

async function withServer(cfg: Partial<Config>, fn: (s: Server) => Promise<void>) {
  const s = await createServer({ config: cfg });
  const workers: FakeWorker[] = [];
  try {
    await fn(s);
  } finally {
    workers.forEach((w) => w.close());
    await s.close();
  }
}

async function submit(s: Server, dag: unknown): Promise<string> {
  const res = await fetch(`${s.url}/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(dag) });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { jobId: string }).jobId;
}

async function waitJob(s: Server, jobId: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const job = (await (await fetch(`${s.url}/jobs/${jobId}`)).json()) as {
      status: string; tasks: { id: string; state: string; output: { hash: string } | null; replicas: number }[];
    };
    if (job.status !== "RUNNING") return job;
    if (Date.now() > end) throw new Error(`iş zamanında bitmedi: ${JSON.stringify(job)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const replicaRows = (s: Server, jobId: string) =>
  s.db.all("SELECT r.* FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? ORDER BY r.id", jobId);

test("1 worker, tek sha_chain görevi → README vektörü, replicas satırı süreyle", () =>
  withServer(FAST, async (s) => {
    const w = startFakeWorker(s.wsUrl);
    await w.id;
    const jobId = await submit(s, readShared("examples/single-task.json"));
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.tasks[0].output!.hash, HELLO_1000);
    const rows = replicaRows(s, jobId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "RETURNED_OK");
    assert.ok((rows[0].duration_ms as number) > 0);
    assert.equal(rows[0].paid, 1);
    w.close();
  }));

test("2 worker, $ref içeren 3 görevli DAG: çocuk ancak ebeveyn kabul edilince başlar", () =>
  withServer(FAST, async (s) => {
    const a = startFakeWorker(s.wsUrl), b = startFakeWorker(s.wsUrl);
    await Promise.all([a.id, b.id]);
    const jobId = await submit(s, readShared("examples/three-task-dag.json"));
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    const out = Object.fromEntries(job.tasks.map((t) => [t.id, t.output!.hash]));
    assert.equal(out.t1, HELLO_1);
    assert.equal(out.t2, createHash("sha256").update(HELLO_1, "utf8").digest("hex"));
    assert.equal(out.t3, MATMUL_42_64);

    const [t1] = s.db.all("SELECT accepted_at FROM tasks WHERE id = ?", `${jobId}/t1`);
    const [t2] = s.db.all("SELECT input_resolved, ready_at FROM tasks WHERE id = ?", `${jobId}/t2`);
    const [r2] = s.db.all("SELECT assigned_at FROM replicas WHERE task_id = ?", `${jobId}/t2`);
    assert.ok((t2.ready_at as number) >= (t1.accepted_at as number));
    assert.ok((r2.assigned_at as number) >= (t1.accepted_at as number));
    assert.equal(t2.input_resolved, `{"iterations":1,"seed":"${HELLO_1}"}`);
    // Bağımsız görevler iki worker'a dağılmış olmalı
    assert.equal(new Set(replicaRows(s, jobId).map((r) => r.worker_id)).size, 2);
    a.close(); b.close();
  }));

test("görev ortasında worker kopar → kopya LOST, başka worker'a atanır, iş tamamlanır", () =>
  withServer(FAST, async (s) => {
    const bad = startFakeWorker(s.wsUrl, { behavior: "close_on_assign" });
    await bad.id;
    const jobId = await submit(s, readShared("examples/single-task.json"));
    await bad.closed;
    const good = startFakeWorker(s.wsUrl);
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    assert.deepEqual(replicaRows(s, jobId).map((r) => r.state), ["LOST", "RETURNED_OK"]);
    good.close();
  }));

test("sessizleşen worker heartbeat ile 2 × heartbeatMs içinde tespit edilir ve görev yeniden atanır", () =>
  withServer(FAST, async (s) => {
    const silent = startFakeWorker(s.wsUrl, { behavior: "silent_on_assign" });
    await silent.id;
    const jobId = await submit(s, readShared("examples/single-task.json"));
    const t0 = Date.now();
    await silent.closed;
    const detected = Date.now() - t0;
    // 2 × 100 ms sınır + bir denetim periyodu payı
    assert.ok(detected <= 2 * 100 + 150, `tespit ${detected} ms sürdü`);
    const good = startFakeWorker(s.wsUrl);
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    assert.deepEqual(replicaRows(s, jobId).map((r) => r.state), ["LOST", "RETURNED_OK"]);
    good.close();
  }));

test("zaman aşımı: yavaş worker'ın kopyası TIMED_OUT, geç sonuç dikkate alınmaz", () =>
  withServer({ ...FAST, taskTimeoutMs: 150 }, async (s) => {
    const slow = startFakeWorker(s.wsUrl, { delayMs: 600 });
    await slow.id;
    const jobId = await submit(s, readShared("examples/single-task.json"));
    await new Promise((r) => setTimeout(r, 250)); // ilk kopya zaman aşımına uğrasın
    const fast = startFakeWorker(s.wsUrl);
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "COMPLETED");
    const rows = replicaRows(s, jobId);
    assert.equal(rows[0].state, "TIMED_OUT");
    assert.equal(rows[0].worker_id, await slow.id);
    assert.equal(rows[1].state, "RETURNED_OK");
    assert.equal(rows[1].worker_id, await fast.id);
    await new Promise((r) => setTimeout(r, 500)); // geç sonuç gelsin
    assert.equal(s.db.all("SELECT * FROM log WHERE event = 'late_result'").length, 1);
    assert.equal(replicaRows(s, jobId)[0].state, "TIMED_OUT");
    slow.close(); fast.close();
  }));

test("debug_panic: fatal sonuç, yeniden denenir, max_replicas sonunda görev ve iş FAILED", () =>
  withServer({ ...FAST, maxReplicas: 3 }, async (s) => {
    const w = startFakeWorker(s.wsUrl);
    await w.id;
    const jobId = await submit(s, {
      version: 0,
      tasks: [
        { id: "p", module: "debug_panic", input: {} },
        { id: "c", module: "sha_chain", input: { seed: "x", iterations: 1 }, deps: ["p"] },
      ],
    });
    const job = await waitJob(s, jobId);
    assert.equal(job.status, "FAILED");
    assert.deepEqual(job.tasks.map((t) => t.state), ["FAILED", "CANCELLED"]);
    const rows = replicaRows(s, jobId);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.state === "RETURNED_ERROR" && r.fatal === 1));
    w.close();
  }));

test("geçersiz mesaj → bağlantı kapanır, kayda geçer, koordinatör çalışmaya devam eder", () =>
  withServer(FAST, async (s) => {
    const bad = startFakeWorker(s.wsUrl, { behavior: "invalid" });
    const { code } = await bad.closed;
    assert.equal(code, 1008);
    assert.equal(s.db.all("SELECT * FROM log WHERE event = 'invalid_message'").length, 1);
    const health = await fetch(`${s.url}/health`);
    assert.equal(health.status, 200);
    const good = startFakeWorker(s.wsUrl);
    const job = await waitJob(s, await submit(s, readShared("examples/single-task.json")));
    assert.equal(job.status, "COMPLETED");
    good.close();
  }));

test("HTTP API geçersiz DAG için 400, bilinmeyen iş için 404 döner", () =>
  withServer(FAST, async (s) => {
    const bad = await fetch(`${s.url}/jobs`, { method: "POST", body: JSON.stringify({ version: 0, tasks: [{ id: "a", module: "sha_chain", input: {}, deps: ["a"] }] }) });
    assert.equal(bad.status, 400);
    const notJson = await fetch(`${s.url}/jobs`, { method: "POST", body: "{" });
    assert.equal(notJson.status, 400);
    assert.equal((await fetch(`${s.url}/jobs/job_yok`)).status, 404);
  }));

test("status {available:false} gönderen worker'a görev atanmaz; true gelince atanır", () =>
  withServer(FAST, async (s) => {
    const ws = new WebSocket(s.wsUrl);
    const assigns: number[] = [];
    await new Promise<void>((resolve) => {
      ws.on("message", (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === "welcome") {
          ws.send(JSON.stringify({ type: "status", available: false }));
          resolve();
        }
        if (m.type === "ping") ws.send(JSON.stringify({ type: "pong", t: m.t }));
        if (m.type === "assign") assigns.push(m.replicaId);
      });
      ws.on("open", () => ws.send(JSON.stringify({ type: "hello", consent: true })));
    });
    await new Promise((r) => setTimeout(r, 50)); // status işlensin
    await submit(s, readShared("examples/single-task.json"));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(assigns.length, 0, "müsait olmayan worker'a görev gitmemeli");
    ws.send(JSON.stringify({ type: "status", available: true }));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(assigns.length, 1);
    ws.close();
  }));

test("statik sunum: / gönüllü sayfasını verir, kaynak kod ve dizin gezintisi kapalı", () =>
  withServer(FAST, async (s) => {
    const root = await fetch(`${s.url}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type")!, /text\/html/);
    assert.match(await root.text(), /Gönüllü hesaplama/);
    const js = await fetch(`${s.url}/volunteer.js`);
    assert.match(js.headers.get("content-type")!, /javascript/);
    for (const p of ["/package.json", "/coordinator/src/server.ts", "/src/lib.rs", "/..%2Fpackage.json", "/pkg/../package.json", "/.git/config"]) {
      assert.equal((await fetch(`${s.url}${p}`)).status, 404, p);
    }
  }));
