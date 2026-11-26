/**
 * MCP sunucusu (10. hafta, 10.2): platformu dış yapay zekâ ajanlarına açar.
 *
 * HTTP API'nin üstünde ince bir adaptördür; koordinatöre yeni mantık eklemez. Ödeme x402 v2'nin
 * MCP taşıma biçimiyle (specs/transports-v2/mcp.md) taşınır ve olduğu gibi HTTP'ye çevrilir:
 *   - ödeme gerekiyorsa araç sonucu `isError: true` + `structuredContent` = PaymentRequired
 *     (HTTP 402'deki PAYMENT-REQUIRED başlığının içeriği);
 *   - istemci aynı çağrıyı `_meta["x402/payment"]` = PaymentPayload ile tekrarlar → adaptör bunu
 *     PAYMENT-SIGNATURE başlığı olarak POST /jobs'a iletir;
 *   - başarıda kesinleşme bilgisi `_meta["x402/payment-response"]` = SettlementResponse.
 * Böylece üst sınır + iade kurgusu, DAG doğrulaması ve tekrar koruması HTTP yoluyla aynı kalır.
 *
 * Araçlar: list_modules, get_quote, submit_workflow (ücretli), get_status, get_result
 * (MCP Tasks: taskSupport "optional"; görev isteği olmadan çağrılırsa iş bitene kadar bekler).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTaskStore } from "@modelcontextprotocol/sdk/experimental/tasks/stores/in-memory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { z } from "zod";

export const PAYMENT_META_KEY = "x402/payment";
export const PAYMENT_RESPONSE_META_KEY = "x402/payment-response";

export interface McpAdapterOptions {
  /** Koordinatörün HTTP adresi, ör. http://127.0.0.1:8787 */
  baseUrl: string;
  /** İş bitişini yoklama aralığı (ms). */
  pollMs?: number;
}

const VERIFIERS = ["fixed2", "fixed3", "adaptive", "accept_first"] as const;
const SCHEDULERS = ["fifo", "fastest", "reputation"] as const;

const DAG_HELP =
  "DAG v0 (JSON): { version: 0, jobId?: string, tasks: [{ id, module, input, deps? }] }. " +
  "Modüller: sha_chain {seed: string, iterations: int}, matmul {seed: int, n: int}, image_blur {seed: int, w: int, h: int, passes: int}. " +
  "Bir görevin girdisi üst görevin çıktısına {\"$ref\": \"<id>.output.hash\"} ile bağlanır; o görev deps içinde olmalı.";

const dagSchema = z.object({
  version: z.literal(0),
  jobId: z.string().optional(),
  tasks: z.array(z.object({
    id: z.string(),
    module: z.string(),
    input: z.record(z.string(), z.unknown()),
    deps: z.array(z.string()).optional(),
    moduleHash: z.string().optional(),
    cost: z.number().optional(),
  }).passthrough()).min(1),
}).passthrough();

const strategyShape = {
  verifier: z.enum(VERIFIERS).optional().describe("Doğrulama: adaptive (itibar + sınama işi), fixed2, fixed3, accept_first (doğrulamasız taban). Varsayılan: koordinatörünki"),
  scheduler: z.enum(SCHEDULERS).optional().describe("Zamanlama: fifo, fastest, reputation. Varsayılan: koordinatörünki"),
};

function query(args: { verifier?: string; scheduler?: string }): string {
  const q = new URLSearchParams();
  if (args.scheduler) q.set("scheduler", args.scheduler);
  if (args.verifier) q.set("verifier", args.verifier);
  return q.size ? `?${q}` : "";
}

const text = (t: string) => ({ type: "text" as const, text: t });
function ok(structured: Record<string, unknown>, summary: string, meta?: Record<string, unknown>): CallToolResult {
  return { content: [text(summary), text(JSON.stringify(structured))], structuredContent: structured, ...(meta ? { _meta: meta } : {}) };
}
function fail(message: string, structured?: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [text(structured ? JSON.stringify(structured) : message)], ...(structured ? { structuredContent: structured } : {}) };
}

interface JobView {
  jobId: string;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  verifier: string;
  scheduler: string;
  submittedAt: number;
  completedAt: number | null;
  spotchecks: number;
  payment: Record<string, unknown> | null;
  tasks: { id: string; module: string; state: string; output: unknown; replicas: number; agreeing: number; single: boolean }[];
}

function statusOf(job: JobView) {
  const count = (s: string) => job.tasks.filter((t) => t.state === s).length;
  return {
    jobId: job.jobId, status: job.status, verifier: job.verifier, scheduler: job.scheduler,
    tasks: { total: job.tasks.length, accepted: count("ACCEPTED"), running: count("RUNNING"), ready: count("READY"), waiting: count("WAITING"), failed: count("FAILED") },
    spotchecks: job.spotchecks,
    elapsedMs: (job.completedAt ?? Date.now()) - job.submittedAt,
    payment: job.payment,
  };
}

function resultOf(job: JobView) {
  return {
    ...statusOf(job),
    outputs: Object.fromEntries(job.tasks.map((t) => [t.id, t.output])),
    verification: Object.fromEntries(job.tasks.map((t) => [t.id, t.single ? "tek kopya (güvenilir worker)" : `${t.agreeing} eşleşen kopya`])),
  };
}

export function createMcpServer(opts: McpAdapterOptions): McpServer {
  const base = opts.baseUrl.replace(/\/$/, "");
  const pollMs = opts.pollMs ?? 500;
  const getJob = async (jobId: string): Promise<JobView | null> => {
    const r = await fetch(`${base}/jobs/${encodeURIComponent(jobId)}`);
    return r.status === 404 ? null : ((await r.json()) as JobView);
  };

  const taskStore = new InMemoryTaskStore();
  const server = new McpServer(
    { name: "gonullu-hesaplama", version: "0.10.0" },
    {
      capabilities: { tools: {}, tasks: { requests: { tools: { call: {} } } } },
      taskStore,
      instructions:
        "Tarayıcı tabanlı gönüllü hesaplama platformu. Akış: list_modules → get_quote → submit_workflow (x402 ile ödenir; " +
        "ilk çağrı ödeme koşullarını döner, aynı çağrıyı _meta[\"x402/payment\"] ile tekrarlayın) → get_status / get_result. " +
        "Alıcı üst sınırı öder; iş bitince gerçekleşen maliyetin fazlası iade edilir. Devnet, test USDC.",
    },
  );

  server.registerTool("list_modules", {
    title: "Görev modülleri",
    description: "Kullanılabilir WASM görev modülleri, özetleri ve örnek DAG'ler. " + DAG_HELP,
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => {
    const [mods, examples] = await Promise.all([
      fetch(`${base}/modules`).then((r) => r.json()),
      fetch(`${base}/examples`).then((r) => (r.ok ? r.json() : [])),
    ]);
    return ok({ ...(mods as object), examples, dagFormat: DAG_HELP }, `${(mods as { modules: unknown[] }).modules.length} modül; ${(examples as unknown[]).length} örnek DAG`);
  });

  server.registerTool("get_quote", {
    title: "Fiyat teklifi",
    description: "Bir DAG için ödenecek üst sınırı (USDC) ve ödeme bilgisini döndürür; iş oluşturmaz, ödeme istemez. " + DAG_HELP,
    inputSchema: { dag: dagSchema.describe("DAG v0"), ...strategyShape },
    annotations: { readOnlyHint: true },
  }, async (args) => {
    const r = await fetch(`${base}/quote${query(args)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args.dag) });
    const out = (await r.json()) as { quote?: { cap: string; tasks: number; verifier: string }; payment?: unknown; error?: string };
    if (!r.ok) return fail(`teklif alınamadı: ${out.error}`);
    return ok(out as Record<string, unknown>, `Üst sınır ${out.quote!.cap} USDC (${out.quote!.tasks} görev, ${out.quote!.verifier}); fark iş bitince iade edilir`);
  });

  server.registerTool("submit_workflow", {
    title: "İş gönder (ücretli)",
    description:
      "DAG'i gönüllü tarayıcılarda çalıştırmak üzere gönderir. Ödeme x402 (MCP taşıması) ile: ödemesiz çağrı " +
      "isError + PaymentRequired döner; aynı çağrıyı params._meta[\"x402/payment\"] = PaymentPayload ile tekrarlayın. " +
      "Başarıda iş kimliği döner ve kesinleşme bilgisi _meta[\"x402/payment-response\"] içindedir. " + DAG_HELP,
    inputSchema: { dag: dagSchema.describe("DAG v0"), ...strategyShape },
    annotations: { readOnlyHint: false, idempotentHint: false },
  }, async (args, extra) => {
    const payment = extra._meta?.[PAYMENT_META_KEY];
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (payment) {
      try {
        headers["PAYMENT-SIGNATURE"] = encodePaymentSignatureHeader(payment as Parameters<typeof encodePaymentSignatureHeader>[0]);
      } catch (e) {
        return fail(`geçersiz ödeme yükü: ${(e as Error).message}`);
      }
    }
    const r = await fetch(`${base}/jobs${query(args)}`, { method: "POST", headers, body: JSON.stringify(args.dag) });
    if (r.status === 402) {
      // Ödeme gerekli ya da geçersiz: PaymentRequired (neden `error` alanında) yapılandırılmış içerik olarak.
      const raw = r.headers.get("payment-required");
      if (raw) return fail("", decodePaymentRequiredHeader(raw) as unknown as Record<string, unknown>);
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      return fail(`ödeme kesinleşmedi: ${body.error ?? "bilinmeyen neden"}`);
    }
    const out = (await r.json()) as { jobId?: string; quote?: { cap: string }; payment?: unknown; error?: string };
    if (r.status !== 201) return fail(`iş gönderilemedi (${r.status}): ${out.error ?? ""}`);
    const settle = r.headers.get("payment-response");
    const meta = settle ? { [PAYMENT_RESPONSE_META_KEY]: decodePaymentResponseHeader(settle) } : undefined;
    return ok(out as Record<string, unknown>, `İş gönderildi: ${out.jobId}` + (out.quote ? ` (ödenen üst sınır ${out.quote.cap} USDC)` : " (ödemesiz)"), meta);
  });

  server.registerTool("get_status", {
    title: "İş durumu",
    description: "İşin anlık durumu: görev sayıları, geçen süre, ödeme defteri (ödenen, gerçekleşen, iade, worker ödemeleri).",
    inputSchema: { jobId: z.string() },
    annotations: { readOnlyHint: true },
  }, async ({ jobId }) => {
    const job = await getJob(jobId);
    if (!job) return fail(`iş bulunamadı: ${jobId}`);
    const s = statusOf(job);
    return ok(s, `${jobId}: ${s.status}, ${s.tasks.accepted}/${s.tasks.total} görev kabul edildi`);
  });

  server.experimental.tasks.registerToolTask("get_result", {
    title: "İş sonucu",
    description:
      "İş bitince görev çıktılarını ve doğrulama bilgisini döndürür. Uzun işler için MCP Tasks desteklenir (taskSupport: optional); " +
      "görev isteği olmadan çağrılırsa iş bitene kadar bekler.",
    inputSchema: { jobId: z.string() },
    execution: { taskSupport: "optional" },
    annotations: { readOnlyHint: true },
  }, {
    async createTask({ jobId }, { taskStore, taskRequestedTtl }) {
      const task = await taskStore.createTask({ ttl: taskRequestedTtl ?? 10 * 60_000, pollInterval: pollMs });
      void (async () => {
        try {
          for (;;) {
            const job = await getJob(jobId);
            if (!job) {
              await taskStore.storeTaskResult(task.taskId, "failed", fail(`iş bulunamadı: ${jobId}`));
              return;
            }
            if (job.status !== "RUNNING") {
              const res = resultOf(job);
              await taskStore.storeTaskResult(task.taskId, job.status === "COMPLETED" ? "completed" : "failed",
                job.status === "COMPLETED" ? ok(res, `${jobId} tamamlandı: ${job.tasks.length} görev`) : fail(`${jobId} başarısız`, res));
              return;
            }
            const t = await taskStore.getTask(task.taskId);
            if (!t || t.status === "cancelled") return; // istemci beklemeyi iptal etti (iş sürer)
            await new Promise((r) => setTimeout(r, pollMs));
          }
        } catch (e) {
          await taskStore.storeTaskResult(task.taskId, "failed", fail(String(e))).catch(() => {});
        }
      })();
      return { task };
    },
    async getTask(_args, { taskId, taskStore }) {
      return (await taskStore.getTask(taskId))!;
    },
    async getTaskResult(_args, { taskId, taskStore }) {
      return (await taskStore.getTaskResult(taskId)) as CallToolResult;
    },
  });

  // Kapanışta görev deposunun TTL zamanlayıcıları da temizlenir (süreç açık kalmasın).
  const close = server.close.bind(server);
  server.close = async () => {
    taskStore.cleanup();
    await close();
  };
  return server;
}
