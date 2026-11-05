import { Ajv } from "ajv";
import { readShared } from "../config.ts";

export interface DagTask {
  id: string;
  module: string;
  moduleHash?: string;
  input: Record<string, unknown>;
  cost?: number;
  deps?: string[];
}
export interface Dag {
  version: 0;
  jobId?: string;
  tasks: DagTask[];
}

const ajv = new Ajv({ allErrors: true });
const validateSchema = ajv.compile(readShared("schemas/dag.v0.schema.json"));

export class DagError extends Error {}

/** `{ "$ref": "t1.output.hash" }` biçimindeki referansları bulur. */
function collectRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => collectRefs(v, out));
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (typeof obj.$ref === "string" && Object.keys(obj).length === 1) out.push(obj.$ref);
    else Object.values(obj).forEach((v) => collectRefs(v, out));
  }
  return out;
}

function parseRef(ref: string): { taskId: string; path: string[] } {
  const [taskId, kind, ...path] = ref.split(".");
  if (!taskId || kind !== "output") throw new DagError(`geçersiz $ref "${ref}" (beklenen: <görev>.output[.<alan>...])`);
  return { taskId, path };
}

/**
 * Şema + anlamsal doğrulama: benzersiz kimlikler, var olan bağımlılıklar,
 * $ref yalnızca deps içindeki görevlere, döngü yok. Topolojik sırayı döndürür.
 */
export function validateDag(dag: unknown): { dag: Dag; order: string[] } {
  if (!validateSchema(dag)) {
    const msg = (validateSchema.errors ?? []).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    throw new DagError(`şema hatası: ${msg}`);
  }
  const d = dag as Dag;
  const ids = new Set<string>();
  for (const t of d.tasks) {
    if (ids.has(t.id)) throw new DagError(`yinelenen görev kimliği "${t.id}"`);
    ids.add(t.id);
  }
  for (const t of d.tasks) {
    const deps = t.deps ?? [];
    for (const dep of deps) {
      if (!ids.has(dep)) throw new DagError(`"${t.id}" bilinmeyen bağımlılık "${dep}"`);
      if (dep === t.id) throw new DagError(`"${t.id}" kendine bağımlı`);
    }
    for (const ref of collectRefs(t.input)) {
      const { taskId } = parseRef(ref);
      if (!deps.includes(taskId)) throw new DagError(`"${t.id}" içindeki $ref "${ref}" deps içinde olmayan bir göreve işaret ediyor`);
    }
  }
  // Kahn algoritması
  const indeg = new Map(d.tasks.map((t) => [t.id, (t.deps ?? []).length]));
  const children = new Map<string, string[]>(d.tasks.map((t) => [t.id, []]));
  for (const t of d.tasks) for (const dep of t.deps ?? []) children.get(dep)!.push(t.id);
  const queue = d.tasks.filter((t) => indeg.get(t.id) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) queue.push(c);
    }
  }
  if (order.length !== d.tasks.length) throw new DagError("bağımlılıklarda döngü var");
  return { dag: d, order };
}

/** Görev maliyeti (işlem sayısı): sha_chain → iterations, matmul → n³. */
export function taskCost(t: DagTask): number {
  if (typeof t.cost === "number") return t.cost;
  const inp = t.input as Record<string, unknown>;
  if (t.module === "sha_chain" && typeof inp.iterations === "number") return inp.iterations;
  if (t.module === "matmul" && typeof inp.n === "number") return inp.n ** 3;
  return 1;
}

/** $ref'leri kabul edilmiş üst görev çıktılarıyla değiştirir. Çıktılar kanonik JSON dizgisidir. */
export function resolveRefs(input: unknown, accepted: Map<string, string>): unknown {
  if (Array.isArray(input)) return input.map((v) => resolveRefs(v, accepted));
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (typeof obj.$ref === "string" && Object.keys(obj).length === 1) {
      const { taskId, path } = parseRef(obj.$ref);
      const raw = accepted.get(taskId);
      if (raw === undefined) throw new DagError(`$ref "${obj.$ref}": "${taskId}" henüz kabul edilmedi`);
      let v: unknown = JSON.parse(raw);
      for (const key of path) {
        if (!v || typeof v !== "object" || !(key in (v as object))) throw new DagError(`$ref "${obj.$ref}": "${key}" alanı yok`);
        v = (v as Record<string, unknown>)[key];
      }
      return v;
    }
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveRefs(v, accepted)]));
  }
  return input;
}

/** Anahtarları sıralı, boşluksuz JSON (README'deki kanonik çıktı biçimiyle aynı). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
