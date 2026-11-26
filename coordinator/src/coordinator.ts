import { randomUUID } from "node:crypto";
import type { PlanEntry } from "./payouts.ts";
import type { Config } from "./config.ts";
import { Db } from "./db/db.ts";
import { moduleRegistry, type ModuleInfo } from "./modules.ts";
import { jsOracle, spotInput, type Oracle } from "./oracle.ts";
import { canonicalJson, DagError, resolveRefs, taskCost, validateDag, type Dag, type DagTask } from "./queue/dag.ts";
import { isTrusted, replicationEvents, score, update, validateParams, type RepEventKind, type RepParams } from "./reputation.ts";
import {
  schedulers, verifiers,
  type Decision, type ReplicaState, type ReplicaView, type Scheduler, type TaskView, type Verifier, type WorkerView,
} from "./strategies.ts";

// ---------- Durum türleri ----------

export type TaskState = "WAITING" | "READY" | "RUNNING" | "ACCEPTED" | "FAILED" | "CANCELLED";
export type JobState = "RUNNING" | "COMPLETED" | "FAILED";

export interface OutgoingMessage { type: string; [k: string]: unknown }

export interface WorkerConn {
  send(msg: OutgoingMessage): void;
  close(code: number, reason: string): void;
}

interface Worker {
  id: string;
  conn: WorkerConn;
  lastSeen: number;
  busyReplica: number | null;
  /** Worker'ın kendi bildirdiği müsaitlik (CPU sınırı, şarj koşulu). */
  available: boolean;
  speedEma: number | null;
  alpha: number;
  beta: number;
  /** hello mesajından (demo paneli ve kayıt için). */
  userAgent: string | null;
  deviceClass: string;
  /** Ödeme adresi (Solana, Devnet); hello'da verilmezse veritabanındaki son adres. */
  wallet: string | null;
}

interface Task {
  key: string; // `${jobId}/${dagTaskId}`
  jobId: string;
  def: DagTask;
  cost: number;
  state: TaskState;
  inputResolved: string | null;
  acceptedOutput: string | null;
  /** Yalnızca geçerli tur (geriye dönük iptalde sıfırlanır). */
  replicaIds: number[];
  /** Görevin bağlı olduğu WASM paketi özeti (modules.ts); paket yoksa null. */
  moduleHash: string | null;
  /** Kabul anında eşleşen kopyalar; iş bitince ödenir. */
  payIds: number[];
  /** Tek kopyayla kabul edildiyse o worker (geriye dönük iptal için). */
  acceptedSingleBy: string | null;
}

interface Replica {
  id: number;
  taskKey: string;
  workerId: string | null;
  state: ReplicaState;
  output: string | null;
  fatal: boolean;
  deadlineAt: number | null;
  aloneOk: boolean;
  /** Sınama işiyse beklenen çıktı, yansıtıldığı iş ve maliyeti (gerçek görevinkiyle aynı); gerçek kopyada null. */
  spot: { jobId: string; expected: string; cost: number } | null;
}

interface Job {
  id: string;
  dag: Dag;
  state: JobState;
  submittedAt: number;
  completedAt: number | null;
  taskKeys: string[]; // topolojik sırada
  children: Map<string, string[]>; // dagTaskId → çocuk dagTaskId'ler
  scheduler: Scheduler;
  verifier: Verifier;
  spotIds: number[];
}

export interface ResultMessage {
  type: "result";
  replicaId: number;
  status: "ok" | "error";
  output: string;
  durationMs: number;
  impl?: string;
  loadMs?: number;
  fatal?: boolean;
}

export interface JobOptions {
  scheduler?: string;
  verifier?: string;
}

/** USDC'nin ondalık basamağı: 1 USDC = 10^6 atomik birim. */
export const USDC_DECIMALS = 6;

/**
 * İş için fiyat teklifi (Kapsam v3 §5). Alıcı işi gönderirken üst sınırı öder; iş bitince
 * gerçekleşen maliyet hesaplanır ve fark iade edilir (zincir üstü iade 10. haftada).
 *   uyarlanabilir:  üst sınır = p × N × maxReplicas / (1 − q)
 *   sınama işsiz:   üst sınır = p × N × maxReplicas
 * p birim ücret (görev türünden bağımsız; simülatörle aynı), N görev sayısı. Atomik birim, yukarı yuvarlanır.
 */
export interface Quote {
  tasks: number;
  scheduler: string;
  verifier: string;
  unitPriceAtomic: number;
  maxReplicas: number;
  spotCheckRate: number;
  capAtomic: number;
  /** Üst sınır, USDC (ondalık metin). */
  cap: string;
}

/** Ödenmiş bir iş gönderiminin kaydı (x402 kesinleşmesinden). */
export interface JobPayment {
  capAtomic: number;
  transaction: string;
  payer: string | null;
}

export function formatUsdc(atomic: number): string {
  const s = String(Math.round(atomic)).padStart(USDC_DECIMALS + 1, "0");
  return `${s.slice(0, -USDC_DECIMALS)}.${s.slice(-USDC_DECIMALS)}`;
}

export interface CoordinatorOptions {
  wasmHash?: string | null;
  /** Sınama işlerinin beklenen çıktısı (varsayılan saf JS; sunucu WASM'ı yükler). */
  oracle?: Oracle;
  /** [0, 1) rastgele sayı üreteci (testlerde belirlenimci yapılabilir). */
  random?: () => number;
  /**
   * Ödenmiş bir iş kesinleşince (bitti ve geç sınama işleri de sonuçlandı) çağrılır; ödeme planı
   * payoutPlan(jobId) ile alınır (10. hafta, payouts.ts). Ödemesiz işlerde çağrılmaz.
   */
  onSettled?: (jobId: string) => void;
}

/** Kayıp ya da zaman aşımı nedeniyle yeniden oluşturulan kopyalar için toplam üst sınır çarpanı. */
const ATTEMPT_FACTOR = 3;

/**
 * Koordinatör çekirdeği: iş/görev/kopya durum makineleri, kuyruk, dağıtım, heartbeat ve zaman aşımı,
 * itibar, sınama işi, geriye dönük iptal ve iş sonunda ödeme (sim/vcsim/coordinator.py ile aynı kurallar).
 * Ağdan bağımsızdır (ws.ts bağlar); bu yüzden doğrudan test edilebilir.
 *
 *   Görev:  WAITING → READY → RUNNING → ACCEPTED | FAILED | CANCELLED
 *           ACCEPTED → READY | WAITING   (geriye dönük iptal)
 *   Kopya:  QUEUED → ASSIGNED → RETURNED_OK | RETURNED_ERROR | TIMED_OUT | LOST | CANCELLED
 */
export class Coordinator {
  readonly cfg: Config;
  readonly db: Db;
  /** Varsayılan stratejiler (iş başına değiştirilebilir). */
  readonly scheduler: Scheduler;
  readonly verifier: Verifier;
  /** Başlangıçta hesaplanan WASM paketi özeti; paket derlenmemişse null. */
  readonly wasmHash: string | null;
  readonly modules: ModuleInfo[];
  readonly rep: RepParams;
  readonly oracle: Oracle;
  readonly stats = { tasksInvalidated: 0, lateDetectedWrong: 0, spotchecks: 0, spotFails: 0 };

  private workers = new Map<string, Worker>();
  private jobs = new Map<string, Job>();
  private tasks = new Map<string, Task>();
  private replicas = new Map<number, Replica>();
  private queue: number[] = [];
  private nextReplicaId = 1;
  private nextSpot = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastPingAt = 0;
  private readonly random: () => number;
  onSettled: ((jobId: string) => void) | null;
  /** Ödeme planı çıkarılmış işler (bir kez). */
  private readonly settled = new Set<string>();

  constructor(cfg: Config, db: Db, opts: CoordinatorOptions = {}) {
    this.cfg = cfg;
    this.db = db;
    this.wasmHash = opts.wasmHash ?? null;
    this.modules = moduleRegistry(this.wasmHash);
    this.rep = validateParams(cfg.reputation);
    this.oracle = opts.oracle ?? jsOracle;
    this.random = opts.random ?? Math.random;
    this.onSettled = opts.onSettled ?? null;
    this.scheduler = Coordinator.schedulerNamed(cfg.scheduler);
    this.verifier = Coordinator.verifierNamed(cfg.verifier);
    const maxId = db.all("SELECT MAX(id) AS m FROM replicas")[0]?.m;
    if (typeof maxId === "number") this.nextReplicaId = maxId + 1;
  }

  private static schedulerNamed(name: string): Scheduler {
    const s = schedulers[name];
    if (!s) throw new DagError(`bilinmeyen zamanlayıcı "${name}" (geçerli: ${Object.keys(schedulers).join(", ")})`);
    return s;
  }

  private static verifierNamed(name: string): Verifier {
    const v = verifiers[name];
    if (!v) throw new DagError(`bilinmeyen doğrulayıcı "${name}" (geçerli: ${Object.keys(verifiers).join(", ")})`);
    return v;
  }

  start(): void {
    const period = Math.max(20, Math.min(this.cfg.heartbeatMs, this.cfg.taskTimeoutMs) / 4);
    this.timer = setInterval(() => this.tick(Date.now()), period);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- İşler ----------

  /** DAG'i, stratejileri ve modül özetlerini doğrular; iş oluşturmaz. Hata → DagError (HTTP 400). */
  prepareJob(raw: unknown, opts: JobOptions = {}) {
    const { dag, order } = validateDag(raw);
    const scheduler = opts.scheduler ? Coordinator.schedulerNamed(opts.scheduler) : this.scheduler;
    const verifier = opts.verifier ? Coordinator.verifierNamed(opts.verifier) : this.verifier;
    for (const t of dag.tasks) {
      if (t.moduleHash !== undefined && t.moduleHash !== this.wasmHash) {
        throw new DagError(
          `"${t.id}": moduleHash koordinatördeki WASM paketiyle eşleşmiyor (koordinatör: ${this.wasmHash ?? "paket derlenmemiş"})`,
        );
      }
    }
    return { dag, order, scheduler, verifier };
  }

  get unitPriceAtomic(): number {
    return Math.round(this.cfg.unitPrice * 10 ** USDC_DECIMALS);
  }

  /** Fiyat teklifi: iş oluşturmadan üst sınırı hesaplar (POST /quote ve x402 dinamik fiyatı). */
  quote(raw: unknown, opts: JobOptions = {}): Quote {
    const { dag, scheduler, verifier } = this.prepareJob(raw, opts);
    const q = verifier.usesSpotChecks ? this.cfg.spotCheckRate : 0;
    const n = dag.tasks.length;
    const capAtomic = Math.ceil((this.unitPriceAtomic * n * this.cfg.maxReplicas) / (1 - q));
    return {
      tasks: n, scheduler: scheduler.name, verifier: verifier.name, unitPriceAtomic: this.unitPriceAtomic,
      maxReplicas: this.cfg.maxReplicas, spotCheckRate: q, capAtomic, cap: formatUsdc(capAtomic),
    };
  }

  submitJob(raw: unknown, opts: JobOptions = {}, payment?: JobPayment): { jobId: string } {
    const { dag, order, scheduler, verifier } = this.prepareJob(raw, opts);
    const jobId = `job_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const children = new Map<string, string[]>(dag.tasks.map((t) => [t.id, []]));
    for (const t of dag.tasks) for (const d of t.deps ?? []) children.get(d)!.push(t.id);

    const job: Job = {
      id: jobId, dag, state: "RUNNING", submittedAt: now, completedAt: null, taskKeys: [], children,
      scheduler, verifier, spotIds: [],
    };
    this.jobs.set(jobId, job);
    this.db.insert("jobs", {
      id: jobId, dag_json: JSON.stringify(dag), strategy_sched: scheduler.name,
      strategy_verif: verifier.name, status: job.state, submitted_at: now,
      ...(payment ? { quote_cap: payment.capAtomic, payment_tx: payment.transaction, payer: payment.payer, paid_at: now } : {}),
    });

    const byId = new Map(dag.tasks.map((t) => [t.id, t]));
    for (const id of order) {
      const def = byId.get(id)!;
      const task: Task = {
        key: `${jobId}/${id}`, jobId, def, cost: taskCost(def), state: "WAITING",
        inputResolved: null, acceptedOutput: null, replicaIds: [], moduleHash: def.moduleHash ?? this.wasmHash,
        payIds: [], acceptedSingleBy: null,
      };
      this.tasks.set(task.key, task);
      job.taskKeys.push(task.key);
      this.db.insert("tasks", { id: task.key, job_id: jobId, dag_task_id: id, module: def.module, cost: task.cost, state: task.state });
    }
    this.db.log("info", "job_submitted", { jobId, tasks: order.length, scheduler: scheduler.name, verifier: verifier.name });
    for (const key of job.taskKeys) {
      const t = this.tasks.get(key)!;
      if ((t.def.deps ?? []).length === 0) this.makeReady(t);
    }
    this.dispatch();
    return { jobId };
  }

  getJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.id,
      clientJobId: job.dag.jobId ?? null,
      status: job.state,
      scheduler: job.scheduler.name,
      verifier: job.verifier.name,
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
      spotchecks: job.spotIds.length,
      payment: this.ledger(job.id),
      tasks: job.taskKeys.map((k) => {
        const t = this.tasks.get(k)!;
        return {
          id: t.def.id,
          module: t.def.module,
          moduleHash: t.moduleHash,
          state: t.state,
          output: t.acceptedOutput ? JSON.parse(t.acceptedOutput) : null,
          replicas: t.replicaIds.length,
          deps: t.def.deps ?? [],
          /** Kabulde eşleşen kopya sayısı; tek kopyayla kabul edildiyse 1 ve `single` dolu. */
          agreeing: t.payIds.length,
          single: t.acceptedSingleBy !== null,
        };
      }),
    };
  }

  /** Worker listesi; `flagged` yalnızca izleme amaçlıdır (sınama işinde en az bir kez yakalanmış), kara liste yoktur. */
  listWorkers() {
    return [...this.workers.values()].map((w) => {
      const spotFails = Number(this.db.all("SELECT COUNT(*) AS n FROM rep_events WHERE worker_id = ? AND kind = 'spot_fail'", w.id)[0]?.n ?? 0);
      const r = w.busyReplica !== null ? this.replicas.get(w.busyReplica) : undefined;
      const t = r && !r.spot ? this.tasks.get(r.taskKey) : undefined;
      return {
        id: w.id, busy: w.busyReplica !== null, available: w.available, speedEma: w.speedEma, lastSeen: w.lastSeen,
        alpha: w.alpha, beta: w.beta, reputation: score(w.alpha, w.beta), trusted: isTrusted(w.alpha, w.beta, this.rep),
        flagged: spotFails > 0, caught: spotFails, userAgent: w.userAgent, deviceClass: w.deviceClass, wallet: w.wallet,
        // Koordinatörün görüşü (demo paneli): şu an hangi işin hangi görevi, ya da sınama işi.
        doing: r ? (r.spot ? { spot: true, jobId: r.spot.jobId } : { spot: false, jobId: t?.jobId ?? null, task: t?.def.id ?? null, module: t?.def.module ?? null }) : null,
      };
    });
  }

  // ---------- Worker yaşam döngüsü ----------

  workerConnected(conn: WorkerConn, hello: { workerId?: string; userAgent?: string; deviceClass?: string; wallet?: string }): string {
    let id = hello.workerId;
    if (!id || this.workers.has(id)) id = `w_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const stored = this.db.all("SELECT alpha, beta, speed_ema, wallet FROM workers WHERE id = ?", id)[0];
    const w: Worker = {
      id, conn, lastSeen: now, busyReplica: null, available: true,
      speedEma: (stored?.speed_ema as number | null) ?? null,
      alpha: (stored?.alpha as number) ?? 0,
      beta: (stored?.beta as number) ?? 0,
      userAgent: hello.userAgent ?? null, deviceClass: hello.deviceClass ?? "unknown",
      wallet: hello.wallet ?? (stored?.wallet as string | null) ?? null,
    };
    this.workers.set(id, w);
    this.db.upsertWorker({
      id, user_agent: hello.userAgent ?? null, device_class: hello.deviceClass ?? "unknown",
      first_seen: now, last_seen: now, wallet: w.wallet,
    });
    this.db.log("info", "worker_connected", { id });
    conn.send({ type: "welcome", workerId: id, heartbeatMs: this.cfg.heartbeatMs, modules: this.modules });
    this.dispatch();
    return id;
  }

  /** Worker'dan gelen her geçerli mesaj worker'ı canlı sayar. */
  touch(workerId: string): void {
    const w = this.workers.get(workerId);
    if (w) w.lastSeen = Date.now();
  }

  setAvailable(workerId: string, available: boolean): void {
    const w = this.workers.get(workerId);
    if (!w || w.available === available) return;
    w.available = available;
    if (available) this.dispatch();
  }

  workerDisconnected(workerId: string, reason: string): void {
    const w = this.workers.get(workerId);
    if (!w) return;
    this.workers.delete(workerId);
    this.db.update("workers", workerId, { last_seen: w.lastSeen });
    this.db.log("info", "worker_disconnected", { id: workerId, reason });
    if (w.busyReplica !== null) {
      const r = this.replicas.get(w.busyReplica)!;
      if (r.state === "ASSIGNED") this.closeReplica(r, "LOST");
    }
    this.dispatch();
  }

  handleResult(workerId: string, msg: ResultMessage): void {
    const w = this.workers.get(workerId);
    const r = this.replicas.get(msg.replicaId);
    if (!w || !r || r.workerId !== workerId) {
      this.db.log("warn", "unknown_result", { workerId, replicaId: msg.replicaId });
      return;
    }
    if (w.busyReplica === r.id) w.busyReplica = null;
    const now = Date.now();
    if (r.state !== "ASSIGNED") {
      // Zaman aşımına uğramış ya da iptal edilmiş kopyanın geç sonucu: kaydedilir, dikkate alınmaz.
      this.db.log("info", "late_result", { replicaId: r.id, state: r.state, status: msg.status });
      this.dispatch();
      return;
    }
    r.state = msg.status === "ok" ? "RETURNED_OK" : "RETURNED_ERROR";
    r.output = msg.output;
    r.fatal = msg.fatal === true;
    this.db.update("replicas", r.id, {
      state: r.state, returned_at: now, output: msg.output, duration_ms: msg.durationMs,
      load_ms: msg.loadMs ?? null, fatal: r.fatal ? 1 : 0,
    });
    const cost = r.spot ? r.spot.cost : this.tasks.get(r.taskKey)!.cost;
    if (r.state === "RETURNED_OK" && msg.durationMs > 0) {
      const speed = cost / msg.durationMs;
      w.speedEma = w.speedEma === null ? speed : 0.8 * w.speedEma + 0.2 * speed;
      this.db.update("workers", w.id, { speed_ema: w.speedEma });
    }
    if (r.spot) this.spotResult(w.id, r);
    else this.decide(this.tasks.get(r.taskKey)!);
    this.dispatch();
  }

  // ---------- Periyodik denetim ----------

  tick(now: number): void {
    if (now - this.lastPingAt >= this.cfg.heartbeatMs) {
      this.lastPingAt = now;
      for (const w of this.workers.values()) w.conn.send({ type: "ping", t: now });
    }
    const limit = this.cfg.heartbeatMs * this.cfg.missedHeartbeats;
    for (const w of [...this.workers.values()]) {
      if (now - w.lastSeen > limit) {
        w.conn.close(4000, "heartbeat");
        this.workerDisconnected(w.id, "heartbeat");
      }
    }
    for (const r of this.replicas.values()) {
      if (r.state === "ASSIGNED" && r.deadlineAt !== null && now > r.deadlineAt) {
        // Worker meşgul kalır; geç sonucu gelince serbest kalır (handleResult).
        this.closeReplica(r, "TIMED_OUT");
      }
    }
    this.dispatch();
  }

  // ---------- Görev ve kopya durumları ----------

  private makeReady(task: Task): void {
    const job = this.jobs.get(task.jobId)!;
    const accepted = new Map<string, string>();
    for (const dep of task.def.deps ?? []) accepted.set(dep, this.tasks.get(`${job.id}/${dep}`)!.acceptedOutput!);
    try {
      task.inputResolved = canonicalJson(resolveRefs(task.def.input, accepted));
    } catch (e) {
      this.failTask(task, e instanceof DagError ? e.message : String(e));
      return;
    }
    task.state = "READY";
    this.db.update("tasks", task.key, { state: task.state, input_resolved: task.inputResolved, ready_at: Date.now() });
    this.createReplicas(task, job.verifier.initialReplicas(this.taskView(task)));
  }

  private createReplicas(task: Task, count: number): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const r: Replica = {
        id: this.nextReplicaId++, taskKey: task.key, workerId: null, state: "QUEUED", output: null, fatal: false,
        deadlineAt: null, aloneOk: false, spot: null,
      };
      this.replicas.set(r.id, r);
      task.replicaIds.push(r.id);
      this.queue.push(r.id);
      this.db.insert("replicas", { id: r.id, task_id: task.key, state: r.state, created_at: now, is_spotcheck: 0 });
    }
  }

  /** ASSIGNED bir kopyayı LOST ya da TIMED_OUT olarak kapatır ve (gerçek kopyaysa) yerine yeni bir kopya açar. */
  private closeReplica(r: Replica, state: "LOST" | "TIMED_OUT"): void {
    r.state = state;
    this.db.update("replicas", r.id, { state });
    this.db.log("warn", state === "LOST" ? "replica_lost" : "replica_timed_out", { replicaId: r.id, workerId: r.workerId });
    if (r.spot) {
      // Kaybolan sınama işi yenilenmez ve itibar olayı üretmez; iş bitmişse defter artık kesinleşebilir.
      const job = this.jobs.get(r.spot.jobId);
      if (job) this.maybeSettle(job);
      return;
    }
    const task = this.tasks.get(r.taskKey)!;
    if (task.state !== "READY" && task.state !== "RUNNING") return;
    if (task.replicaIds.length >= this.cfg.maxReplicas * ATTEMPT_FACTOR) {
      this.failTask(task, "çok fazla kayıp ya da zaman aşımı");
      return;
    }
    this.createReplicas(task, 1);
  }

  private decide(task: Task): void {
    if (task.state !== "READY" && task.state !== "RUNNING") return;
    const views = task.replicaIds.map((id) => this.replicaView(this.replicas.get(id)!));
    const d: Decision = this.jobs.get(task.jobId)!.verifier.onResult(this.taskView(task), views);
    switch (d.kind) {
      case "accept":
        this.acceptTask(task, d.output);
        break;
      case "needMore": {
        const returned = views.filter((v) => v.state === "RETURNED_OK" || v.state === "RETURNED_ERROR").length;
        if (returned + d.count > this.cfg.maxReplicas) this.failTask(task, `max_replicas (${this.cfg.maxReplicas}) aşıldı`);
        else this.createReplicas(task, d.count);
        break;
      }
      case "fail":
        this.failTask(task, d.reason);
        break;
      case "wait":
        break;
    }
  }

  private acceptTask(task: Task, output: string): void {
    const now = Date.now();
    task.state = "ACCEPTED";
    task.acceptedOutput = output;
    this.db.update("tasks", task.key, { state: task.state, accepted_output: output, accepted_at: now });
    // Kabul anında dönmüş kopyalar: ödeme (iş sonunda) ve itibar aynı kümeyi kullanır.
    const returned = task.replicaIds.map((id) => this.replicas.get(id)!).filter((r) => r.state === "RETURNED_OK");
    const matching = returned.filter((r) => r.output === output);
    task.payIds = matching.map((r) => r.id);
    task.acceptedSingleBy = matching.length === 1 ? matching[0].workerId : null;
    const events = replicationEvents(output, returned.map((r) => ({ workerId: r.workerId!, output: r.output })));
    events.forEach((e, i) => this.observe(e.workerId, returned[i].id, e.kind));
    for (const id of task.replicaIds) {
      const r = this.replicas.get(id)!;
      if (r.state === "QUEUED") this.cancelReplica(r);
    }
    const job = this.jobs.get(task.jobId)!;
    for (const childId of job.children.get(task.def.id)!) {
      const child = this.tasks.get(`${job.id}/${childId}`)!;
      if (child.state !== "WAITING") continue;
      const ready = (child.def.deps ?? []).every((d) => this.tasks.get(`${job.id}/${d}`)!.state === "ACCEPTED");
      if (ready) this.makeReady(child);
    }
    if (job.state === "RUNNING" && job.taskKeys.every((k) => this.tasks.get(k)!.state === "ACCEPTED")) {
      this.finishJob(job, "COMPLETED");
    }
  }

  private failTask(task: Task, reason: string): void {
    task.state = "FAILED";
    this.db.update("tasks", task.key, { state: task.state });
    this.db.log("error", "task_failed", { task: task.key, reason });
    for (const id of task.replicaIds) {
      const r = this.replicas.get(id)!;
      if (r.state === "QUEUED") this.cancelReplica(r);
    }
    const job = this.jobs.get(task.jobId)!;
    // Bir görev başarısız olunca işin geri kalanı durdurulur (çocuklar hiçbir zaman hazır olamaz).
    for (const k of job.taskKeys) {
      const t = this.tasks.get(k)!;
      if (t.state === "WAITING" || t.state === "READY" || t.state === "RUNNING") {
        t.state = "CANCELLED";
        this.db.update("tasks", t.key, { state: t.state });
        for (const id of t.replicaIds) {
          const r = this.replicas.get(id)!;
          if (r.state === "QUEUED") this.cancelReplica(r);
        }
      }
    }
    if (job.state === "RUNNING") this.finishJob(job, "FAILED");
  }

  /** Kuyruktaki ya da çalışan kopyayı iptal eder; çalışan kopyanın worker'ı sonucu gönderene kadar meşgul kalır. */
  private cancelReplica(r: Replica): void {
    r.state = "CANCELLED";
    this.queue = this.queue.filter((id) => id !== r.id);
    this.db.update("replicas", r.id, { state: r.state });
  }

  /**
   * İş biter (COMPLETED ya da FAILED): ödeme toplu yapılır. Kabul edilmiş görevlerin kabul anında
   * eşleşen kopyaları ve geçilen sınama işleri `paid = 1` (Kapsam v3 §5). Zincir üstü transfer 10. haftada.
   */
  private finishJob(job: Job, state: JobState): void {
    job.state = state;
    job.completedAt = Date.now();
    for (const k of job.taskKeys) {
      const t = this.tasks.get(k)!;
      if (t.state === "ACCEPTED") for (const id of t.payIds) this.db.update("replicas", id, { paid: 1 });
    }
    for (const id of job.spotIds) if (this.spotPassed(this.replicas.get(id)!)) this.db.update("replicas", id, { paid: 1 });
    this.db.update("jobs", job.id, { status: state, completed_at: job.completedAt });
    this.closeLedger(job);
    this.db.log("info", "job_finished", { jobId: job.id, state });
  }

  // ---------- Emanet defteri ----------

  /** İşte ödenen kopya sayısı (kabul edilen görevlerin eşleşen kopyaları + geçilen sınama işleri). */
  private paidCopies(job: Job): number {
    const real = Number(this.db.all(
      "SELECT COUNT(*) AS n FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? AND r.paid = 1", job.id)[0].n);
    const spots = job.spotIds.filter((id) => Number(this.db.all("SELECT paid FROM replicas WHERE id = ?", id)[0]?.paid) === 1).length;
    return real + spots;
  }

  /** İş bitince gerçekleşen maliyet ve (ödenmiş işlerde) iade edilecek tutar yazılır. */
  private closeLedger(job: Job): void {
    const realized = this.paidCopies(job) * this.unitPriceAtomic;
    const cap = this.db.all("SELECT quote_cap FROM jobs WHERE id = ?", job.id)[0]?.quote_cap;
    const refund = typeof cap === "number" ? Math.max(0, cap - realized) : null;
    this.db.update("jobs", job.id, { realized_cost: realized, refund_due: refund });
    if (typeof cap === "number" && realized > cap) this.db.log("error", "cost_exceeds_cap", { jobId: job.id, cap, realized });
    this.maybeSettle(job);
  }

  /**
   * İş bitti ve ona yansıtılan sınama işlerinin hiçbiri artık çalışmıyorsa defter kesinleşir: geç dönen
   * sınama işi maliyeti değiştiremez. Ödenmiş işlerde ödeme planı (worker'lar + iade) bir kez çıkarılır.
   */
  private maybeSettle(job: Job): void {
    if (job.state === "RUNNING" || this.settled.has(job.id)) return;
    if (job.spotIds.some((id) => this.replicas.get(id)?.state === "ASSIGNED")) return;
    this.settled.add(job.id);
    const paid = this.db.all("SELECT payer FROM jobs WHERE id = ?", job.id)[0]?.payer;
    if (paid) this.onSettled?.(job.id);
  }

  /**
   * Kesinleşmiş işin ödeme planı: her worker'a, kabul anında eşleşen kopyaları ve geçtiği sınama işleri
   * kadar birim ücret (adresi yoksa recipient = null); alıcıya üst sınır − gerçekleşen maliyet.
   * Tutarların toplamı ödenen üst sınıra eşittir.
   */
  payoutPlan(jobId: string): PlanEntry[] {
    const job = this.jobs.get(jobId);
    const j = this.db.all("SELECT payer, quote_cap, refund_due FROM jobs WHERE id = ?", jobId)[0];
    if (!job || !j?.payer) return [];
    const units = new Map<string, number>();
    const add = (w: unknown) => units.set(String(w), (units.get(String(w)) ?? 0) + 1);
    for (const r of this.db.all("SELECT r.worker_id FROM replicas r JOIN tasks t ON t.id = r.task_id WHERE t.job_id = ? AND r.paid = 1", jobId)) add(r.worker_id);
    for (const id of job.spotIds) {
      const r = this.db.all("SELECT worker_id, paid FROM replicas WHERE id = ?", id)[0];
      if (Number(r?.paid) === 1) add(r.worker_id);
    }
    const entries: PlanEntry[] = [];
    for (const [workerId, n] of [...units].sort(([a], [b]) => a.localeCompare(b))) {
      const wallet = this.workers.get(workerId)?.wallet ?? (this.db.all("SELECT wallet FROM workers WHERE id = ?", workerId)[0]?.wallet as string | null) ?? null;
      entries.push({ kind: "worker", payee: workerId, recipient: wallet, units: n, amountAtomic: n * this.unitPriceAtomic });
    }
    const refund = Number(j.refund_due ?? 0);
    if (refund > 0) entries.push({ kind: "refund", payee: "payer", recipient: String(j.payer), units: null, amountAtomic: refund });
    return entries;
  }

  private ledger(jobId: string) {
    const r = this.db.all("SELECT quote_cap, payment_tx, payer, realized_cost, refund_due, refund_tx FROM jobs WHERE id = ?", jobId)[0];
    if (!r || r.quote_cap === null) return null;
    return {
      capAtomic: r.quote_cap, transaction: r.payment_tx, payer: r.payer,
      realizedAtomic: r.realized_cost, refundDueAtomic: r.refund_due, refundTransaction: r.refund_tx,
    };
  }

  // ---------- İtibar ----------

  /** Doğrulanmış bir olayı worker'ın itibarına işler (bağlantısı kopmuşsa kayıtlı değerler üzerinden). */
  private observe(workerId: string, replicaId: number, kind: RepEventKind): void {
    const w = this.workers.get(workerId);
    const stored = w ? null : this.db.all("SELECT alpha, beta FROM workers WHERE id = ?", workerId)[0];
    let alpha = w ? w.alpha : Number(stored?.alpha ?? 0);
    let beta = w ? w.beta : Number(stored?.beta ?? 0);
    const wasTrusted = isTrusted(alpha, beta, this.rep);
    [alpha, beta] = update(alpha, beta, kind, this.rep);
    if (w) [w.alpha, w.beta] = [alpha, beta];
    this.db.update("workers", workerId, { alpha, beta });
    this.db.insert("rep_events", { worker_id: workerId, replica_id: replicaId, kind, alpha_after: alpha, beta_after: beta, t: Date.now() });
    // Olay kaydı (demo paneli ve izleme): uyuşmazlık ve tek kopya moduna giriş/çıkış.
    if (kind === "mismatch") this.db.log("warn", "result_mismatch", { workerId, replicaId });
    const trusted = isTrusted(alpha, beta, this.rep);
    if (trusted !== wasTrusted) this.db.log("info", trusted ? "worker_trusted" : "worker_untrusted", { workerId, reputation: score(alpha, beta) });
  }

  // ---------- Sınama işi ve geriye dönük iptal ----------

  /**
   * Worker'a gerçek görev yerine cevabı bilinen sınama işi verir: aynı modül, aynı boyut, rastgele tohum
   * (oracle.ts). Mesaj biçimi gerçek görevle aynıdır. Sınama işi üretilemiyorsa false.
   */
  private assignSpot(w: Worker, real: Task, job: Job): boolean {
    const input = real.inputResolved ? spotInput(real.def.module, real.inputResolved) : null;
    if (!input) return false;
    let expected: string;
    try {
      expected = this.oracle.run(real.def.module, input);
    } catch (e) {
      this.db.log("error", "spot_oracle_failed", { module: real.def.module, error: String(e) });
      return false;
    }
    const now = Date.now();
    const key = `spot/${String(this.nextSpot++).padStart(6, "0")}`;
    const r: Replica = {
      id: this.nextReplicaId++, taskKey: key, workerId: w.id, state: "ASSIGNED", output: null, fatal: false,
      deadlineAt: now + this.cfg.taskTimeoutMs, aloneOk: false, spot: { jobId: job.id, expected, cost: real.cost },
    };
    this.replicas.set(r.id, r);
    job.spotIds.push(r.id);
    this.stats.spotchecks++;
    w.busyReplica = r.id;
    this.db.insert("replicas", {
      id: r.id, task_id: key, is_spotcheck: 1, expected_output: expected, state: r.state, created_at: now,
      worker_id: w.id, assigned_at: now, deadline_at: r.deadlineAt,
    });
    this.db.log("info", "spotcheck_assigned", { replicaId: r.id, workerId: w.id, module: real.def.module, cost: real.cost, jobId: job.id });
    w.conn.send({
      type: "assign", replicaId: r.id, module: real.def.module, input, deadlineMs: this.cfg.taskTimeoutMs,
      ...(real.moduleHash ? { moduleHash: real.moduleHash } : {}),
    });
    return true;
  }

  private spotPassed(r: Replica): boolean {
    return r.state === "RETURNED_OK" && r.spot !== null && r.output === r.spot.expected;
  }

  private spotResult(workerId: string, r: Replica): void {
    if (r.state !== "RETURNED_OK") {
      // WASM hatası yanlış sonuç değildir; itibar olayı üretmez. İş bitmişse defter kesinleşebilir.
      const j = this.jobs.get(r.spot!.jobId);
      if (j) this.maybeSettle(j);
      return;
    }
    const passed = this.spotPassed(r);
    this.observe(workerId, r.id, passed ? "spot_pass" : "spot_fail");
    const job = this.jobs.get(r.spot!.jobId);
    if (passed && job && job.state !== "RUNNING") {
      this.db.update("replicas", r.id, { paid: 1 }); // iş sınama dönmeden bitti
      this.closeLedger(job);
    }
    if (!passed) {
      this.stats.spotFails++;
      this.db.log("warn", "spotcheck_failed", { replicaId: r.id, workerId });
      this.retroactiveCancel(workerId);
      if (job) this.maybeSettle(job);
    }
  }

  /**
   * Sınamada yakalanan worker'ın ödenmemiş (bitmemiş) işlerdeki tek kopyalı kabulleri geçersiz sayılır;
   * bu görevler ve çıktılarını kullanan alt görevler yeniden kuyruğa alınır. Bitmiş işlerdeki sonuçlar
   * geri alınamaz; yanlış olanlar ayrıca sayılır (Kapsam v3 §4–5).
   */
  private retroactiveCancel(workerId: string): void {
    for (const job of this.jobs.values()) {
      const single = job.taskKeys.filter((k) => {
        const t = this.tasks.get(k)!;
        return t.state === "ACCEPTED" && t.acceptedSingleBy === workerId;
      });
      if (single.length === 0) continue;
      if (job.state !== "RUNNING") {
        this.db.log("warn", "late_detection", { jobId: job.id, workerId, tasks: single });
        this.stats.lateDetectedWrong += single.length;
        continue;
      }
      const affected = new Set(single);
      for (const k of job.taskKeys) {
        const t = this.tasks.get(k)!;
        if (affected.has(k) || (t.def.deps ?? []).some((d) => affected.has(`${job.id}/${d}`))) {
          affected.add(k);
          this.resetTask(job, t);
        }
      }
      this.db.log("warn", "retroactive_cancel", { jobId: job.id, workerId, tasks: [...affected] });
    }
  }

  private resetTask(job: Job, t: Task): void {
    if (t.state === "WAITING") return;
    if (t.state === "ACCEPTED") this.stats.tasksInvalidated++;
    for (const id of t.replicaIds) {
      const r = this.replicas.get(id)!;
      if (r.state === "QUEUED" || r.state === "ASSIGNED") this.cancelReplica(r);
    }
    t.replicaIds = [];
    t.payIds = [];
    t.acceptedOutput = null;
    t.acceptedSingleBy = null;
    this.db.update("tasks", t.key, { accepted_output: null, accepted_at: null });
    if ((t.def.deps ?? []).every((d) => this.tasks.get(`${job.id}/${d}`)!.state === "ACCEPTED")) {
      this.makeReady(t);
    } else {
      t.state = "WAITING";
      this.db.update("tasks", t.key, { state: t.state });
    }
  }

  // ---------- Dağıtım ----------

  /**
   * Kuyruktaki kopyaları (FIFO) boştaki worker'lara dağıtır. onAssign yeni kopya açabilir;
   * boşta worker kaldıkça aynı çağrıda onları da atar (sim/vcsim/coordinator.py ile aynı).
   */
  private dispatch(): void {
    while (this.dispatchPass());
  }

  private dispatchPass(): boolean {
    const idle = [...this.workers.values()].filter((w) => w.busyReplica === null && w.available);
    let assigned = false;
    for (const rid of [...this.queue]) {
      if (idle.length === 0) break;
      while (idle.length > 0 && this.queue.includes(rid)) {
        const r = this.replicas.get(rid)!;
        const task = this.tasks.get(r.taskKey)!;
        const job = this.jobs.get(task.jobId)!;
        // Doğrulama için aynı görevin başarılı kopyaları farklı worker'larda çalışmalı.
        const done = new Set(task.replicaIds.map((id) => this.replicas.get(id)!).filter((x) => x.state === "RETURNED_OK").map((x) => x.workerId));
        const eligible = idle.filter((w) => !done.has(w.id));
        const picked = job.scheduler.pick(this.taskView(task), eligible.map((w) => this.workerView(w)));
        if (!picked) break;
        const w = this.workers.get(picked.id)!;
        idle.splice(idle.indexOf(w), 1);
        assigned = true;
        // Sınama işi: doğrulayıcı açtıysa her atamada spotCheckRate olasılıkla; gerçek kopya kuyrukta kalır.
        if (job.verifier.usesSpotChecks && this.random() < this.cfg.spotCheckRate && this.assignSpot(w, task, job)) continue;
        this.assign(r, w, task, job);
      }
    }
    return assigned;
  }

  private assign(r: Replica, w: Worker, task: Task, job: Job): void {
    const now = Date.now();
    this.queue = this.queue.filter((id) => id !== r.id);
    r.state = "ASSIGNED";
    r.workerId = w.id;
    r.deadlineAt = now + this.cfg.taskTimeoutMs;
    w.busyReplica = r.id;
    if (task.state === "READY") {
      task.state = "RUNNING";
      this.db.update("tasks", task.key, { state: task.state });
    }
    this.db.update("replicas", r.id, { state: r.state, worker_id: w.id, assigned_at: now, deadline_at: r.deadlineAt });
    w.conn.send({
      type: "assign", replicaId: r.id, module: task.def.module,
      input: task.inputResolved, deadlineMs: this.cfg.taskTimeoutMs,
      ...(task.moduleHash ? { moduleHash: task.moduleHash } : {}),
    });
    const views = task.replicaIds.map((id) => this.replicaView(this.replicas.get(id)!));
    const d = job.verifier.onAssign(this.taskView(task), views, this.workerView(w), this.random());
    r.aloneOk = d.aloneOk;
    if (d.extra > 0) this.createReplicas(task, d.extra);
  }

  // ---------- Görünümler ----------

  private taskView(t: Task): TaskView {
    return { key: t.key, module: t.def.module, cost: t.cost };
  }
  private replicaView(r: Replica): ReplicaView {
    return { id: r.id, taskId: r.taskKey, workerId: r.workerId, state: r.state, output: r.output, fatal: r.fatal, aloneOk: r.aloneOk };
  }
  private workerView(w: Worker): WorkerView {
    return { id: w.id, speedEma: w.speedEma, alpha: w.alpha, beta: w.beta, trusted: isTrusted(w.alpha, w.beta, this.rep) };
  }
}
