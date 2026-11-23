/**
 * 9.4: x402 ile iş satın alma. Gerçek koordinatör + sahte facilitator (ağ gerektirmez).
 * Gerçek Devnet denemesi elle yapılır (README, "Ödemeli koordinatör").
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttp, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { DEVNET_USDC_MINT, SOLANA_DEVNET } from "../../payments/x402-proto/src/config.ts";
import type { Config } from "../src/config.ts";
import { formatUsdc } from "../src/coordinator.ts";
import { jsOracle } from "../src/oracle.ts";
import { createServer } from "../src/server.ts";
import type { PayingFetchFactory } from "../src/api/demo-buyer.ts";
import { startFakeWorker } from "./fake-worker.ts";

const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FEE_PAYER = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
const BUYER = "FKqFgXvXGih6KDYsLSLNAk5WrANM68ZfgkfGUWmEeyrF";
const FAST: Partial<Config> = { heartbeatMs: 200, missedHeartbeats: 3, taskTimeoutMs: 10000 };

// ---------- Sahte facilitator ----------
// Doğrulamada "BAD" işlemi reddeder; kesinleştirmede aynı işlemi ikinci kez kabul etmez (tekrar koruması).
let facilitator: HttpServer, fUrl: string;
const settled = new Set<string>();
const calls: string[] = [];
const listen = (s: HttpServer) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

before(async () => {
  facilitator = createHttp(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    const tx = body.paymentPayload?.payload?.transaction as string | undefined;
    if (req.url === "/supported") {
      return res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_DEVNET, extra: { feePayer: FEE_PAYER } }], extensions: [], signers: {} }));
    }
    if (req.url === "/verify") {
      if (tx === "BAD") return res.end(JSON.stringify({ isValid: false, invalidReason: "invalid_exact_svm_transaction_simulation_failed" }));
      return res.end(JSON.stringify({ isValid: true, payer: BUYER }));
    }
    if (req.url === "/settle") {
      if (settled.has(tx!)) {
        return res.end(JSON.stringify({ success: false, errorReason: "invalid_exact_svm_transaction_already_processed", transaction: "", network: SOLANA_DEVNET }));
      }
      settled.add(tx!);
      return res.end(JSON.stringify({ success: true, transaction: `SIG_${tx}`, network: SOLANA_DEVNET, payer: BUYER }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  fUrl = await listen(facilitator);
});
after(() => facilitator.close());

type Server = Awaited<ReturnType<typeof createServer>>;
async function withPaid(fn: (s: Server) => Promise<void>, cfg: Partial<Config> = {}) {
  const s = await createServer({ config: { ...FAST, ...cfg }, oracle: jsOracle, payments: { payTo: PAY_TO, facilitatorUrl: fUrl } });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const dag = (n: number) => ({
  version: 0,
  tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, module: "sha_chain", input: { seed: `p-${i}`, iterations: 20 } })),
});
const postJobs = (s: Server, body: unknown, q = "", headers: Record<string, string> = {}) =>
  fetch(`${s.url}/jobs${q}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** 402 yanıtındaki gereksinimlerle (sahte) bir ödeme başlığı üretir. */
async function payHeader(s: Server, body: unknown, q: string, tx: string) {
  const res = await postJobs(s, body, q);
  assert.equal(res.status, 402);
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
  return encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: tx } });
}

// ---------- Teklif ----------

test("POST /quote: üst sınır formülü (uyarlanabilir q ile, sabit stratejide q = 0); iş oluşturmaz", () =>
  withPaid(async (s) => {
    const quote = async (q: string) => (await (await fetch(`${s.url}/quote${q}`, { method: "POST", body: JSON.stringify(dag(7)) })).json()) as {
      quote: { capAtomic: number; cap: string; spotCheckRate: number; unitPriceAtomic: number; maxReplicas: number }; payment: { payTo: string; asset: string; network: string };
    };
    const a = await quote("?verifier=adaptive");
    // p = 0,001 USDC = 1000 atomik; 1000 × 7 × 10 / 0,9 = 77 777,7… → 77 778
    assert.equal(a.quote.unitPriceAtomic, 1000);
    assert.equal(a.quote.maxReplicas, 10);
    assert.equal(a.quote.spotCheckRate, 0.1);
    assert.equal(a.quote.capAtomic, 77778);
    assert.equal(a.quote.cap, "0.077778");
    assert.deepEqual(a.payment, { network: SOLANA_DEVNET, asset: DEVNET_USDC_MINT, payTo: PAY_TO, scheme: "exact" });
    const f = await quote("?verifier=fixed2");
    assert.equal(f.quote.capAtomic, 70000);
    assert.equal(f.quote.spotCheckRate, 0);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
    assert.equal(formatUsdc(1), "0.000001");
  }));

test("geçersiz DAG ya da bilinmeyen strateji: ödeme istenmeden 400", () =>
  withPaid(async (s) => {
    const bad = await postJobs(s, { version: 0, tasks: [{ id: "a", module: "yok", input: {} }] });
    assert.equal(bad.status, 400);
    assert.equal(bad.headers.get("PAYMENT-REQUIRED"), null);
    assert.equal((await postJobs(s, dag(1), "?verifier=boinc_adaptive")).status, 400);
  }));

// ---------- Ödeme akışı ----------

test("ödemesiz POST /jobs → 402; tutar = üst sınır, Devnet USDC, platform adresi; iş oluşmaz", () =>
  withPaid(async (s) => {
    const res = await postJobs(s, dag(3), "?verifier=adaptive");
    assert.equal(res.status, 402);
    const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
    const [req] = pr.accepts;
    assert.equal(req.scheme, "exact");
    assert.equal(req.network, SOLANA_DEVNET);
    assert.equal(req.asset, DEVNET_USDC_MINT);
    assert.equal(req.payTo, PAY_TO);
    assert.equal(req.amount, String(Math.ceil((1000 * 3 * 10) / 0.9)));
    assert.equal((req.extra as { feePayer?: string }).feePayer, FEE_PAYER);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  }));

test("geçerli ödeme: kesinleşir, iş kuyruğa girer, defter yazılır; iş bitince gerçekleşen maliyet ve iade", () =>
  withPaid(async (s) => {
    const w1 = startFakeWorker(s.wsUrl), w2 = startFakeWorker(s.wsUrl);
    try {
      await Promise.all([w1.id, w2.id]);
      const sig = await payHeader(s, dag(4), "?verifier=fixed2", "TX_OK");
      const res = await postJobs(s, dag(4), "?verifier=fixed2", { "PAYMENT-SIGNATURE": sig });
      assert.equal(res.status, 201);
      const out = (await res.json()) as { jobId: string; quote: { capAtomic: number }; payment: { transaction: string; payer: string } };
      assert.deepEqual(out.payment, { transaction: "SIG_TX_OK", payer: BUYER });
      const pr = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE")!);
      assert.equal(pr.success, true);
      assert.equal(pr.transaction, "SIG_TX_OK");
      assert.ok(calls.includes("POST /verify") && calls.includes("POST /settle"));

      const end = Date.now() + 10000;
      while (s.coord.getJob(out.jobId)!.status === "RUNNING" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      const job = s.coord.getJob(out.jobId)!;
      assert.equal(job.status, "COMPLETED");
      // fixed2, hatasız: görev başına 2 ödenen kopya → 4 × 2 × 1000 = 8000; üst sınır 4 × 10 × 1000 = 40 000
      assert.deepEqual(job.payment, {
        capAtomic: 40000, transaction: "SIG_TX_OK", payer: BUYER, realizedAtomic: 8000, refundDueAtomic: 32000, refundTransaction: null,
      });
    } finally {
      w1.close();
      w2.close();
    }
  }));

test("aynı ödemenin tekrarı reddedilir: ikinci iş oluşmaz", () =>
  withPaid(async (s) => {
    const sig = await payHeader(s, dag(2), "", "TX_REPLAY");
    assert.equal((await postJobs(s, dag(2), "", { "PAYMENT-SIGNATURE": sig })).status, 201);
    const again = await postJobs(s, dag(2), "", { "PAYMENT-SIGNATURE": sig });
    assert.equal(again.status, 402);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 1);
    assert.ok(s.db.all("SELECT event FROM log WHERE event = 'payment_settle_failed'").length > 0);
  }));

test("ödeme imzası tutara bağlı: küçük iş için imzalanan ödemeyle büyük iş gönderilemez", () =>
  withPaid(async (s) => {
    const sig = await payHeader(s, dag(1), "", "TX_SMALL");
    const res = await postJobs(s, dag(5), "", { "PAYMENT-SIGNATURE": sig });
    assert.equal(res.status, 402);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
    assert.ok(!settled.has("TX_SMALL"), "uyuşmayan ödeme kesinleştirilmez");
  }));

test("facilitator'ın reddettiği ödeme (ör. yetersiz bakiye): 402, iş oluşmaz", () =>
  withPaid(async (s) => {
    const sig = await payHeader(s, dag(1), "", "BAD");
    assert.equal((await postJobs(s, dag(1), "", { "PAYMENT-SIGNATURE": sig })).status, 402);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  }));

test("ödeme kapalıyken (varsayılan) POST /jobs eskisi gibi ödemesiz çalışır; /quote ödeme bilgisi vermez", async () => {
  const s = await createServer({ config: FAST, oracle: jsOracle });
  try {
    assert.equal((await postJobs(s, dag(1))).status, 201);
    const q = (await (await fetch(`${s.url}/quote`, { method: "POST", body: JSON.stringify(dag(1)) })).json()) as { payment: unknown };
    assert.equal(q.payment, null);
  } finally {
    await s.close();
  }
});

// ---------- Demo paneli (ara demo): alıcı ve izleme uç noktaları ----------

/** Gerçek Devnet imzası yerine sahte işlemle ödeme başlığı üreten "ödemeli fetch" (x402 akışı aynı). */
const fakePaying = (tx: string): PayingFetchFactory => async (maxAtomic) => (f) => async (input, init) => {
  const req0 = new Request(input, init);
  const body = await req0.clone().text();
  const res = await f(req0);
  if (res.status !== 402) return res;
  const pr = decodePaymentRequiredHeader(res.headers.get("PAYMENT-REQUIRED")!);
  if (BigInt(pr.accepts[0].amount) > maxAtomic) throw new Error("bütçe aşıldı: ödeme yapılmadı");
  const h = new Headers(req0.headers);
  h.set("PAYMENT-SIGNATURE", encodePaymentSignatureHeader({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: tx } }));
  return f(new Request(req0.url, { method: "POST", headers: h, body }));
};

async function withDemo(fn: (s: Server) => Promise<void>, tx = "TX_DEMO") {
  const s = await createServer({
    config: FAST, oracle: jsOracle, payments: { payTo: PAY_TO, facilitatorUrl: fUrl },
    demoBuyer: { payingFetch: fakePaying(tx), address: BUYER },
  });
  try {
    await fn(s);
  } finally {
    await s.close();
  }
}

const demoBuy = (s: Server, body: unknown, q: string) =>
  fetch(`${s.url}/demo/buy${q}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("demo alıcısı: 402 → imza → kesinleşme adımları kaydedilir, iş oluşur ve defter yazılır", () =>
  withDemo(async (s) => {
    const info = (await (await fetch(`${s.url}/demo/info`)).json()) as { buyer: string; buyerAvailable: boolean; payment: { payTo: string } };
    assert.equal(info.buyer, BUYER);
    assert.equal(info.buyerAvailable, true);
    assert.equal(info.payment.payTo, PAY_TO);
    const res = await demoBuy(s, dag(3), "?verifier=adaptive&maxUsdc=0.1");
    assert.equal(res.status, 201);
    const out = (await res.json()) as { ok: boolean; jobId: string; transaction: string; steps: { kind: string; detail: Record<string, unknown> }[] };
    assert.equal(out.ok, true);
    assert.deepEqual(out.steps.map((x) => x.kind), ["request", "payment_required", "signed", "settled"]);
    assert.equal(out.steps[1].detail.amountAtomic, Math.ceil((1000 * 3 * 10) / 0.9));
    assert.equal(out.transaction, "SIG_TX_DEMO");
    const job = s.coord.getJob(out.jobId)!;
    assert.equal(job.verifier, "adaptive");
    assert.equal(job.payment!.transaction, "SIG_TX_DEMO");
  }));

test("demo alıcısı: üst sınır bütçeyi aşarsa ödeme yapılmaz, iş oluşmaz", () =>
  withDemo(async (s) => {
    const res = await demoBuy(s, dag(7), "?verifier=adaptive&maxUsdc=0.01");
    assert.equal(res.status, 402);
    const out = (await res.json()) as { ok: boolean; error: string; steps: { kind: string }[] };
    assert.equal(out.ok, false);
    assert.match(out.error, /bütçe/);
    assert.deepEqual(out.steps.map((x) => x.kind), ["request", "payment_required"]);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  }, "TX_BUDGET"));

test("demo alıcısı kapalıyken 409; geçersiz DAG ödeme istenmeden 400", async () => {
  await withPaid(async (s) => {
    assert.equal((await demoBuy(s, dag(1), "")).status, 409);
    const info = (await (await fetch(`${s.url}/demo/info`)).json()) as { buyer: string | null; buyerAvailable: boolean };
    assert.deepEqual([info.buyer, info.buyerAvailable], [null, false]);
  });
  await withDemo(async (s) => {
    const res = await demoBuy(s, { version: 0, tasks: [] }, "");
    const out = (await res.json()) as { steps: { kind: string }[] };
    assert.equal(res.status, 400);
    assert.deepEqual(out.steps.map((x) => x.kind), ["request"]);
  }, "TX_BAD");
});

test("panel uç noktaları: örnek DAG'ler, olay kaydı, panel sayfası; worker ve görev ayrıntıları", () =>
  withDemo(async (s) => {
    const list = (await (await fetch(`${s.url}/examples`)).json()) as { name: string; tasks: number }[];
    assert.deepEqual(list.find((e) => e.name === "image-pipeline"), { name: "image-pipeline", jobId: "ornek-goruntu-hatti", tasks: 7 });
    const ex = (await (await fetch(`${s.url}/examples/image-pipeline`)).json()) as { tasks: unknown[] };
    assert.equal(ex.tasks.length, 7);
    assert.equal((await fetch(`${s.url}/examples/yok`)).status, 404);
    assert.equal((await fetch(`${s.url}/examples/..%2Fconfig`)).status, 404);
    const panel = await fetch(`${s.url}/panel`);
    assert.equal(panel.status, 200);
    assert.match(await panel.text(), /<title>/);

    const w = startFakeWorker(s.wsUrl);
    try {
      await w.id;
      const out = (await (await demoBuy(s, dag(2), "?verifier=accept_first")).json()) as { jobId: string };
      const end = Date.now() + 10000;
      while (s.coord.getJob(out.jobId)!.status === "RUNNING" && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
      const job = s.coord.getJob(out.jobId)!;
      // accept_first: tek kopyayla kabul
      assert.deepEqual(job.tasks.map((t) => [t.deps, t.agreeing, t.single]), [[[], 1, true], [[], 1, true]]);
      const [wk] = s.coord.listWorkers();
      assert.equal(typeof wk.deviceClass, "string");
      assert.equal(wk.doing, null);
      const ev = (await (await fetch(`${s.url}/events`)).json()) as { id: number; event: string }[];
      const names = ev.map((e) => e.event);
      for (const n of ["worker_connected", "job_paid", "job_finished"]) assert.ok(names.includes(n), n);
      const later = (await (await fetch(`${s.url}/events?since=${ev.at(-1)!.id}`)).json()) as unknown[];
      assert.equal(later.length, 0);
    } finally {
      w.close();
    }
  }, "TX_PANEL"));
