/**
 * Strateji arayüzleri. Simülatördeki (sim/vcsim/strategies/base.py) arayüzlerle bire bir aynı
 * anlamı taşır; 8. hafta yeni stratejiler yalnızca bu arayüzleri uygular.
 */

export interface WorkerView {
  id: string;
  /** Normalize hız tahmini (cost / ms), henüz ölçülmediyse null. */
  speedEma: number | null;
  alpha: number;
  beta: number;
}

export interface ReplicaView {
  id: number;
  taskId: string;
  workerId: string | null;
  state: ReplicaState;
  output: string | null;
  fatal: boolean;
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

export interface Scheduler {
  readonly name: string;
  /** Kuyruğun başındaki kopya için boştaki worker'lardan birini seçer; uygun yoksa null. */
  pick(task: TaskView, idle: WorkerView[]): WorkerView | null;
}

export interface Verifier {
  readonly name: string;
  /** Görev HAZIR olduğunda kaç kopya üretileceği. */
  initialReplicas(task: TaskView): number;
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
  initialReplicas: () => 1,
  onResult: (_task, replicas) => {
    const ok = replicas.find((r) => r.state === "RETURNED_OK");
    if (ok) return { kind: "accept", output: ok.output! };
    const live = replicas.some((r) => r.state === "QUEUED" || r.state === "ASSIGNED");
    return live ? { kind: "wait" } : { kind: "needMore", count: 1 };
  },
};

export const schedulers: Record<string, Scheduler> = { fifo: fifoScheduler };
export const verifiers: Record<string, Verifier> = { accept_first: acceptFirstVerifier };
