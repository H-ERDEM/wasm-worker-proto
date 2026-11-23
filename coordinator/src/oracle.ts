import { randomInt, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runJs } from "../../js-baseline.js";
import { REPO_ROOT } from "./config.ts";
import { canonicalJson } from "./queue/dag.ts";

/**
 * Sınama işi kâhini (9. hafta, Kapsam v3 §5).
 *
 * Sınama işi, worker'a atanacak gerçek görevle aynı modülü ve aynı boyut parametrelerini kullanır;
 * yalnızca tohum rastgele seçilir (aynı girdi boyutu dağılımı, aynı maliyet). Beklenen çıktıyı
 * koordinatör kendisi hesaplar: WASM paketi derlenmişse Node'da aynı WASM ile, değilse saf JS
 * uygulamasıyla (ikisi de vectors.js'e karşı denetlenir ve bit düzeyinde aynıdır).
 */

export type Runner = (module: string, inputJson: string) => string;

export interface Oracle {
  impl: "wasm" | "js";
  run: Runner;
}

export async function loadOracle(pkgDir: string = join(REPO_ROOT, "pkg")): Promise<Oracle> {
  const js = join(pkgDir, "vc_tasks.js");
  const wasm = join(pkgDir, "vc_tasks_bg.wasm");
  if (existsSync(js) && existsSync(wasm)) {
    const mod = (await import(pathToFileURL(js).href)) as { initSync: (o: { module: Buffer }) => void; run_task: Runner };
    mod.initSync({ module: readFileSync(wasm) });
    return { impl: "wasm", run: mod.run_task };
  }
  return { impl: "js", run: runJs };
}

export const jsOracle: Oracle = { impl: "js", run: runJs };

/**
 * Gerçek görevin çözülmüş girdisinden aynı boyutta, rastgele tohumlu bir sınama girdisi.
 * Sınama işi üretilemeyen modüller (debug_panic) için null.
 */
export function spotInput(module: string, inputResolved: string): string | null {
  const real = JSON.parse(inputResolved) as Record<string, unknown>;
  const u32 = () => randomInt(0, 2 ** 32);
  switch (module) {
    case "sha_chain":
      return canonicalJson({ ...real, seed: `spot-${randomUUID()}` });
    case "matmul":
    case "image_blur":
      return canonicalJson({ ...real, seed: u32() });
    default:
      return null;
  }
}
