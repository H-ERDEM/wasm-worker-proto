// Gönüllü sayfası ↔ koordinatör uçtan uca testi, gerçek (başsız) Chromium ile (Hafta 6–7 raporu §2.3.5).
// pkg/ derlenmişse WASM, değilse aynı Web Worker'daki saf JS uygulaması kullanılır (IMPL=js|wasm ile zorlanabilir).
// Kullanım: npm run test:volunteer   (CHROMIUM_PATH ile belirli bir tarayıcı verilebilir)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { createServer } from "../coordinator/src/server.ts";

const IMPL = process.env.IMPL ?? (existsSync(new URL("../pkg/vc_tasks_bg.wasm", import.meta.url)) ? "wasm" : "js");
console.log(`# görev uygulaması: ${IMPL}`);

const HELLO_1 = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const HELLO_1000 = "f6eec10c841b542f37ffb4ca00f82c5b6b4b11b79636d20201078b667ac37159";
const MATMUL_42_64 = "21bfb70784701c76d11da1401dec6eb95c570e074e7a831c5ac69a56514433cb";
const example = (name) => JSON.parse(readFileSync(new URL(`../shared/examples/${name}`, import.meta.url), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
before(async () => {
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});
after(() => browser?.close());

/** Her test kendi koordinatörünü (bellek içi SQLite) ve kendi tarayıcı bağlamlarını kullanır. */
async function setup(config = {}) {
  const s = await createServer({ config: { heartbeatMs: 1000, missedHeartbeats: 2, taskTimeoutMs: 60000, ...config } });
  const contexts = [];
  const logs = [];
  const openWorker = async (query = "autostart=1&cpu=high") => {
    const ctx = await browser.newContext(); // ayrı localStorage → ayrı workerId
    contexts.push(ctx);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
    page.on("console", (m) => m.type() === "error" && logs.push(`[console] ${m.text()}`));
    await page.goto(`${s.url}/volunteer.html?impl=${IMPL}&${query}`);
    return page;
  };
  const waitWorkers = async (n, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (s.coord.listWorkers().length !== n) {
      if (Date.now() > end) throw new Error(`${n} worker beklenirken ${s.coord.listWorkers().length} var`);
      await sleep(20);
    }
    return s.coord.listWorkers();
  };
  const submit = (dag) => s.coord.submitJob(dag).jobId;
  const waitJob = async (jobId, timeout = 30000) => {
    const end = Date.now() + timeout;
    for (;;) {
      const job = s.coord.getJob(jobId);
      if (job.status !== "RUNNING") return job;
      if (Date.now() > end) throw new Error(`iş bitmedi: ${JSON.stringify(job)}`);
      await sleep(25);
    }
  };
  const replicas = (jobId) =>
    s.db.all("SELECT r.* FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? ORDER BY r.id", jobId);
  const teardown = async () => {
    for (const c of contexts) await c.close().catch(() => {});
    await s.close();
    assert.deepEqual(logs, [], "sayfada hata olmamalı");
  };
  return { s, openWorker, waitWorkers, submit, waitJob, replicas, teardown };
}

test("onay verilmeden bağlanmaz; 'Katılıyorum' sonrası bağlanır", async () => {
  const t = await setup();
  try {
    const page = await t.openWorker("cpu=high");
    await sleep(500);
    assert.equal(t.s.coord.listWorkers().length, 0);
    await page.click("#agree");
    await t.waitWorkers(1);
    await page.waitForFunction(() => document.getElementById("conn").textContent === "bağlı");
  } finally {
    await t.teardown();
  }
});

test("tek görev: tarayıcı worker'ı README vektörünü üretir", async () => {
  const t = await setup();
  try {
    const page = await t.openWorker();
    await t.waitWorkers(1);
    const jobId = t.submit(example("single-task.json"));
    const job = await t.waitJob(jobId);
    assert.equal(job.status, "COMPLETED");
    assert.equal(job.tasks[0].output.hash, HELLO_1000);
    const [r] = t.replicas(jobId);
    assert.equal(r.state, "RETURNED_OK");
    assert.ok(r.duration_ms >= 0);
    await page.waitForFunction(() => document.getElementById("done").textContent === "1");
  } finally {
    await t.teardown();
  }
});

test("iki tarayıcı, $ref içeren 3 görevli DAG", async () => {
  const t = await setup();
  try {
    await t.openWorker();
    await t.openWorker();
    await t.waitWorkers(2);
    const jobId = t.submit(example("three-task-dag.json"));
    const job = await t.waitJob(jobId);
    assert.equal(job.status, "COMPLETED");
    const out = Object.fromEntries(job.tasks.map((x) => [x.id, x.output.hash]));
    assert.equal(out.t1, HELLO_1);
    assert.equal(out.t2, createHash("sha256").update(HELLO_1, "utf8").digest("hex"));
    assert.equal(out.t3, MATMUL_42_64);
    assert.equal(new Set(t.replicas(jobId).map((r) => r.worker_id)).size, 2, "bağımsız görevler iki worker'a dağılmalı");
  } finally {
    await t.teardown();
  }
});

test("görev ortasında sekme kapanır → LOST, ikinci tarayıcıda tamamlanır", async () => {
  const t = await setup();
  try {
    const first = await t.openWorker();
    await t.waitWorkers(1);
    const jobId = t.submit({ version: 0, tasks: [{ id: "long", module: "sha_chain", input: { seed: "long", iterations: IMPL === "js" ? 1500000 : 5000000 } }] });
    await first.waitForFunction(() => document.getElementById("state").textContent.startsWith("çalışıyor"));
    await first.close();
    await t.openWorker();
    const job = await t.waitJob(jobId, 60000);
    assert.equal(job.status, "COMPLETED");
    assert.deepEqual(t.replicas(jobId).map((r) => r.state), ["LOST", "RETURNED_OK"]);
  } finally {
    await t.teardown();
  }
});

test("bağlantı koparsa sayfa aynı workerId ile yeniden bağlanır", async () => {
  const t = await setup();
  try {
    await t.openWorker();
    const [before] = await t.waitWorkers(1);
    for (const c of t.s.wss.clients) c.terminate();
    await sleep(100);
    const [afterW] = await t.waitWorkers(1, 15000);
    assert.equal(afterW.id, before.id, "localStorage'daki workerId korunmalı");
    const job = await t.waitJob(t.submit(example("single-task.json")));
    assert.equal(job.status, "COMPLETED");
  } finally {
    await t.teardown();
  }
});

test("CPU sınırı (orta): görevler arasında ≥ 1 sn ara, bu sırada görev atanmaz", async () => {
  const t = await setup();
  try {
    await t.openWorker("autostart=1&cpu=medium");
    await t.waitWorkers(1);
    const jobId = t.submit({
      version: 0,
      tasks: [
        { id: "a", module: "sha_chain", input: { seed: "a", iterations: 10 } },
        { id: "b", module: "sha_chain", input: { seed: "b", iterations: 10 } },
      ],
    });
    await t.waitJob(jobId);
    const [ra, rb] = t.replicas(jobId);
    const gap = rb.assigned_at - ra.returned_at;
    assert.ok(gap >= 900, `ara ${gap} ms`);
  } finally {
    await t.teardown();
  }
});

test("deney modu fault=random&s=1: yanlış sonuç gerçek biçimde döner ve accept_first onu kabul eder", async () => {
  const t = await setup();
  try {
    await t.openWorker("autostart=1&cpu=high&fault=random&s=1");
    await t.waitWorkers(1);
    const job = await t.waitJob(t.submit(example("single-task.json")));
    assert.equal(job.status, "COMPLETED");
    assert.notEqual(job.tasks[0].output.hash, HELLO_1000, "kasıtlı hatalı sonuç");
    assert.match(job.tasks[0].output.hash, /^[0-9a-f]{64}$/);
    assert.equal(job.tasks[0].output.iterations, 1000, "biçim gerçek çıktıyla aynı");
  } finally {
    await t.teardown();
  }
});

test("debug_panic: hata raporlanır, worker toparlanır, görev max_replicas sonunda FAILED", async () => {
  const t = await setup({ maxReplicas: 3 });
  try {
    await t.openWorker();
    await t.waitWorkers(1);
    const failed = await t.waitJob(t.submit({ version: 0, tasks: [{ id: "p", module: "debug_panic", input: {} }] }));
    assert.equal(failed.status, "FAILED");
    // Aynı worker sonraki işi yine de yapabilmeli
    const ok = await t.waitJob(t.submit(example("single-task.json")));
    assert.equal(ok.tasks[0].output.hash, HELLO_1000);
  } finally {
    await t.teardown();
  }
});
