// Gönüllü sayfası ↔ koordinatör uçtan uca testi, gerçek (başsız) Chromium ile (Hafta 6–7 raporu §2.3.5).
// pkg/ derlenmişse WASM, değilse aynı Web Worker'daki saf JS uygulaması kullanılır (IMPL=js|wasm ile zorlanabilir).
// Kullanım: npm run test:volunteer   (CHROMIUM_PATH ile belirli bir tarayıcı verilebilir)
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { createServer } from "../coordinator/src/server.ts";
import { runJs } from "../js-baseline.js";

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
async function setup(config = {}, { expectedConsole = null, random } = {}) {
  const s = await createServer({ config: { heartbeatMs: 1000, missedHeartbeats: 2, taskTimeoutMs: 60000, ...config }, random });
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
  const submit = (dag, opts) => s.coord.submitJob(dag, opts).jobId;
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
    const unexpected = expectedConsole ? logs.filter((l) => !expectedConsole.test(l)) : logs;
    assert.deepEqual(unexpected, [], "sayfada beklenmeyen hata olmamalı");
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

test("üç tarayıcı, üç modüllü iki DAG aynı anda: çatallan-birleş ve zincir", async () => {
  const t = await setup();
  try {
    for (let i = 0; i < 3; i++) await t.openWorker();
    await t.waitWorkers(3);
    const pipeline = t.submit(example("image-pipeline.json"));
    const chain = t.submit(example("matrix-chain.json"));
    for (const jobId of [pipeline, chain]) {
      const job = await t.waitJob(jobId, 60000);
      assert.equal(job.status, "COMPLETED");
      // Her görevin kabul edilen çıktısı, koordinatörün çözdüğü girdiden bağımsız olarak yeniden hesaplanır.
      const rows = t.s.db.all("SELECT dag_task_id, module, input_resolved, accepted_output, ready_at, accepted_at FROM tasks WHERE job_id = ?", jobId);
      for (const r of rows) assert.equal(r.accepted_output, runJs(r.module, r.input_resolved), `${jobId}/${r.dag_task_id}`);
      const at = Object.fromEntries(rows.map((r) => [r.dag_task_id, r]));
      // Alt görev ancak tüm üst görevler kabul edilince hazır olur (spekülatif yürütme yok).
      for (const task of example(jobId === pipeline ? "image-pipeline.json" : "matrix-chain.json").tasks) {
        for (const d of task.deps) assert.ok(at[task.id].ready_at >= at[d].accepted_at, `${task.id} ← ${d}`);
      }
    }
    const used = new Set(t.replicas(pipeline).map((r) => r.worker_id));
    assert.ok(used.size >= 2, "çatallanan görevler birden çok tarayıcıya dağılmalı");
    if (IMPL === "wasm") {
      const hash = t.s.coord.wasmHash;
      assert.ok(hash, "WASM modunda koordinatör paket özetini bilmeli");
      assert.ok(t.s.coord.getJob(pipeline).tasks.every((x) => x.moduleHash === hash));
    }
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
  // WASM panic'i console_error_panic_hook ile konsola yazılır; bu test için beklenen bir çıktıdır.
  const t = await setup({ maxReplicas: 3 }, { expectedConsole: /panicked at src\/lib\.rs/ });
  try {
    await t.openWorker();
    await t.waitWorkers(1);
    const failed = await t.waitJob(t.submit({ version: 0, tasks: [{ id: "p", module: "debug_panic", input: {} }] }));
    assert.equal(failed.status, "FAILED");
    if (IMPL === "wasm") {
      // Gerçek WASM'de panic bir WebAssembly.RuntimeError'dır: fatal işaretlenir, Web Worker yeniden başlar.
      const reps = t.s.db.all("SELECT r.fatal FROM replicas r JOIN tasks k ON k.id = r.task_id WHERE k.job_id = ?", failed.jobId);
      assert.equal(reps.length, 3);
      assert.ok(reps.every((r) => r.fatal === 1));
    }
    // Aynı worker sonraki işi yine de yapabilmeli
    const ok = await t.waitJob(t.submit(example("single-task.json")));
    assert.equal(ok.tasks[0].output.hash, HELLO_1000);
  } finally {
    await t.teardown();
  }
});

// ---------- 9. hafta (9.3): deney modu gerçek doğrulama stratejileriyle ----------

const indep = (n, prefix = "t") => ({
  version: 0,
  tasks: Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, module: "sha_chain", input: { seed: `${prefix}-${i}`, iterations: 200 } })),
});
const correct = (t, jobId) =>
  t.s.db.all("SELECT module, input_resolved, accepted_output FROM tasks WHERE job_id = ?", jobId)
    .every((r) => r.accepted_output === runJs(r.module, r.input_resolved));

test("fixed2: deney modundaki hileli tarayıcının sonucu reddedilir, itibarı düşer", async () => {
  const t = await setup();
  try {
    await t.openWorker();
    await t.openWorker();
    await t.openWorker("autostart=1&cpu=high&fault=random&s=1");
    const ws = await t.waitWorkers(3);
    const jobId = t.submit(indep(6), { verifier: "fixed2" });
    const job = await t.waitJob(jobId);
    assert.equal(job.status, "COMPLETED");
    assert.ok(correct(t, jobId), "kabul edilen tüm sonuçlar doğru olmalı");
    const liar = t.s.coord.listWorkers().find((w) => w.beta > 0);
    assert.ok(liar, "hileli tarayıcı mismatch almalı");
    assert.equal(t.s.coord.listWorkers().filter((w) => w.beta > 0).length, 1, "yalnızca hileli tarayıcı");
    assert.ok(ws.length === 3);
  } finally {
    await t.teardown();
  }
});

test("fixed2: iki colluder tarayıcı aynı yanlış sonucu verince kabul edilir (beklenen zayıflık)", async () => {
  const t = await setup();
  try {
    await t.openWorker("autostart=1&cpu=high&fault=collude&s=1");
    await t.openWorker("autostart=1&cpu=high&fault=collude&s=1");
    await t.waitWorkers(2);
    const jobId = t.submit(indep(2), { verifier: "fixed2" });
    const job = await t.waitJob(jobId);
    assert.equal(job.status, "COMPLETED");
    assert.ok(!correct(t, jobId), "colluder'ların ortak yanlış sonucu kabul edilir");
  } finally {
    await t.teardown();
  }
});

test("adaptive: sınama işi gerçek görevden ayırt edilemez; hileli tarayıcı yakalanır, dürüstler geçer", async () => {
  // Üç tarayıcının her biri en az bir sınama işi alana kadar her atama sınama işi; sonra sınama yok.
  // (Sabit "ilk üç çağrı" sayımı yarışa açıktı: bir tarayıcı geç hazır olursa hızlı bir dürüst
  // tarayıcı ikinci sınama işini alıyor, hileli tarayıcı hiç sınanmıyordu — CI'da görüldü.)
  let db = null;
  const spotted = () => Number(db?.all("SELECT COUNT(DISTINCT worker_id) AS n FROM replicas WHERE is_spotcheck = 1")[0]?.n ?? 0);
  const t = await setup({}, { random: () => (spotted() < 3 ? 0 : 0.99) });
  db = t.s.db;
  try {
    await t.openWorker();
    await t.openWorker();
    await t.openWorker("autostart=1&cpu=high&fault=random&s=1");
    await t.waitWorkers(3);
    const jobId = t.submit(indep(4), { verifier: "adaptive" });
    const job = await t.waitJob(jobId);
    assert.equal(job.status, "COMPLETED");
    assert.ok(correct(t, jobId));
    const kinds = t.s.db.all("SELECT kind, COUNT(*) AS n FROM rep_events WHERE kind LIKE 'spot%' GROUP BY kind");
    const n = Object.fromEntries(kinds.map((k) => [k.kind, k.n]));
    assert.ok(n.spot_fail >= 1, "hileli tarayıcı sınama işinde yakalanır");
    assert.ok(n.spot_pass >= 2, "iki dürüst tarayıcı sınamayı geçer");
    const flagged = t.s.coord.listWorkers().filter((w) => w.flagged);
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].trusted, false);
    // Geçilen sınama işleri iş sonunda ödenir, başarısız olan ödenmez.
    const spots = t.s.db.all("SELECT paid, output = expected_output AS ok FROM replicas WHERE is_spotcheck = 1");
    assert.ok(spots.every((r) => r.paid === r.ok));
  } finally {
    await t.teardown();
  }
});


test("on-off saldırgan: dürüst çalışıp tek kopya moduna geçen tarayıcı aynı kimlikle hile moduna alınır; sınamada yakalanır, tek kopyalı sonuçları geriye dönük iptal edilip yeniden hesaplanır", async () => {
  // Ara demo senaryosu. 1) Isınma: sabit 2'li ile her sonuç eşleşmeyle doğrulanır, üç tarayıcı da güven kazanır.
  // 2) Üçüncü tarayıcı aynı sekmede (aynı workerId, itibarı koordinatörde) fault=random&s=1 ile yeniden açılır.
  // 3) Uyarlanabilir işte güvenilir olduğu için sonuçları tek kopyayla kabul edilir; birkaç sonuçtan sonra
  //    sınama işleri açılır ve ilk sınamada yakalanır → geriye dönük iptal → doğru sonuçlarla tamamlanır.
  let db = null, liar = null, phase2 = 0, armed = false;
  const liarDone = () => Number(db?.all("SELECT COUNT(*) AS n FROM replicas WHERE worker_id = ? AND state = 'RETURNED_OK' AND id > ?", liar ?? "", phase2)[0]?.n ?? 0);
  const caught = () => Number(db?.all("SELECT COUNT(*) AS n FROM rep_events WHERE kind = 'spot_fail'")[0]?.n ?? 0) > 0;
  // Sınama, hileli tarayıcı 2 tek kopyalı sonuç verdikten sonra açılır; iş (60 görev) bu sırada bitmemiş olmalı,
  // yoksa yakalanma geç kalır (late_detection) ve bitmiş işteki sonuçlar geri alınamaz. Yavaş CI makinesinde
  // 4 sonuç / 40 görev bu payı bırakmıyordu.
  const random = () => (armed && !caught() && liarDone() >= 2 ? 0 : 0.99);
  const t = await setup({}, { random });
  db = t.s.db;
  try {
    await t.openWorker();
    await t.openWorker();
    await t.waitWorkers(2);
    const page = await t.openWorker();
    liar = (await t.waitWorkers(3)).at(-1).id;
    const warm = await t.waitJob(t.submit(indep(60, "isinma"), { verifier: "fixed2" }), 60000);
    assert.equal(warm.status, "COMPLETED");
    assert.ok(t.s.coord.listWorkers().every((w) => w.trusted), "ısınmadan sonra üç tarayıcı da güvenilir");

    await page.goto(`${t.s.url}/volunteer.html?impl=${IMPL}&autostart=1&cpu=high&fault=random&s=1`);
    const end = Date.now() + 10000;
    while (!(t.s.coord.listWorkers().length === 3 && t.s.coord.listWorkers().some((w) => w.id === liar))) {
      if (Date.now() > end) throw new Error("hileli tarayıcı aynı kimlikle yeniden bağlanmadı");
      await sleep(20);
    }
    assert.equal(t.s.coord.listWorkers().find((w) => w.id === liar).trusted, true, "itibarı koordinatörde korunur");

    phase2 = Number(db.all("SELECT MAX(id) AS m FROM replicas")[0].m);
    armed = true;
    const jobId = t.submit(indep(60, "onoff"), { verifier: "adaptive" });
    const job = await t.waitJob(jobId, 60000);
    assert.equal(job.status, "COMPLETED");
    assert.ok(correct(t, jobId), "iptal ve yeniden hesaplamadan sonra kabul edilen tüm sonuçlar doğru");
    const of = (name) => db.all("SELECT detail FROM log WHERE event = ?", name).map((e) => JSON.parse(e.detail));
    assert.ok(of("spotcheck_failed").some((d) => d.workerId === liar), "sınama işinde yakalanır");
    const cancels = of("retroactive_cancel").filter((d) => d.workerId === liar && d.jobId === jobId);
    assert.ok(cancels.length > 0 && cancels[0].tasks.length > 0, "tek kopyalı sonuçları geriye dönük iptal edilir");
    assert.equal(t.s.coord.listWorkers().find((w) => w.id === liar).trusted, false, "güveni düşer");
  } finally {
    await t.teardown();
  }
});

test("ödeme adresi: geçerli Solana adresi hello'da gider ve saklanır; geçersiz adres yok sayılır", async () => {
  const t = await setup();
  try {
    const good = "FKqFgXvXGih6KDYsLSLNAk5WrANM68ZfgkfGUWmEeyrF";
    const page = await t.openWorker(`autostart=1&cpu=high&wallet=${good}`);
    await t.openWorker("autostart=1&cpu=high&wallet=0xdeadbeef");
    const ws = await t.waitWorkers(2);
    assert.deepEqual(ws.map((w) => w.wallet).sort(), [good, null].sort());
    await page.waitForFunction(() => document.getElementById("walletShown").textContent.startsWith("FKqF"));
    assert.equal(t.s.db.all("SELECT COUNT(*) AS n FROM workers WHERE wallet = ?", good)[0].n, 1);
  } finally {
    await t.teardown();
  }
});
