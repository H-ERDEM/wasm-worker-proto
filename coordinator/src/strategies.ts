/**
 * Strateji arayüzleri. Simülatördeki (sim/vcsim/strategies/base.py) arayüzlerle bire bir aynı
 * anlamı taşır.
 *
 * 8. hafta genişletmesi (docs/ROADMAP.md karar kaydı, 2026-11-23): `Verifier.onAssign` bir kopya
 * bir worker'a atandığı anda çağrılır; kopya sayısının görevi alan worker'a bağlı olduğu
 * stratejiler (uyarlanabilir) kararı burada verir. `extra` kadar ek kopya hemen kuyruğa girer;
 * `aloneOk` kopyaya anlık görüntü olarak yazılır. Sınama işleri ve geriye dönük iptal
 * koordinatörün işidir; doğrulayıcı yalnızca `usesSpotChecks` ile açar.
 * Gerçek stratejilerin TypeScript uygulamaları 9. haftada eklenir.
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

// ---- 7. hafta yer tutucu stratejileri ----

export const fifoScheduler: Scheduler = {
  name: "fifo",
  pick: (_task, idle) => idle[0] ?? null,
};

/** İlk başarılı sonucu kabul eder (güvensiz; yalnızca karşılaştırma tabanı). Hata dönerse yeni kopya ister. */
export const acceptFirstVerifier: Verifier = {
  name: "accept_first",
  usesSpotChecks: false,
  initialReplicas: () => 1,
  onAssign: () => ({ extra: 0, aloneOk: true }),
  onResult: (_task, replicas) => {
    const ok = replicas.find((r) => r.state === "RETURNED_OK");
    if (ok) return { kind: "accept", output: ok.output! };
    const live = replicas.some((r) => r.state === "QUEUED" || r.state === "ASSIGNED");
    return live ? { kind: "wait" } : { kind: "needMore", count: 1 };
  },
};

export const schedulers: Record<string, Scheduler> = { fifo: fifoScheduler };
export const verifiers: Record<string, Verifier> = { accept_first: acceptFirstVerifier };
