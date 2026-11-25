/**
 * 10.2: MCP sunucusu. Gerçek koordinatör (HTTP) + sahte facilitator + sahte worker'lar; MCP istemcisi
 * bellek içi taşımayla bağlanır. Ödeme x402 v2 MCP taşıması: _meta["x402/payment"] / ["x402/payment-response"].
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../src/config.ts";
import { jsOracle } from "../src/oracle.ts";
import { createServer } from "../src/server.ts";
import { createMcpServer, PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY } from "../src/mcp/server.ts";
import { runScenario } from "../src/mcp/scenario.ts";
import { startFakeWorker } from "./fake-worker.ts";
import { FAKE_BUYER, startFakeFacilitator } from "./fake-facilitator.ts";

const PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const FAST: Partial<Config> = { heartbeatMs: 200, missedHeartbeats: 3, taskTimeoutMs: 10000 };
let fac: Awaited<ReturnType<typeof startFakeFacilitator>>;
before(async () => { fac = await startFakeFacilitator(); });
after(() => fac.close());

const dag = (n: number) => ({
  version: 0 as const,
  tasks: Array.from({ length: n }, (_, i) => ({ id: `t${i}`, module: "sha_chain", input: { seed: `m-${i}`, iterations: 20 } })),
});

type Ctx = { s: Awaited<ReturnType<typeof createServer>>; client: Client };
async function withMcp(fn: (c: Ctx) => Promise<void>, paid = true) {
  const s = await createServer({ config: FAST, oracle: jsOracle, ...(paid ? { payments: { payTo: PAY_TO, facilitatorUrl: fac.url } } : {}) });
  const mcp = createMcpServer({ baseUrl: s.url, pollMs: 20 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: "test-ajan", version: "1" }, { capabilities: {} });
  await client.connect(ct);
  const w1 = startFakeWorker(s.wsUrl), w2 = startFakeWorker(s.wsUrl);
  await Promise.all([w1.id, w2.id]);
  try {
    await fn({ s, client });
  } finally {
    w1.close(); w2.close();
    await client.close();
    await mcp.close();
    await s.close();
  }
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[]; _meta?: Record<string, unknown> };
const call = async (c: Client, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
  (await c.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as unknown as ToolResult;

/** PaymentRequired'dan (sahte işlemle) PaymentPayload: gerçek istemcide x402Client.createPaymentPayload. */
const payloadFrom = (pr: Record<string, unknown>, tx: string) =>
  ({ x402Version: 2, resource: pr.resource, accepted: (pr.accepts as unknown[])[0], payload: { transaction: tx } });

test("araç listesi: beş araç; get_result MCP Tasks destekli (optional)", () =>
  withMcp(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["get_quote", "get_result", "get_status", "list_modules", "submit_workflow"]);
    assert.equal(tools.find((t) => t.name === "get_result")!.execution?.taskSupport, "optional");
    const mods = await call(client, "list_modules", {});
    assert.ok((mods.structuredContent!.modules as unknown[]).length >= 3);
  }));

test("get_quote: üst sınır HTTP /quote ile aynı; iş oluşturmaz", () =>
  withMcp(async ({ s, client }) => {
    const q = await call(client, "get_quote", { dag: dag(7), verifier: "adaptive" });
    assert.equal((q.structuredContent!.quote as { capAtomic: number }).capAtomic, 77778);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  }));

test("submit_workflow x402 MCP taşıması: ödemesiz → PaymentRequired; _meta ile tekrar → iş + payment-response; sonuç beklenir", () =>
  withMcp(async ({ s, client }) => {
    const first = await call(client, "submit_workflow", { dag: dag(3), verifier: "fixed2" });
    assert.equal(first.isError, true);
    const pr = first.structuredContent!;
    assert.equal(pr.x402Version, 2);
    const acc = (pr.accepts as { amount: string; payTo: string }[])[0];
    assert.equal(acc.amount, "30000");
    assert.equal(acc.payTo, PAY_TO);
    assert.deepEqual(JSON.parse(first.content[0].text!), pr, "content[0].text aynı nesne (yapısal içeriği okuyamayan istemciler için)");
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);

    const paid = await call(client, "submit_workflow", { dag: dag(3), verifier: "fixed2" }, { [PAYMENT_META_KEY]: payloadFrom(pr, "TX_MCP") });
    assert.ok(!paid.isError, JSON.stringify(paid));
    const jobId = paid.structuredContent!.jobId as string;
    const settle = paid._meta![PAYMENT_RESPONSE_META_KEY] as { success: boolean; transaction: string; payer: string };
    assert.deepEqual([settle.success, settle.transaction, settle.payer], [true, "SIG_TX_MCP", FAKE_BUYER]);

    const res = await call(client, "get_result", { jobId });
    assert.ok(!res.isError);
    assert.equal(res.structuredContent!.status, "COMPLETED");
    assert.deepEqual(Object.keys(res.structuredContent!.outputs as object).sort(), ["t0", "t1", "t2"]);
    const pay = res.structuredContent!.payment as { capAtomic: number; realizedAtomic: number; refundDueAtomic: number };
    assert.deepEqual([pay.capAtomic, pay.realizedAtomic, pay.refundDueAtomic], [30000, 6000, 24000]);

    const st = await call(client, "get_status", { jobId });
    assert.deepEqual(st.structuredContent!.tasks, { total: 3, accepted: 3, running: 0, ready: 0, waiting: 0, failed: 0 });
  }));

test("aynı ödeme yükünün tekrarı reddedilir; geçersiz ödeme nedeniyle PaymentRequired döner", () =>
  withMcp(async ({ s, client }) => {
    const pr = (await call(client, "submit_workflow", { dag: dag(1) })).structuredContent!;
    const meta = { [PAYMENT_META_KEY]: payloadFrom(pr, "TX_ONCE") };
    assert.ok(!(await call(client, "submit_workflow", { dag: dag(1) }, meta)).isError);
    const again = await call(client, "submit_workflow", { dag: dag(1) }, meta);
    assert.equal(again.isError, true);
    const bad = await call(client, "submit_workflow", { dag: dag(1) }, { [PAYMENT_META_KEY]: payloadFrom(pr, "BAD") });
    assert.equal(bad.isError, true);
    assert.match(String(bad.structuredContent!.error ?? ""), /simulation_failed/);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 1);
  }));

test("geçersiz DAG: ödeme istenmeden hata", () =>
  withMcp(async ({ client }) => {
    const r = await call(client, "submit_workflow", { dag: { version: 0, tasks: [{ id: "a", module: "yok", input: {} }] } });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent, undefined, "PaymentRequired değil, düz hata");
  }));

test("get_result MCP Tasks ile: görev oluşur, tasks/get ile yoklanır, tasks/result ile sonuç alınır", () =>
  withMcp(async ({ client }) => {
    const sub = await call(client, "submit_workflow", { dag: dag(2), verifier: "accept_first" });
    const jobId = sub.structuredContent!.jobId as string;
    const created = await client.request(
      { method: "tools/call", params: { name: "get_result", arguments: { jobId }, task: { ttl: 60000 } } },
      CreateTaskResultSchema,
    );
    const taskId = created.task.taskId;
    let status = created.task.status;
    const end = Date.now() + 10000;
    while (status === "working" && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 30));
      status = (await client.experimental.tasks.getTask(taskId)).status;
    }
    assert.equal(status, "completed");
    const res = await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema);
    assert.equal((res.structuredContent as { status: string }).status, "COMPLETED");
  }, false));

test("ödeme kapalı koordinatörde submit_workflow ödemesiz çalışır", () =>
  withMcp(async ({ client }) => {
    const r = await call(client, "submit_workflow", { dag: dag(1) });
    assert.ok(!r.isError);
    assert.match(String(r.structuredContent!.jobId), /^job_/);
    assert.equal(r._meta?.[PAYMENT_RESPONSE_META_KEY], undefined);
  }, false));

test("uçtan uca senaryo (10.3): MCP istemcisi teklif alır, x402 ile öder, sonucu Tasks ile alır; worker ödemeleri ve iade zincire gider", async () => {
  const sent: { to: string; amountAtomic: number }[][] = [];
  const chain = {
    async sign(t: { to: string; amountAtomic: number }[]) { sent.push(t); return { signature: `PAYOUT${sent.length}`, blockhash: "B", lastValidBlockHeight: 1, send: async () => {} }; },
    async status() { return { status: "confirmed" as const }; },
  };
  const s = await createServer({ config: FAST, oracle: jsOracle, payments: { payTo: PAY_TO, facilitatorUrl: fac.url }, payouts: { chain, pollMs: 1 } });
  const mcp = createMcpServer({ baseUrl: s.url, pollMs: 20 });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await mcp.connect(st);
  const client = new Client({ name: "ajan", version: "1" }, { capabilities: {} });
  await client.connect(ct);
  const W1 = "8fG4mWUr2cMrcVrMRD1pSodKSffekd5a4Zj7EBm5XiiY", W2 = "2wmVCSfPxGPjrnMMn7rchp4uaeoTqN39mXFC2zhPdri9";
  const w1 = startFakeWorker(s.wsUrl, { wallet: W1 }), w2 = startFakeWorker(s.wsUrl, { wallet: W2 });
  const lines: string[] = [];
  try {
    await Promise.all([w1.id, w2.id]);
    const out = await runScenario(client, {
      dag: dag(4), verifier: "fixed2", maxAtomic: 100_000, pollMs: 20, payoutWaitMs: 5000, log: (l) => lines.push(l),
      pay: async (pr) => ({ x402Version: 2, resource: pr.resource, accepted: pr.accepts[0], payload: { transaction: "TX_E2E" } }),
    });
    assert.equal(out.status, "COMPLETED");
    assert.equal(out.settle?.transaction, "SIG_TX_E2E");
    const p = out.payment as { capAtomic: number; realizedAtomic: number; refundDueAtomic: number; payouts: { kind: string; amountAtomic: number; status: string }[] };
    assert.deepEqual([p.capAtomic, p.realizedAtomic, p.refundDueAtomic], [40000, 8000, 32000]);
    assert.equal(p.payouts.length, 3);
    assert.ok(p.payouts.every((x) => x.status === "confirmed"));
    assert.equal(p.payouts.reduce((n, x) => n + x.amountAtomic, 0), 40000);
    assert.deepEqual(sent[0].map((t) => t.to).sort(), [W1, W2, FAKE_BUYER].sort());
    assert.ok(lines.some((l) => l.startsWith("Ödeme gerekli")) && lines.some((l) => l.startsWith("İş gönderildi")));
  } finally {
    w1.close(); w2.close();
    await client.close(); await mcp.close(); await s.close();
  }
});

test("senaryo: üst sınır bütçeyi aşarsa ödeme yapılmaz", () =>
  withMcp(async ({ s, client }) => {
    let paid = false;
    await assert.rejects(
      runScenario(client, { dag: dag(7), verifier: "adaptive", maxAtomic: 10_000, pay: async () => { paid = true; return {}; } }),
      /bütçeyi aşıyor/,
    );
    assert.equal(paid, false);
    assert.equal(s.db.all("SELECT COUNT(*) AS n FROM jobs")[0].n, 0);
  }));
