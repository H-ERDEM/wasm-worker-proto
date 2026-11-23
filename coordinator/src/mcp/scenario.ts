/**
 * Uçtan uca senaryo (10.3): bir MCP istemcisi (ajan) iş satın alır ve sonucunu alır.
 *   list_modules → get_quote → bütçe denetimi → submit_workflow (402 → x402 ödemesi → iş)
 *   → get_result (MCP Tasks; ilerleme get_status ile) → çıktılar, defter ve worker ödemeleri.
 *
 * Ödeme yükünü üreten fonksiyon dışarıdan verilir: gerçek ortamda Devnet anahtarıyla x402Client
 * (cli/mcp-agent.ts), testlerde sahte yük. Hafta 11'deki ajan aynı akışı kullanacak.
 */
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema, CreateTaskResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PAYMENT_META_KEY, PAYMENT_RESPONSE_META_KEY } from "./server.ts";

export type PaymentRequired = { x402Version: number; error?: string; resource: unknown; accepts: { amount: string; network: string; asset: string; payTo: string }[] };
export type PayFn = (pr: PaymentRequired) => Promise<unknown>;

export interface ScenarioOptions {
  dag: unknown;
  verifier?: string;
  scheduler?: string;
  /** Bütçe (atomik USDC). Üst sınır bunu aşarsa ödeme yapılmaz. */
  maxAtomic: number;
  pay: PayFn;
  log?: (line: string) => void;
  pollMs?: number;
  /** İş bittikten sonra worker ödemelerinin sonuçlanmasını en fazla bu kadar bekle (ms). */
  payoutWaitMs?: number;
}

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[]; _meta?: Record<string, unknown> };

export async function runScenario(client: Client, o: ScenarioOptions) {
  const log = o.log ?? (() => {});
  const pollMs = o.pollMs ?? 1000;
  const strat = { ...(o.verifier ? { verifier: o.verifier } : {}), ...(o.scheduler ? { scheduler: o.scheduler } : {}) };
  const call = async (name: string, args: Record<string, unknown>, meta?: Record<string, unknown>) =>
    (await client.callTool({ name, arguments: args, ...(meta ? { _meta: meta } : {}) })) as unknown as ToolResult;
  const errText = (r: ToolResult) => r.content.map((c) => c.text ?? "").join(" ");

  const mods = await call("list_modules", {});
  log(`Modüller: ${(mods.structuredContent!.modules as { name: string }[]).map((m) => m.name).join(", ")}`);

  const q = await call("get_quote", { dag: o.dag, ...strat });
  if (q.isError) throw new Error(errText(q));
  const quote = q.structuredContent!.quote as { cap: string; capAtomic: number; tasks: number; verifier: string };
  log(`Teklif: ${quote.tasks} görev, ${quote.verifier}, üst sınır ${quote.cap} USDC (bütçe ${o.maxAtomic / 1e6} USDC)`);
  if (quote.capAtomic > o.maxAtomic) throw new Error(`üst sınır (${quote.cap} USDC) bütçeyi aşıyor; ödeme yapılmadı`);

  let sub = await call("submit_workflow", { dag: o.dag, ...strat });
  type Settle = { transaction?: string; payer?: string };
  let settle: Settle | null = null;
  if (sub.isError && sub.structuredContent?.accepts) {
    const pr = sub.structuredContent as unknown as PaymentRequired;
    const a = pr.accepts[0];
    log(`Ödeme gerekli: ${Number(a.amount) / 1e6} USDC → ${a.payTo} (${a.network})`);
    if (Number(a.amount) > o.maxAtomic) throw new Error("istenen tutar bütçeyi aşıyor; ödeme yapılmadı");
    const payload = await o.pay(pr);
    log("Ödeme imzalandı; araç _meta[\"x402/payment\"] ile yeniden çağrılıyor");
    sub = await call("submit_workflow", { dag: o.dag, ...strat }, { [PAYMENT_META_KEY]: payload });
    settle = (sub._meta?.[PAYMENT_RESPONSE_META_KEY] as Settle | undefined) ?? null;
  }
  if (sub.isError) throw new Error(`iş gönderilemedi: ${errText(sub)}`);
  const jobId = sub.structuredContent!.jobId as string;
  log(`İş gönderildi: ${jobId}` + (settle?.transaction ? ` · ödeme ${settle.transaction}` : ""));

  // Sonuç MCP Tasks ile: görev oluşur, durum get_status ile izlenir.
  const created = await client.request(
    { method: "tools/call", params: { name: "get_result", arguments: { jobId }, task: { ttl: 30 * 60_000 } } },
    CreateTaskResultSchema,
  );
  const taskId = created.task.taskId;
  let status = created.task.status;
  let last = "";
  while (status === "working") {
    await new Promise((r) => setTimeout(r, pollMs));
    status = (await client.experimental.tasks.getTask(taskId)).status;
    const s = (await call("get_status", { jobId })).structuredContent as { tasks: { accepted: number; total: number } };
    const line = `  ${s.tasks.accepted}/${s.tasks.total} görev kabul edildi`;
    if (line !== last) log((last = line));
  }
  const result = (await client.experimental.tasks.getTaskResult(taskId, CallToolResultSchema)) as unknown as ToolResult;
  const res = result.structuredContent as { status: string; outputs: Record<string, unknown>; payment: Record<string, unknown> | null };
  log(`İş ${res.status === "COMPLETED" ? "tamamlandı" : "başarısız"} (görev durumu: ${status})`);

  // Worker ödemeleri ve iade iş kesinleşince planlanır; sonuçlanmalarını kısa bir süre bekle.
  let payment = res.payment;
  const until = Date.now() + (o.payoutWaitMs ?? 0);
  const done = (p: Record<string, unknown> | null) =>
    !!p && Array.isArray(p.payouts) && p.payouts.length > 0 && (p.payouts as { status: string }[]).every((x) => x.status !== "sent" && x.status !== "pending");
  while (payment && !done(payment) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, pollMs));
    payment = ((await call("get_status", { jobId })).structuredContent as { payment: Record<string, unknown> | null }).payment;
  }
  return { jobId, quote, settle: settle as Settle | null, status: res.status, outputs: res.outputs, payment };
}
