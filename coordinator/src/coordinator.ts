import { randomUUID } from "node:crypto";
import type { Config } from "./config.ts";
import { Db } from "./db/db.ts";
import { canonicalJson, DagError, resolveRefs, taskCost, validateDag, type Dag, type DagTask } from "./queue/dag.ts";
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
}

interface Task {
  key: string; // `${jobId}/${dagTaskId}`
  jobId: string;
  def: DagTask;
  cost: number;
  state: TaskState;
  inputResolved: string | null;
  acceptedOutput: string | null;
  replicaIds: number[];
}

interface Replica {
  id: number;
  taskKey: string;
  workerId: string | null;
  state: ReplicaState;
  output: string | null;
  fatal: boolean;
  deadlineAt: number | null;
}

interface Job {
  id: string;
  dag: Dag;
  state: JobState;
  submittedAt: number;
  completedAt: number | null;
  taskKeys: string[];
  children: Map<string, string[]>; // dagTaskId → çocuk dagTaskId'ler
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

/** Kayıp ya da zaman aşımı nedeniyle yeniden oluşturulan kopyalar için toplam üst sınır çarpanı. */
const ATTEMPT_FACTOR = 3;

/**
 * Koordinatör çekirdeği: iş/görev/kopya durum makineleri, kuyruk, dağıtım,
 * heartbeat ve zaman aşımı. Ağdan bağımsızdır (ws.ts bağlar); bu yüzden doğrudan test edilebilir.
 */
export class Coordinator {
  readonly cfg: Config;
  readonly db: Db;
  readonly scheduler: Scheduler;
  readonly verifier: Verifier;

  private workers = new Map<string, Worker>();
  private jobs = new Map<string, Job>();
  private tasks = new Map<string, Task>();
  private replicas = new Map<number, Replica>();
  private queue: number[] = [];
  private nextReplicaId = 1;
  private timer: NodeJS.Timeout | null = null;
  private lastPingAt = 0;

  constructor(cfg: Config, db: Db) {
    this.cfg = cfg;
    this.db = db;
    const s = schedulers[cfg.scheduler];
    const v = verifiers[cfg.verifier];
    if (!s) throw new Error(`bilinmeyen zamanlayıcı "${cfg.scheduler}"`);
    if (!v) throw new Error(`bilinmeyen doğrulayıcı "${cfg.verifier}"`);
    this.scheduler = s;
    this.verifier = v;
    const maxId = db.all("SELECT MAX(id) AS m FROM replicas")[0]?.m;
    if (typeof maxId === "number") this.nextReplicaId = maxId + 1;
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

  submitJob(raw: unknown): { jobId: string } {
    const { dag, order } = validateDag(raw);
    const jobId = `job_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const children = new Map<string, string[]>(dag.tasks.map((t) => [t.id, []]));
    for (const t of dag.tasks) for (const d of t.deps ?? []) children.get(d)!.push(t.id);

    const job: Job = { id: jobId, dag, state: "RUNNING", submittedAt: now, completedAt: null, taskKeys: [], children };
    this.jobs.set(jobId, job);
    this.db.insert("jobs", {
      id: jobId, dag_json: JSON.stringify(dag), strategy_sched: this.scheduler.name,
      strategy_verif: this.verifier.name, status: job.state, submitted_at: now,
    });

    const byId = new Map(dag.tasks.map((t) => [t.id, t]));
    for (const id of order) {
      const def = byId.get(id)!;
      const task: Task = {
        key: `${jobId}/${id}`, jobId, def, cost: taskCost(def), state: "WAITING",
        inputResolved: null, acceptedOutput: null, replicaIds: [],
      };
      this.tasks.set(task.key, task);
      job.taskKeys.push(task.key);
      this.db.insert("tasks", { id: task.key, job_id: jobId, dag_task_id: id, module: def.module, cost: task.cost, state: task.state });
    }
    this.db.log("info", "job_submitted", { jobId, tasks: order.length });
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
      submittedAt: job.submittedAt,
      completedAt: job.completedAt,
      tasks: job.taskKeys.map((k) => {
        const t = this.tasks.get(k)!;
        return {
          id: t.def.id,
          module: t.def.module,
          state: t.state,
          output: t.acceptedOutput ? JSON.parse(t.acceptedOutput) : null,
          replicas: t.replicaIds.length,
        };
      }),
    };
  }

  listWorkers() {
    return [...this.workers.values()].map((w) => ({
      id: w.id, busy: w.busyReplica !== null, available: w.available, speedEma: w.speedEma, lastSeen: w.lastSeen,
    }));
  }

  // ---------- Worker yaşam döngüsü ----------

  workerConnected(conn: WorkerConn, hello: { workerId?: string; userAgent?: string; deviceClass?: string }): string {
    let id = hello.workerId;
    if (!id || this.workers.has(id)) id = `w_${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const stored = this.db.all("SELECT alpha, beta, speed_ema FROM workers WHERE id = ?", id)[0];
    const w: Worker = {
      id, conn, lastSeen: now, busyReplica: null, available: true,
      speedEma: (stored?.speed_ema as number | null) ?? null,
      alpha: (stored?.alpha as number) ?? 0,
      beta: (stored?.beta as number) ?? 0,
    };
    this.workers.set(id, w);
    this.db.upsertWorker({
      id, user_agent: hello.userAgent ?? null, device_class: hello.deviceClass ?? "unknown",
      first_seen: now, last_seen: now,
    });
    this.db.log("info", "worker_connected", { id });
    conn.send({ type: "welcome", workerId: id, heartbeatMs: this.cfg.heartbeatMs, modules: [] });
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
    const task = this.tasks.get(r.taskKey)!;
    if (r.state === "RETURNED_OK" && msg.durationMs > 0) {
      const speed = task.cost / msg.durationMs;
      w.speedEma = w.speedEma === null ? speed : 0.8 * w.speedEma + 0.2 * speed;
      this.db.update("workers", w.id, { speed_ema: w.speedEma });
    }
    this.decide(task);
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

  // ---------- İç mantık ----------

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
    this.createReplicas(task, this.verifier.initialReplicas(this.taskView(task)));
  }

  private createReplicas(task: Task, count: number): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      const r: Replica = { id: this.nextReplicaId++, taskKey: task.key, workerId: null, state: "QUEUED", output: null, fatal: false, deadlineAt: null };
      this.replicas.set(r.id, r);
      task.replicaIds.push(r.id);
      this.queue.push(r.id);
      this.db.insert("replicas", { id: r.id, task_id: task.key, state: r.state, created_at: now, is_spotcheck: 0 });
    }
  }

  /** ASSIGNED bir kopyayı LOST ya da TIMED_OUT olarak kapatır ve yerine yeni bir kopya açar. */
  private closeReplica(r: Replica, state: "LOST" | "TIMED_OUT"): void {
    r.state = state;
    this.db.update("replicas", r.id, { state });
    this.db.log("warn", state === "LOST" ? "replica_lost" : "replica_timed_out", { replicaId: r.id, workerId: r.workerId });
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
    const d: Decision = this.verifier.onResult(this.taskView(task), views);
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
    for (const id of task.replicaIds) {
      const r = this.replicas.get(id)!;
      if (r.state === "QUEUED") this.cancelReplica(r);
      else if (r.state === "RETURNED_OK" && r.output === output) this.db.update("replicas", r.id, { paid: 1 });
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

  private cancelReplica(r: Replica): void {
    r.state = "CANCELLED";
    this.queue = this.queue.filter((id) => id !== r.id);
    this.db.update("replicas", r.id, { state: r.state });
  }

  private finishJob(job: Job, state: JobState): void {
    job.state = state;
    job.completedAt = Date.now();
    this.db.update("jobs", job.id, { status: state, completed_at: job.completedAt });
    this.db.log("info", "job_finished", { jobId: job.id, state });
  }

  /** Kuyruktaki kopyaları (FIFO) boştaki worker'lara dağıtır. */
  private dispatch(): void {
    for (const rid of [...this.queue]) {
      const idle = [...this.workers.values()].filter((w) => w.busyReplica === null && w.available);
      if (idle.length === 0) return;
      const r = this.replicas.get(rid)!;
      const task = this.tasks.get(r.taskKey)!;
      // Doğrulama için aynı görevin başarılı kopyaları farklı worker'larda çalışmalı.
      const done = new Set(task.replicaIds.map((id) => this.replicas.get(id)!).filter((x) => x.state === "RETURNED_OK").map((x) => x.workerId));
      const eligible = idle.filter((w) => !done.has(w.id));
      const picked = this.scheduler.pick(this.taskView(task), eligible.map((w) => this.workerView(w)));
      if (!picked) continue;
      this.assign(r, this.workers.get(picked.id)!, task);
    }
  }

  private assign(r: Replica, w: Worker, task: Task): void {
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
    });
  }

  private taskView(t: Task): TaskView {
    return { key: t.key, module: t.def.module, cost: t.cost };
  }
  private replicaView(r: Replica): ReplicaView {
    return { id: r.id, taskId: r.taskKey, workerId: r.workerId, state: r.state, output: r.output, fatal: r.fatal };
  }
  private workerView(w: Worker): WorkerView {
    return { id: w.id, speedEma: w.speedEma, alpha: w.alpha, beta: w.beta };
  }
}
