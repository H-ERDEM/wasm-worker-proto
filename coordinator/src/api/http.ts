import type { IncomingMessage, ServerResponse } from "node:http";
import type { Coordinator } from "../coordinator.ts";
import { DagError } from "../queue/dag.ts";
import { jobOptionsFrom, type JobPayments } from "./payments.ts";
import { serveStatic } from "./static.ts";

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
 */
export function httpHandler(coord: Coordinator, payments: JobPayments | null = null) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/workers") return send(res, 200, coord.listWorkers());
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
