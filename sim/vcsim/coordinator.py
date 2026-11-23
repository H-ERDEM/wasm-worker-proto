"""Simüle koordinatör ve worker'lar (SimPy, zaman birimi ms).

Durum makineleri coordinator/src/coordinator.ts ile aynıdır:
  Görev:  WAITING → READY → RUNNING → ACCEPTED | FAILED | CANCELLED
          ACCEPTED → READY | WAITING   (geriye dönük iptal, 8. hafta)
  Kopya:  QUEUED → ASSIGNED → RETURNED_OK | RETURNED_ERROR | TIMED_OUT | LOST | CANCELLED

Koordinatörün bilgisi ile gerçek durum ayrıdır: sessizce ayrılan bir worker, koordinatör
heartbeat ile fark edene kadar (missedHeartbeats × heartbeatMs + denetim periyodu) hâlâ bağlı
sayılır ve ona görev atanabilir. Bu gecikme modellenmezse simülatör worker ayrılması altında
makespan'i sistematik olarak düşük tahmin eder (RQ3).

8. hafta eklemeleri (Kapsam v2 §5; ROADMAP karar kaydı 2026-11-23):
  - Verifier.on_assign: kopya sayısı atama anında, görevi alan worker'a göre belirlenir.
  - Sınama işi: doğrulayıcı açtıysa (uses_spot_checks) worker'a atanan işlerin spotCheckRate
    oranı cevabı bilinen sınama işidir; spot_pass / spot_fail itibar olayı üretir.
  - Geriye dönük iptal: sınamada yakalanan worker'ın, henüz ödenmemiş (bitmemiş) işlerde tek
    kopyayla kabul edilmiş sonuçları ve onlara bağlı alt görevler yeniden kuyruğa alınır.
  - Ödeme iş bittiğinde toplu yapılır (replicas.paid iş sonunda yazılır).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import simpy

from . import reputation
from .events import Recorder
from .reputation import RepParams
from .rng import Streams
from .strategies import SCHEDULERS, VERIFIERS
from .strategies.base import Decision, ReplicaView, TaskView, WorkerView
from .workload import task_cost, validate_dag

ATTEMPT_FACTOR = 3  # coordinator.ts ile aynı
CORRECT_EVENTS = ("match", "spot_pass")


@dataclass
class SimWorker:
    id: str
    speed: float
    faulty: bool
    arrived_at: float
    alive: bool = True  # gerçek durum
    connected: bool = True  # koordinatörün bildiği durum
    busy_replica: Optional[int] = None
    loaded: bool = False
    speed_ema: Optional[float] = None
    alpha: float = 0.0
    beta: float = 0.0
    consecutive_valid: int = 0  # BOINC adaptive tabanı için
    assign_count: int = 0  # sınama işi kararının CRN anahtarı


@dataclass
class SimTask:
    key: str
    job_id: str
    dag_id: str
    module: str
    input: dict
    deps: list[str]
    cost: float
    state: str = "WAITING"
    accepted_output: Optional[str] = None
    replica_ids: list[int] = field(default_factory=list)  # yalnızca geçerli tur (iptalde sıfırlanır)
    pay_ids: list[int] = field(default_factory=list)  # kabul anında eşleşen kopyalar; iş sonunda ödenir
    accepted_single_by: Optional[str] = None  # tek kopyayla kabul edildiyse o worker
    is_spot: bool = False


@dataclass
class SimReplica:
    id: int
    task_key: str
    worker_id: Optional[str] = None
    state: str = "QUEUED"
    output: Optional[str] = None
    fatal: bool = False
    is_spotcheck: bool = False
    alone_ok: bool = False


@dataclass
class SimJob:
    id: str
    task_keys: list[str]  # topolojik sırada
    children: dict[str, list[str]]
    state: str = "RUNNING"
    spot_ids: list[int] = field(default_factory=list)  # bu işe yansıtılan sınama işleri


class SimCoordinator:
    def __init__(self, env: simpy.Environment, cfg: dict, streams: Streams, rec: Recorder):
        self.env = env
        self.cfg = cfg
        self.sh = cfg["shared"]
        self.wcfg = cfg["workers"]
        self.fcfg = cfg["faults"]
        self.streams = streams
        self.rec = rec
        self.scheduler = SCHEDULERS[self.sh["scheduler"]]
        self.verifier = VERIFIERS[self.sh["verifier"]]
        self.rep_params = RepParams.from_shared(self.sh)
        self.spot_rate = float(self.sh["spotCheckRate"]) if self.verifier.uses_spot_checks else 0.0
        self.workers: dict[str, SimWorker] = {}
        self.tasks: dict[str, SimTask] = {}
        self.spot_tasks: dict[str, SimTask] = {}
        self.replicas: dict[int, SimReplica] = {}
        self.jobs: dict[str, SimJob] = {}
        self.queue: list[int] = []
        self.next_replica = 1
        self.next_worker = 0
        self.stats = {"tasks_invalidated": 0, "late_detected_wrong": 0}
        self._late_flagged: set[str] = set()
        self.all_done = env.event()
        period = max(20.0, min(self.sh["heartbeatMs"], self.sh["taskTimeoutMs"]) / 4)
        self.detect_base = self.sh["heartbeatMs"] * self.sh["missedHeartbeats"]
        self.detect_jitter = period

    # ---------- Doğru sonuç ve hata modeli ----------

    @staticmethod
    def truth(task_key: str) -> str:
        return f"{task_key}:ok"

    def produce_output(self, w: SimWorker, r: SimReplica) -> str:
        """Hatalı worker s olasılıkla yanlış döner. Rastgele modelde her yanlış değer benzersizdir;
        colluding modelde aynı görev için grubun tamamı aynı yanlış değeri verir. Sınama işleri
        gerçek görevlerden ayırt edilemez (Kapsam v2 §5 varsayımı): aynı karar kuralı uygulanır."""
        if w.faulty:
            s = self.fcfg["s"]
            if self.fcfg["collusion"]:
                if self.streams.uniform_for("collude", r.task_key) < s:
                    return f"{r.task_key}:collude"
            elif self.streams.uniform_for("lie", w.id, r.task_key) < s:
                return f"{r.task_key}:bad:{r.id}"
        return self.truth(r.task_key)

    # ---------- Worker'lar ----------

    def add_worker(self) -> SimWorker:
        pop = self.streams["population"]
        speed = float(pop.lognormal(0.0, self.wcfg["speed_sigma"]))
        faulty = bool(pop.random() < self.fcfg["f"])
        w = SimWorker(id=f"w{self.next_worker:04d}", speed=speed, faulty=faulty, arrived_at=self.env.now)
        self.next_worker += 1
        self.workers[w.id] = w
        session = self.wcfg.get("session_mean_s")
        if session:
            life_ms = float(self.streams["sessions"].exponential(session * 1000))
            close = bool(self.streams["sessions"].random() < self.wcfg["close_prob"])
            self.env.process(self._depart(w, life_ms, close))
        self.dispatch()
        return w

    def _depart(self, w: SimWorker, after_ms: float, close: bool):
        yield self.env.timeout(after_ms)
        w.alive = False
        if close:
            delay = 0.0  # sekme kapandı: WebSocket close hemen gelir
        else:
            delay = self.detect_base + float(self.streams["detection"].uniform(0, self.detect_jitter))
        yield self.env.timeout(delay)
        self.worker_disconnected(w)

    def worker_disconnected(self, w: SimWorker) -> None:
        if not w.connected:
            return
        w.connected = False
        if w.busy_replica is not None:
            r = self.replicas[w.busy_replica]
            if r.state == "ASSIGNED":
                self.close_replica(r, "LOST")
        self.dispatch()

    # ---------- İşler ----------

    def submit_job(self, dag: dict) -> str:
        order = validate_dag(dag)
        job_id = dag.get("jobId") or f"job{len(self.jobs):04d}"
        by_id = {t["id"]: t for t in dag["tasks"]}
        children: dict[str, list[str]] = {t["id"]: [] for t in dag["tasks"]}
        for t in dag["tasks"]:
            for d in t.get("deps", []):
                children[d].append(t["id"])
        job = SimJob(id=job_id, task_keys=[], children=children)
        self.jobs[job_id] = job
        self.rec.job(job_id, strategy_sched=self.scheduler.name, strategy_verif=self.verifier.name,
                     status="RUNNING", submitted_at=self.env.now)
        for tid in order:
            t = by_id[tid]
            key = f"{job_id}/{tid}"
            st = SimTask(key=key, job_id=job_id, dag_id=tid, module=t["module"], input=t["input"],
                         deps=list(t.get("deps", [])), cost=task_cost(t))
            self.tasks[key] = st
            job.task_keys.append(key)
            self.rec.task(key, job_id=job_id, dag_task_id=tid, module=st.module, cost=st.cost,
                          state="WAITING", expected_output=self.truth(key))
        for key in job.task_keys:
            if not self.tasks[key].deps:
                self.make_ready(self.tasks[key])
        self.dispatch()
        return job_id

    def make_ready(self, task: SimTask) -> None:
        task.state = "READY"
        self.rec.task(task.key, state="READY", ready_at=self.env.now)
        self.create_replicas(task, self.verifier.initial_replicas(self.task_view(task)))

    def create_replicas(self, task: SimTask, count: int) -> None:
        for _ in range(count):
            r = SimReplica(id=self.next_replica, task_key=task.key)
            self.next_replica += 1
            self.replicas[r.id] = r
            task.replica_ids.append(r.id)
            self.queue.append(r.id)
            self.rec.replica(r.id, task_id=task.key, state="QUEUED", created_at=self.env.now,
                             expected_output=self.truth(task.key))

    def task_of(self, r: SimReplica) -> SimTask:
        return self.spot_tasks[r.task_key] if r.is_spotcheck else self.tasks[r.task_key]

    # ---------- Dağıtım ve yürütme ----------

    def dispatch(self) -> None:
        # on_assign yeni kopya açabilir; boşta worker kaldıkça aynı olay içinde onları da ata.
        while self._dispatch_pass():
            pass

    def _dispatch_pass(self) -> bool:
        idle = [w for w in self.workers.values() if w.connected and w.busy_replica is None]
        assigned = False
        for rid in list(self.queue):
            while rid in self.queue and idle:
                r = self.replicas[rid]
                task = self.tasks[r.task_key]
                done = {self.replicas[i].worker_id for i in task.replica_ids
                        if self.replicas[i].state == "RETURNED_OK"}
                eligible = [w for w in idle if w.id not in done]
                picked = self.scheduler.pick(self.task_view(task), [self.worker_view(w) for w in eligible])
                if picked is None:
                    break
                w = self.workers[picked.id]
                idle.remove(w)
                assigned = True
                if self._spot_check_now(w):
                    self.assign_spot(w, task)  # gerçek kopya kuyrukta kalır, başka worker'a gidebilir
                else:
                    self.assign(r, w, task)
            if not idle:
                break
        return assigned

    def _spot_check_now(self, w: SimWorker) -> bool:
        if self.spot_rate <= 0.0:
            return False
        u = self.streams.uniform_for("spot", w.id, w.assign_count)
        w.assign_count += 1
        return u < self.spot_rate

    def _start(self, r: SimReplica, w: SimWorker, task: SimTask) -> None:
        now = self.env.now
        r.state = "ASSIGNED"
        r.worker_id = w.id
        w.busy_replica = r.id
        deadline = now + self.sh["taskTimeoutMs"]
        self.rec.replica(r.id, state="ASSIGNED", worker_id=w.id, assigned_at=now, deadline_at=deadline)
        self.env.process(self._execute(w, r, task))
        self.env.process(self._deadline(r, deadline))

    def assign(self, r: SimReplica, w: SimWorker, task: SimTask) -> None:
        self.queue.remove(r.id)
        if task.state == "READY":
            task.state = "RUNNING"
            self.rec.task(task.key, state="RUNNING")
        self._start(r, w, task)
        views = [self.replica_view(self.replicas[i]) for i in task.replica_ids]
        u = self.streams.uniform_for("replicate", w.id, task.key)
        d = self.verifier.on_assign(self.task_view(task), views, self.worker_view(w), u)
        r.alone_ok = d.alone_ok
        if d.extra > 0:
            self.create_replicas(task, d.extra)

    def assign_spot(self, w: SimWorker, real: SimTask) -> None:
        """Cevabı bilinen sınama işi: gerçek görevle aynı modül ve maliyet (aynı girdi boyutu
        dağılımı), aynı mesaj biçimi. Maliyeti worker'ın o sırada aldığı işe yansıtılır."""
        key = f"spot/{len(self.spot_tasks):06d}"
        st = SimTask(key=key, job_id=real.job_id, dag_id=key, module=real.module, input={}, deps=[],
                     cost=real.cost, state="RUNNING", is_spot=True)
        self.spot_tasks[key] = st
        r = SimReplica(id=self.next_replica, task_key=key, is_spotcheck=True)
        self.next_replica += 1
        self.replicas[r.id] = r
        st.replica_ids.append(r.id)
        self.jobs[real.job_id].spot_ids.append(r.id)
        self.rec.replica(r.id, task_id=key, is_spotcheck=1, state="QUEUED", created_at=self.env.now,
                         expected_output=self.truth(key))
        self._start(r, w, st)

    def _execute(self, w: SimWorker, r: SimReplica, task: SimTask):
        base = self.wcfg["base_rate"].get(task.module, 1.0)
        noise = float(self.streams["speed_noise"].lognormal(0.0, self.wcfg["speed_noise_sigma"]))
        duration = task.cost / (base * w.speed) * noise
        load = 0.0 if w.loaded else float(self.wcfg["load_ms"])
        w.loaded = True
        yield self.env.timeout(self.wcfg["network_ms"] + load + duration)
        if not w.alive:
            return  # worker sonucu göndermeden ayrıldı; heartbeat/close ile LOST olacak
        if task.module == "debug_panic":
            self.handle_result(w, r, "error", "RuntimeError: unreachable", duration, load, fatal=True)
        else:
            self.handle_result(w, r, "ok", self.produce_output(w, r), duration, load)

    def _deadline(self, r: SimReplica, deadline: float):
        yield self.env.timeout(deadline - self.env.now)
        if r.state == "ASSIGNED":
            self.close_replica(r, "TIMED_OUT")  # worker meşgul kalır, geç sonuç onu serbest bırakır
            self.dispatch()

    def handle_result(self, w: SimWorker, r: SimReplica, status: str, output: str,
                      duration: float, load: float, fatal: bool = False) -> None:
        if not w.connected:
            return
        if w.busy_replica == r.id:
            w.busy_replica = None
        if r.state != "ASSIGNED":
            self.dispatch()  # geç ya da iptal edilmiş kopyanın sonucu: dikkate alınmaz
            return
        now = self.env.now
        r.state = "RETURNED_OK" if status == "ok" else "RETURNED_ERROR"
        r.output = output
        r.fatal = fatal
        self.rec.replica(r.id, state=r.state, returned_at=now, output=output, duration_ms=duration,
                         load_ms=load if load else None, fatal=int(fatal))
        task = self.task_of(r)
        if status == "ok" and duration > 0:
            speed = task.cost / duration
            w.speed_ema = speed if w.speed_ema is None else 0.8 * w.speed_ema + 0.2 * speed
        if r.is_spotcheck:
            self.spot_result(w, r)
        else:
            self.decide(task)
        self.dispatch()

    # ---------- Kararlar ----------

    def close_replica(self, r: SimReplica, state: str) -> None:
        r.state = state
        self.rec.replica(r.id, state=state)
        if r.is_spotcheck:
            return  # kaybolan sınama işi yenilenmez; itibar olayı üretmez
        task = self.tasks[r.task_key]
        if task.state not in ("READY", "RUNNING"):
            return
        if len(task.replica_ids) >= self.sh["maxReplicas"] * ATTEMPT_FACTOR:
            self.fail_task(task)
            return
        self.create_replicas(task, 1)

    def decide(self, task: SimTask) -> None:
        if task.state not in ("READY", "RUNNING"):
            return
        views = [self.replica_view(self.replicas[i]) for i in task.replica_ids]
        d: Decision = self.verifier.on_result(self.task_view(task), views)
        if d.kind == "accept":
            self.accept_task(task, d.output)
        elif d.kind == "need_more":
            returned = sum(v.state in ("RETURNED_OK", "RETURNED_ERROR") for v in views)
            if returned + d.count > self.sh["maxReplicas"]:
                self.fail_task(task)
            else:
                self.create_replicas(task, d.count)
        elif d.kind == "fail":
            self.fail_task(task)

    def accept_task(self, task: SimTask, output: str) -> None:
        now = self.env.now
        task.state = "ACCEPTED"
        task.accepted_output = output
        self.rec.task(task.key, state="ACCEPTED", accepted_output=output, accepted_at=now)
        # Kabul anında dönmüş gerçek kopyalar: ödeme (iş sonunda) ve itibar aynı kümeyi kullanır.
        returned = [self.replicas[i] for i in task.replica_ids if self.replicas[i].state == "RETURNED_OK"]
        matching = [r for r in returned if r.output == output]
        task.pay_ids = [r.id for r in matching]
        task.accepted_single_by = matching[0].worker_id if len(matching) == 1 else None
        events = reputation.replication_events(output, [(r.worker_id, r.output) for r in returned])
        for r, (wid, kind) in zip(returned, events):  # olaylar girdiyle aynı sırada
            self.observe(self.workers[wid], r.id, kind)
        for i in task.replica_ids:
            if self.replicas[i].state == "QUEUED":
                self.cancel_replica(self.replicas[i])
        job = self.jobs[task.job_id]
        for child_id in job.children[task.dag_id]:
            child = self.tasks[f"{job.id}/{child_id}"]
            if child.state == "WAITING" and all(self.tasks[f"{job.id}/{d}"].state == "ACCEPTED" for d in child.deps):
                self.make_ready(child)
        if job.state == "RUNNING" and all(self.tasks[k].state == "ACCEPTED" for k in job.task_keys):
            self.finish_job(job, "COMPLETED")

    def fail_task(self, task: SimTask) -> None:
        job = self.jobs[task.job_id]
        task.state = "FAILED"
        self.rec.task(task.key, state="FAILED")
        for k in job.task_keys:
            t = self.tasks[k]
            if t.state in ("WAITING", "READY", "RUNNING"):
                t.state = "CANCELLED"
                self.rec.task(k, state="CANCELLED")
            for i in t.replica_ids:
                if self.replicas[i].state == "QUEUED":
                    self.cancel_replica(self.replicas[i])
        if job.state == "RUNNING":
            self.finish_job(job, "FAILED")

    def cancel_replica(self, r: SimReplica) -> None:
        """Kuyruktaki ya da çalışan kopyayı iptal eder. Çalışan kopyanın worker'ı sonucu
        gönderene kadar meşgul kalır; gelen sonuç dikkate alınmaz."""
        r.state = "CANCELLED"
        if r.id in self.queue:
            self.queue.remove(r.id)
        self.rec.replica(r.id, state="CANCELLED")

    def finish_job(self, job: SimJob, state: str) -> None:
        """İş biter (COMPLETED ya da FAILED): ödeme toplu yapılır. Kabul edilmiş görevlerin kabul
        anında eşleşen kopyaları ve geçilen sınama işleri ödenir (Kapsam v2 §5, §8)."""
        job.state = state
        for k in job.task_keys:
            t = self.tasks[k]
            if t.state == "ACCEPTED":
                for rid in t.pay_ids:
                    self.rec.replica(rid, paid=1)
        for rid in job.spot_ids:
            if self._spot_passed(self.replicas[rid]):
                self.rec.replica(rid, paid=1)
        self.rec.job(job.id, status=state, completed_at=self.env.now)
        if all(j.state != "RUNNING" for j in self.jobs.values()) and not self.all_done.triggered:
            self.all_done.succeed()

    # ---------- Sınama işi ve geriye dönük iptal ----------

    def _spot_passed(self, r: SimReplica) -> bool:
        return r.state == "RETURNED_OK" and r.output == self.truth(r.task_key)

    def spot_result(self, w: SimWorker, r: SimReplica) -> None:
        if r.state != "RETURNED_OK":
            return  # WASM hatası (fatal) yanlış sonuç değildir; itibar olayı üretmez
        passed = self._spot_passed(r)
        self.observe(w, r.id, "spot_pass" if passed else "spot_fail")
        job = self.jobs[self.spot_tasks[r.task_key].job_id]
        if passed and job.state != "RUNNING":
            self.rec.replica(r.id, paid=1)  # iş sınama dönmeden bitti: ödeme bu sınamayla tamamlanır
        if not passed:
            self.retroactive_cancel(w)

    def retroactive_cancel(self, w: SimWorker) -> None:
        """Sınamada yakalanan worker'ın ödenmemiş işlerde tek kopyayla kabul edilmiş sonuçları
        geçersiz sayılır; bu görevler ve çıktılarını kullanan alt görevler yeniden kuyruğa alınır.
        Bitmiş (ödenmiş) işlerdeki sonuçlar geri alınamaz; yanlış olanlar ayrıca sayılır (§4)."""
        for job in self.jobs.values():
            single = [k for k in job.task_keys
                      if self.tasks[k].state == "ACCEPTED" and self.tasks[k].accepted_single_by == w.id]
            if not single:
                continue
            if job.state != "RUNNING":
                for k in single:
                    if self.tasks[k].accepted_output != self.truth(k) and k not in self._late_flagged:
                        self._late_flagged.add(k)
                        self.stats["late_detected_wrong"] += 1
                continue
            affected = set(single)
            for k in job.task_keys:  # topolojik sıra: üst görevler önce
                t = self.tasks[k]
                if k in affected or any(f"{job.id}/{d}" in affected for d in t.deps):
                    affected.add(k)
                    self._reset_task(job, t)

    def _reset_task(self, job: SimJob, t: SimTask) -> None:
        if t.state == "WAITING":
            return
        if t.state == "ACCEPTED":
            self.stats["tasks_invalidated"] += 1
        for i in t.replica_ids:
            if self.replicas[i].state in ("QUEUED", "ASSIGNED"):
                self.cancel_replica(self.replicas[i])
        t.replica_ids = []
        t.pay_ids = []
        t.accepted_output = None
        t.accepted_single_by = None
        self.rec.task(t.key, accepted_output=None, accepted_at=None)
        if all(self.tasks[f"{job.id}/{d}"].state == "ACCEPTED" for d in t.deps):
            self.make_ready(t)
        else:
            t.state = "WAITING"
            self.rec.task(t.key, state="WAITING")

    # ---------- İtibar ----------

    def observe(self, w: SimWorker, replica_id: int, kind: str) -> None:
        """Doğrulanmış bir olayı worker'ın itibarına işler ve kaydeder."""
        w.alpha, w.beta = reputation.update(w.alpha, w.beta, kind, self.rep_params)
        w.consecutive_valid = w.consecutive_valid + 1 if kind in CORRECT_EVENTS else 0
        self.rec.rep_event(w.id, replica_id, kind, w.alpha, w.beta, self.env.now)

    # ---------- Görünümler ----------

    def task_view(self, t: SimTask) -> TaskView:
        return TaskView(key=t.key, module=t.module, cost=t.cost)

    def replica_view(self, r: SimReplica) -> ReplicaView:
        return ReplicaView(id=r.id, task_id=r.task_key, worker_id=r.worker_id, state=r.state, output=r.output,
                           fatal=r.fatal, alone_ok=r.alone_ok)

    def worker_view(self, w: SimWorker) -> WorkerView:
        return WorkerView(id=w.id, speed_ema=w.speed_ema, alpha=w.alpha, beta=w.beta,
                          trusted=reputation.is_trusted(w.alpha, w.beta, self.rep_params),
                          consecutive_valid=w.consecutive_valid)
