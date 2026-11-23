import { score } from "./reputation.ts";

/**
 * Strateji arayüzleri. Simülatördeki (sim/vcsim/strategies/base.py) arayüzlerle bire bir aynı
 * anlamı taşır.
 *
 * 8. hafta genişletmesi (docs/ROADMAP.md karar kaydı, 2026-11-23): `Verifier.onAssign` bir kopya
 * bir worker'a atandığı anda çağrılır; kopya sayısının görevi alan worker'a bağlı olduğu
 * stratejiler (uyarlanabilir) kararı burada verir. `extra` kadar ek kopya hemen kuyruğa girer;
 * `aloneOk` kopyaya anlık görüntü olarak yazılır. Sınama işleri ve geriye dönük iptal
 * koordinatörün işidir; doğrulayıcı yalnızca `usesSpotChecks` ile açar.
 * Stratejiler sim/vcsim/strategies/__init__.py ile birebir aynıdır; ikisi de
 * shared/test/strategy-scenarios.json'daki ortak senaryoları geçer (9. hafta).
 */

export interface WorkerView {
  id: string;
  /** Normalize hız tahmini (cost / ms), henüz ölçülmediyse null. */
  speedEma: number | null;
  alpha: number;
  beta: number;
  /** Tek kopya koşulu (R ≥ τ, α ≥ α_min); koordinatör hesaplar. */
  trusted: boolean;
}

export interface ReplicaView {
  id: number;
  taskId: string;
  workerId: string | null;
  state: ReplicaState;
  output: string | null;
  fatal: boolean;
  /** Atama anındaki onAssign kararı: bu kopyanın sonucu tek başına kabul edilebilir mi. */
  aloneOk: boolean;
}

export type ReplicaState = "QUEUED" | "ASSIGNED" | "RETURNED_OK" | "RETURNED_ERROR" | "TIMED_OUT" | "LOST" | "CANCELLED";

export interface TaskView {
  key: string;
  module: string;
  cost: number;
}

export type Decision =
  | { kind: "accept"; output: string }
  | { kind: "needMore"; count: number }
  | { kind: "wait" }
  | { kind: "fail"; reason: string };

export interface AssignDecision {
  extra: number;
  aloneOk: boolean;
}

export interface Scheduler {
  readonly name: string;
  /** Kuyruğun başındaki kopya için boştaki worker'lardan birini seçer; uygun yoksa null. */
  pick(task: TaskView, idle: WorkerView[]): WorkerView | null;
}

export interface Verifier {
  readonly name: string;
  /** Koordinatör bu strateji için cevabı bilinen sınama işi üretsin mi (oran: spotCheckRate). */
  readonly usesSpotChecks: boolean;
  /** Görev HAZIR olduğunda kaç kopya üretileceği. */
  initialReplicas(task: TaskView): number;
  /** Kopya `worker`'a atandıktan hemen sonra; `replicas` bu kopyayı ASSIGNED olarak içerir. `u` ∈ [0, 1). */
  onAssign(task: TaskView, replicas: ReplicaView[], worker: WorkerView, u: number): AssignDecision;
  /** Bir kopya döndüğünde (ok ya da error) karar. Sonuçlanan kopyalar `replicas` içindedir. */
  onResult(task: TaskView, replicas: ReplicaView[]): Decision;
}

// ---------- Ortak yardımcılar ----------

const LIVE: ReadonlySet<ReplicaState> = new Set(["QUEUED", "ASSIGNED"]);
const ACTIVE: ReadonlySet<ReplicaState> = new Set(["QUEUED", "ASSIGNED", "RETURNED_OK"]);

/** En az `quorum` başarılı kopyanın verdiği çıktı; beraberlikte ilk ulaşan kazanır. */
export function agreeingOutput(replicas: ReplicaView[], quorum = 2): string | null {
  const counts = new Map<string, number>();
  for (const r of replicas) {
    if (r.state !== "RETURNED_OK" || r.output === null) continue;
    counts.set(r.output, (counts.get(r.output) ?? 0) + 1);
  }
  for (const [out, n] of counts) if (n >= quorum) return out;
  return null;
}

export const anyLive = (replicas: ReplicaView[]) => replicas.some((r) => LIVE.has(r.state));
export const activeCount = (replicas: ReplicaView[]) => replicas.filter((r) => ACTIVE.has(r.state)).length;

// ---------- Zamanlayıcılar ----------

/** Ölçülmemiş worker'ın hızı: boştakilerin en yüksek ölçülmüş hızı (yoksa 1). Yeni worker'lar denenir. */
function optimisticSpeed(idle: WorkerView[]): number {
  const measured = idle.map((w) => w.speedEma).filter((v): v is number => v !== null);
  return measured.length ? Math.max(...measured) : 1;
}

/** En yüksek değerli worker; eşitlikte önce ölçülmemiş olan, sonra listedeki sıra. */
function best(idle: WorkerView[], value: (w: WorkerView) => number): WorkerView | null {
  let bi = -1;
  for (let i = 0; i < idle.length; i++) {
    if (bi < 0) { bi = i; continue; }
    const v = value(idle[i]), bv = value(idle[bi]);
    if (v > bv || (v === bv && idle[i].speedEma === null && idle[bi].speedEma !== null)) bi = i;
  }
  return bi < 0 ? null : idle[bi];
}

export const fifoScheduler: Scheduler = {
  name: "fifo",
  pick: (_task, idle) => idle[0] ?? null,
};

/** Görev büyüklüğüne göre normalize edilmiş hız EMA'sı (cost/ms) en yüksek olan worker. */
export const fastestScheduler: Scheduler = {
  name: "fastest",
  pick: (_task, idle) => {
    const opt = optimisticSpeed(idle);
    return best(idle, (w) => w.speedEma ?? opt);
  },
};

/** Atama puanı = R × hız. */
export const reputationScheduler: Scheduler = {
  name: "reputation",
  pick: (_task, idle) => {
    const opt = optimisticSpeed(idle);
    return best(idle, (w) => score(w.alpha, w.beta) * (w.speedEma ?? opt));
  },
};

// ---------- Doğrulayıcılar ----------

/** İlk başarılı sonucu kabul eder (güvensiz; yalnızca karşılaştırma tabanı). Hata dönerse yeni kopya ister. */
export const acceptFirstVerifier: Verifier = {
  name: "accept_first",
  usesSpotChecks: false,
  initialReplicas: () => 1,
  onAssign: () => ({ extra: 0, aloneOk: true }),
  onResult: (_task, replicas) => {
    const ok = replicas.find((r) => r.state === "RETURNED_OK");
    if (ok) return { kind: "accept", output: ok.output! };
    return anyLive(replicas) ? { kind: "wait" } : { kind: "needMore", count: 1 };
  },
};

/** Sabit k kopya; canlı kopyaların hepsi dönünce ≥ 2 eşleşen sonuç kabul, yoksa bir kopya daha. */
export function fixedVerifier(k: number): Verifier {
  return {
    name: `fixed${k}`,
    usesSpotChecks: false,
    initialReplicas: () => k,
    onAssign: () => ({ extra: 0, aloneOk: false }),
    onResult: (_task, replicas) => {
      if (anyLive(replicas)) return { kind: "wait" };
      const out = agreeingOutput(replicas);
      return out !== null ? { kind: "accept", output: out } : { kind: "needMore", count: 1 };
    },
  };
}

/**
 * İtibar tabanlı uyarlanabilir doğrulama: güvenilir worker'a (R ≥ τ, α ≥ α_min) giden kopya tek başına
 * yeterlidir; değilse ikinci kopya hemen açılır. Bir görevde yeterli sayılmayan kopya bir kez
 * atandıysa görev iki eşleşen sonuç bekler. Sınama işleri ve geriye dönük iptal koordinatörde.
 */
export const adaptiveVerifier: Verifier = {
  name: "adaptive",
  usesSpotChecks: true,
  initialReplicas: () => 1,
  onAssign: (_task, replicas, worker) => {
    const aloneOk = worker.trusted;
    return { extra: !aloneOk && activeCount(replicas) === 1 ? 1 : 0, aloneOk };
  },
  onResult: (_task, replicas) => {
    const out = agreeingOutput(replicas);
    if (out !== null) return { kind: "accept", output: out };
    const ok = replicas.filter((r) => r.state === "RETURNED_OK");
    const assigned = replicas.filter((r) => r.state === "ASSIGNED" || r.state === "RETURNED_OK");
    if (ok.length === 1 && assigned.every((r) => r.aloneOk)) return { kind: "accept", output: ok[0].output! };
    return anyLive(replicas) ? { kind: "wait" } : { kind: "needMore", count: 1 };
  },
};

export const schedulers: Record<string, Scheduler> = Object.fromEntries(
  [fifoScheduler, fastestScheduler, reputationScheduler].map((s) => [s.name, s]),
);
// BOINC adaptive yalnızca simülatörde (Kapsam §5); accept_first koordinatörde test ve taban amaçlı durur.
export const verifiers: Record<string, Verifier> = Object.fromEntries(
  [fixedVerifier(2), fixedVerifier(3), adaptiveVerifier, acceptFirstVerifier].map((v) => [v.name, v]),
);
