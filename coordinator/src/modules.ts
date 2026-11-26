import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, readShared } from "./config.ts";

/**
 * Modül kaydı (8. hafta, ROADMAP karar kaydı 2026-11-23).
 *
 * Görev modülleri ayrı .wasm dosyaları değil, tek bir wasm-pack paketinin (pkg/vc_tasks_bg.wasm)
 * içindeki fonksiyonlardır; bu yüzden bir modülün özeti paketin SHA-256 özetidir. Koordinatör
 * özeti başlangıçta bir kez hesaplar; gönderilen her görev o özete bağlanır (DAG'de `moduleHash`
 * verilmişse eşleşmek zorundadır, verilmemişse koordinatör doldurur) ve `assign` mesajıyla
 * worker'a gider. Worker paketi çalıştırmadan önce özeti denetler. Paket derlenmemişse
 * (yalnızca JS uygulamasıyla çalışma) özet `null` olur ve denetim yapılamaz.
 */

export const WASM_URL = "/pkg/vc_tasks_bg.wasm";
export const DEFAULT_WASM_PATH = join(REPO_ROOT, "pkg", "vc_tasks_bg.wasm");

export interface ModuleInfo {
  name: string;
  hash: string | null;
  url: string | null;
}

/** `sha256:<hex>` biçiminde paket özeti; dosya yoksa null. */
export function bundleHash(path: string = DEFAULT_WASM_PATH): string | null {
  if (!existsSync(path)) return null;
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

/** DAG şemasındaki modül adları (tek doğruluk kaynağı: shared/schemas/dag.v0.schema.json). */
export function moduleNames(): string[] {
  const schema = readShared<{ properties: { tasks: { items: { properties: { module: { enum: string[] } } } } } }>(
    "schemas/dag.v0.schema.json",
  );
  return schema.properties.tasks.items.properties.module.enum;
}

export function moduleRegistry(hash: string | null): ModuleInfo[] {
  return moduleNames().map((name) => ({ name, hash, url: hash ? WASM_URL : null }));
}
