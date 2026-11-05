import type { IncomingMessage, ServerResponse } from "node:http";
import type { Coordinator } from "../coordinator.ts";
import { DagError } from "../queue/dag.ts";
import { serveStatic } from "./static.ts";

const MAX_BODY = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type",
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
 * HTTP API (henüz ödemesiz; x402 ara katmanı 8. aşamada bu yolların önüne eklenir).
 *   GET  /health
 *   POST /jobs        gövde: DAG v0  → 201 { jobId }
 *   GET  /jobs/:id
 *   GET  /workers
 *   GET  /, /*.html, /*.js, /pkg/*   gönüllü sayfası ve WASM (static.ts)
 */
export function httpHandler(coord: Coordinator) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "OPTIONS") return send(res, 204, null);
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/workers") return send(res, 200, coord.listWorkers());
      if (req.method === "POST" && url.pathname === "/jobs") {
        let dag: unknown;
        try {
          dag = JSON.parse(await readBody(req));
        } catch (e) {
          return send(res, 400, { error: e instanceof Error ? e.message : "geçersiz JSON" });
        }
        try {
          return send(res, 201, coord.submitJob(dag));
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
