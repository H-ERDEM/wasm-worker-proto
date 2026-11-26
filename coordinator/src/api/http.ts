import type { IncomingMessage, ServerResponse } from "node:http";
import type { Coordinator } from "../coordinator.ts";
import { DagError } from "../queue/dag.ts";
import { jobOptionsFrom, type JobPayments } from "./payments.ts";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { REPO_ROOT } from "../config.ts";
import type { DemoBuyer } from "./demo-buyer.ts";
import type { PayoutService } from "../payouts.ts";
import { serveStatic } from "./static.ts";

const EXAMPLES_DIR = join(REPO_ROOT, "shared", "examples");

/** Demo paneli: alıcı yalnızca aynı makineden (Mac'in kendisinden) çağrılabilir. */
function isLoopback(req: IncomingMessage): boolean {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, payment-signature, x-payment",
    "access-control-expose-headers": "payment-required, payment-response",
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("gövde çok büyük"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * HTTP API.
 *   GET  /health
 *   POST /quote       gövde: DAG v0  → 200 { quote, payment? }  (iş oluşturmaz, ödeme istemez)
 *   POST /jobs        gövde: DAG v0  → 201 { jobId, ... }
 *                     isteğe bağlı ?scheduler=fifo|fastest|reputation&verifier=fixed2|fixed3|adaptive|accept_first
 *                     Ödeme açıksa (payments.ts) x402 ile üst sınır ödenir: ödemesiz istek 402.
 *   GET  /jobs/:id
 *   GET  /workers
 *   GET  /modules     { bundleHash, modules: [{ name, hash, url }] }  (ajan ve istemciler için)
 *   GET  /, /*.html, /*.js, /pkg/*   gönüllü sayfası ve WASM (static.ts)
 * Demo paneli (ara demo):
 *   GET  /panel                 panel.html
 *   GET  /examples, /examples/:ad   shared/examples altındaki örnek DAG'ler
 *   GET  /events?since=<id>     koordinatör olay kaydı (log tablosu), en fazla 200 satır
 *   GET  /demo/info             ödeme ve alıcı bilgisi
 *   POST /demo/buy?verifier=&scheduler=&maxUsdc=   gövde: DAG v0; alıcı x402 ile öder (yalnızca aynı makineden)
 */
export function httpHandler(coord: Coordinator, payments: JobPayments | null = null, demo: { buyer: DemoBuyer | null; listensOnAll?: boolean; payouts?: PayoutService | null } = { buyer: null }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/workers") return send(res, 200, coord.listWorkers());
      if (req.method === "GET" && url.pathname === "/panel" && (await serveStatic("/panel.html", res))) return;
      if (req.method === "GET" && url.pathname === "/examples") {
        const files = (await readdir(EXAMPLES_DIR)).filter((f) => f.endsWith(".json")).sort();
        const list = await Promise.all(files.map(async (f) => {
          const dag = JSON.parse(await readFile(join(EXAMPLES_DIR, f), "utf8")) as { jobId?: string; tasks: unknown[] };
          return { name: f.replace(/\.json$/, ""), jobId: dag.jobId ?? null, tasks: dag.tasks.length };
        }));
        return send(res, 200, list);
      }
      const ex = url.pathname.match(/^\/examples\/([A-Za-z0-9_-]+)$/);
      if (req.method === "GET" && ex) {
        try {
          return send(res, 200, JSON.parse(await readFile(join(EXAMPLES_DIR, `${ex[1]}.json`), "utf8")));
        } catch {
          return send(res, 404, { error: "örnek bulunamadı" });
        }
      }
      if (req.method === "GET" && url.pathname === "/events") {
        const since = Number(url.searchParams.get("since") ?? 0) || 0;
        const rows = coord.db.all("SELECT rowid AS id, t, level, event, detail FROM log WHERE rowid > ? ORDER BY rowid LIMIT 200", since);
        return send(res, 200, rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(String(r.detail)) : null })));
      }
      if (req.method === "GET" && url.pathname === "/demo/info") {
        // Telefonun açacağı adresler: koordinatör HOST=0.0.0.0 ile açıldıysa yerel ağ IPv4 adresleri.
        const port = req.socket.localPort;
        const lan = Object.values(networkInterfaces()).flat()
          .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => `http://${i!.address}:${port}/`);
        return send(res, 200, {
          payment: payments?.paymentInfo() ?? null, buyer: demo.buyer?.address ?? null, buyerAvailable: !!demo.buyer && isLoopback(req),
          volunteerUrls: demo.listensOnAll ? lan : [],
        });
      }
      if (req.method === "POST" && url.pathname === "/demo/buy") {
        if (!demo.buyer) return send(res, 409, { error: "demo alıcısı kapalı (PAYMENTS=1 ve BUYER_PRIVATE_KEY gerekli)" });
        if (!isLoopback(req)) return send(res, 403, { error: "demo alıcısı yalnızca koordinatörün çalıştığı makineden kullanılabilir" });
        let dag: unknown;
        try {
          dag = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : "geçersiz JSON" });
        }
        const q = new URLSearchParams();
        for (const k of ["scheduler", "verifier"]) {
          const v = url.searchParams.get(k);
          if (v) q.set(k, v);
        }
        q.set("source", "panel");
        const maxUsdc = Number(url.searchParams.get("maxUsdc") ?? 1);
        if (!(maxUsdc > 0)) return send(res, 400, { error: "geçersiz bütçe" });
        const r = await demo.buyer.buy(dag, q.size ? `?${q}` : "", BigInt(Math.round(maxUsdc * 1e6)));
        return send(res, r.ok ? 201 : r.status, r);
      }
      if (req.method === "GET" && url.pathname === "/modules") {
        return send(res, 200, { bundleHash: coord.wasmHash, modules: coord.modules });
      }
      if (req.method === "POST" && (url.pathname === "/jobs" || url.pathname === "/quote")) {
        let dag: unknown;
        try {
          dag = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : "geçersiz JSON" });
        }
        try {
          if (url.pathname === "/quote") {
            return send(res, 200, { quote: coord.quote(dag, jobOptionsFrom(url)), payment: payments?.paymentInfo() ?? null });
          }
          if (!payments) return send(res, 201, coord.submitJob(dag, jobOptionsFrom(url)));
          const r = await payments.submit(req, url, dag);
          if (r.kind === "respond") return send(res, r.status, r.body, r.headers);
          return send(res, 201, { jobId: r.jobId, quote: r.quote, payment: { transaction: r.transaction, payer: r.payer } }, r.headers);
        } catch (e) {
          if (e instanceof DagError) return send(res, 400, { error: e.message });
          throw e;
        }
      }
      const m = url.pathname.match(/^\/jobs\/([A-Za-z0-9_-]+)$/);
      if (req.method === "GET" && m) {
        const job = coord.getJob(m[1]);
        if (job?.payment && demo.payouts) Object.assign(job.payment, { payouts: demo.payouts.forJob(job.jobId) });
        return job ? send(res, 200, job) : send(res, 404, { error: "iş bulunamadı" });
      }
      if (req.method === "GET" && (await serveStatic(url.pathname, res))) return;
      send(res, 404, { error: "bulunamadı" });
    } catch (e) {
      coord.db.log("error", "http_error", { path: url.pathname, message: String(e) });
      send(res, 500, { error: "sunucu hatası" });
    }
  };
}
