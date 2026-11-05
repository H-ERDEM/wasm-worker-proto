import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const SHARED_DIR = resolve(here, "../../shared");
/** Repo kökü: worker sayfaları (index.html, volunteer.html, *.js) ve wasm-pack çıktısı (pkg/) burada. */
export const REPO_ROOT = resolve(here, "../..");

export interface Config {
  scheduler: string;
  verifier: string;
  heartbeatMs: number;
  missedHeartbeats: number;
  taskTimeoutMs: number;
  maxReplicas: number;
  reputation: { tau: number; alphaMin: number; lambda: number; w: number };
  spotCheckRate: number;
  unitPrice: number;
}

export function readShared<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(resolve(SHARED_DIR, rel), "utf8")) as T;
}

/** shared/config/default.json + isteğe bağlı üzerine yazmalar (testler ve deneyler için). */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const base = readShared<Config>("config/default.json");
  return { ...base, ...overrides };
}
