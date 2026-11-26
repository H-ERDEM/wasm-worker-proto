"""Strateji arayüzleri. coordinator/src/strategies.ts ile bire bir aynı anlam:

    Scheduler.pick(task, idle)                       → seçilen worker ya da None
    Verifier.initial_replicas(task)                  → görev HAZIR olduğunda kaç kopya
    Verifier.on_assign(task, replicas, worker, u)    → AssignDecision(extra, alone_ok)
    Verifier.on_result(task, replicas)               → accept | need_more | wait | fail
    Verifier.uses_spot_checks                        → koordinatör sınama işi üretsin mi

`on_assign` bir kopya bir worker'a atandığı anda çağrılır (8. hafta, ROADMAP karar kaydı
2026-11-23). Kopya sayısının görevi alan worker'a bağlı olduğu stratejiler (uyarlanabilir,
BOINC adaptive) bu kararı burada verir: `extra` kadar ek kopya hemen kuyruğa girer ve paralel
çalışır; `alone_ok`, bu kopyanın sonucunun tek başına kabul edilip edilemeyeceğidir ve kopyaya
anlık görüntü olarak yazılır (worker'ın güveni sonradan değişse de değişmez).

Sınama işleri ve geriye dönük iptal doğrulayıcının değil koordinatörün işidir; doğrulayıcı
yalnızca `uses_spot_checks` ile bunları açar. Oran ortak parametredir (`spotCheckRate`).
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Literal, Optional, Protocol

ReplicaState = Literal["QUEUED", "ASSIGNED", "RETURNED_OK", "RETURNED_ERROR", "TIMED_OUT", "LOST", "CANCELLED"]
ACTIVE_STATES = ("QUEUED", "ASSIGNED", "RETURNED_OK")
LIVE_STATES = ("QUEUED", "ASSIGNED")


@dataclass(frozen=True)
class WorkerView:
    id: str
    speed_ema: Optional[float]
    alpha: float
    beta: float
    trusted: bool = False  # koordinatör reputation.is_trusted ile hesaplar
    consecutive_valid: int = 0  # art arda doğrulanmış doğru sonuç (BOINC adaptive tabanı)


@dataclass(frozen=True)
class ReplicaView:
    id: int
    task_id: str
    worker_id: Optional[str]
    state: ReplicaState
    output: Optional[str]
    fatal: bool
    alone_ok: bool = False  # atama anındaki on_assign kararı


@dataclass(frozen=True)
class TaskView:
    key: str
    module: str
    cost: float


@dataclass(frozen=True)
class Decision:
    kind: Literal["accept", "need_more", "wait", "fail"]
    output: Optional[str] = None
    count: int = 0
    reason: str = ""


@dataclass(frozen=True)
class AssignDecision:
    extra: int = 0
    alone_ok: bool = False


class Scheduler(Protocol):
    name: str

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]: ...


class Verifier(Protocol):
    name: str
    uses_spot_checks: bool

    def initial_replicas(self, task: TaskView) -> int: ...

    def on_assign(self, task: TaskView, replicas: list[ReplicaView], worker: WorkerView, u: float) -> AssignDecision: ...

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision: ...


# ---------- Stratejilerin ortak yardımcıları ----------

def agreeing_output(replicas: list[ReplicaView], quorum: int = 2) -> Optional[str]:
    """En az `quorum` başarılı kopyanın verdiği çıktı (varsa). Beraberlikte ilk ulaşan kazanır."""
    counts = Counter(r.output for r in replicas if r.state == "RETURNED_OK")
    for out, n in counts.items():
        if n >= quorum:
            return out
    return None


def any_live(replicas: list[ReplicaView]) -> bool:
    return any(r.state in LIVE_STATES for r in replicas)


def active_count(replicas: list[ReplicaView]) -> int:
    """Kuyrukta, çalışmakta ya da başarılı dönmüş kopya sayısı (kaybolan/hatalı/iptal hariç)."""
    return sum(r.state in ACTIVE_STATES for r in replicas)
