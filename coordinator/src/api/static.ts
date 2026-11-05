import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { REPO_ROOT } from "../config.ts";

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  wasm: "application/wasm",
  json: "application/json; charset=utf-8",
};

// Yalnızca bu desenler sunulur: kökteki .html/.js dosyaları ve pkg/ altındaki wasm-pack çıktısı.
// Dizin gezintisi ("..") ve kaynak kod (src/, coordinator/, .git) dışarı açılmaz.
const ALLOWED = /^\/(?:[A-Za-z0-9_-]+\.(?:html|js)|pkg\/[A-Za-z0-9_.-]+\.(?:js|wasm))$/;

/**
 * Gönüllü sayfasını koordinatörle aynı adresten sunar; böylece telefon tek bir adres açar
 * (`/` → volunteer.html). Dosya sunulduysa true döner.
 */
export async function serveStatic(pathname: string, res: ServerResponse): Promise<boolean> {
  const path = pathname === "/" ? "/volunteer.html" : pathname;
  if (!ALLOWED.test(path)) return false;
  let body: Buffer;
  try {
    body = await readFile(join(REPO_ROOT, path));
  } catch {
    return false;
  }
  const ext = path.slice(path.lastIndexOf(".") + 1);
  res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
  res.end(body);
  return true;
}
