"""Zamanlama ve doğrulama stratejileri (Kapsam Dokümanı v2 §5).

Zamanlayıcılar yalnızca *worker seçimini* belirler; hazır görevlerin sırası her konfigürasyonda
FIFO'dur (Hafta 6 kararı), böylece RQ3 yalnızca worker seçimini karşılaştırır.

Doğrulayıcılar:
    fixed2          her görev 2 kopya; iki eşleşen sonuç kabul, uyuşmazlıkta yeni kopya
    fixed3          her görev 3 kopya; canlı kopyaların hepsi dönünce çoğunluk (≥ 2 eşleşen)
    adaptive        güvenilir worker (R ≥ τ, α ≥ α_min) tek kopya; değilse 2 kopya; sınama işi açık
    boinc_adaptive  ek taban, yalnızca simülatör: N < 10 her zaman, N ≥ 10 ise 1/N olasılıkla replike
    accept_first    alt sınır: ilk sonuç kabul, doğrulama yok
"""

from __future__ import annotations

from typing import Optional

from ..reputation import score
from .base import (AssignDecision, Decision, ReplicaView, Scheduler, TaskView, Verifier, WorkerView,
                   active_count, agreeing_output, any_live)

BOINC_MIN_CONSECUTIVE = 10  # BOINC kaynak kodu (sched_send.cpp), Kapsam v2 §5


# ---------- Zamanlayıcılar ----------

def _optimistic_speed(idle: list[WorkerView]) -> float:
    """Henüz ölçülmemiş worker'ın hızı: boştakiler arasındaki en yüksek ölçülmüş hız (yoksa 1).
    İyimser varsayım yeni worker'ların denenmesini ve hızlarının ölçülmesini sağlar."""
    measured = [w.speed_ema for w in idle if w.speed_ema is not None]
    return max(measured) if measured else 1.0


def _best(idle: list[WorkerView], value) -> Optional[WorkerView]:
    """En yüksek değerli worker; eşitlikte önce ölçülmemiş olan, sonra boştakiler listesindeki sıra."""
    if not idle:
        return None
    best_i = max(range(len(idle)), key=lambda i: (value(idle[i]), idle[i].speed_ema is None, -i))
    return idle[best_i]


class FifoScheduler:
    """İş isteyen ilk worker (boştakiler listesinin başı)."""

    name = "fifo"

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]:
        return idle[0] if idle else None


class FastestScheduler:
    """Görev büyüklüğüne göre normalize edilmiş hız EMA'sı (cost/ms) en yüksek olan worker."""

    name = "fastest"

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]:
        opt = _optimistic_speed(idle)
        return _best(idle, lambda w: w.speed_ema if w.speed_ema is not None else opt)


class ReputationScheduler:
    """Atama puanı = R × hız; en yüksek puanlı worker."""

    name = "reputation"

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]:
        opt = _optimistic_speed(idle)
        return _best(idle, lambda w: score(w.alpha, w.beta) * (w.speed_ema if w.speed_ema is not None else opt))


# ---------- Doğrulayıcılar ----------

class AcceptFirstVerifier:
    """İlk başarılı sonucu kabul eder (güvensiz; yalnızca karşılaştırma tabanı)."""

    name = "accept_first"
    uses_spot_checks = False

    def initial_replicas(self, task: TaskView) -> int:
        return 1

    def on_assign(self, task, replicas, worker, u) -> AssignDecision:
        return AssignDecision(extra=0, alone_ok=True)

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision:
        for r in replicas:
            if r.state == "RETURNED_OK":
                return Decision("accept", output=r.output)
        if any_live(replicas):
            return Decision("wait")
        return Decision("need_more", count=1)


class FixedVerifier:
    """Sabit k kopya. Canlı kopyaların hepsi dönünce karar verilir: ≥ 2 eşleşen sonuç kabul,
    yoksa bir kopya daha (üst sınırı koordinatör uygular: maxReplicas, toplam deneme maxReplicas × 3)."""

    uses_spot_checks = False

    def __init__(self, k: int):
        self.k = k
        self.name = f"fixed{k}"

    def initial_replicas(self, task: TaskView) -> int:
        return self.k

    def on_assign(self, task, replicas, worker, u) -> AssignDecision:
        return AssignDecision(extra=0, alone_ok=False)

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision:
        if any_live(replicas):
            return Decision("wait")
        out = agreeing_output(replicas)
        if out is not None:
            return Decision("accept", output=out)
        return Decision("need_more", count=1)


class _ConditionalReplication:
    """Uyarlanabilir ve BOINC adaptive'in ortak kuralı: kopya, atandığı worker'a göre tek başına
    yeterli sayılabilir (`alone_ok`). Görevdeki tek etkin kopya yeterli değilse ikinci kopya hemen
    açılır. Bir görevde yeterli sayılmayan bir kopya bir kez atandıysa o görev artık iki eşleşen
    sonuç bekler; böylece güvenilmez worker her zaman doğrulanır."""

    uses_spot_checks = False

    def initial_replicas(self, task: TaskView) -> int:
        return 1

    def _alone_ok(self, worker: WorkerView, u: float) -> bool:
        raise NotImplementedError

    def on_assign(self, task, replicas, worker, u) -> AssignDecision:
        alone = self._alone_ok(worker, u)
        extra = 1 if (not alone and active_count(replicas) == 1) else 0
        return AssignDecision(extra=extra, alone_ok=alone)

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision:
        out = agreeing_output(replicas)
        if out is not None:
            return Decision("accept", output=out)
        ok = [r for r in replicas if r.state == "RETURNED_OK"]
        assigned = [r for r in replicas if r.state in ("ASSIGNED", "RETURNED_OK")]
        if len(ok) == 1 and all(r.alone_ok for r in assigned):
            return Decision("accept", output=ok[0].output)
        if any_live(replicas):
            return Decision("wait")
        return Decision("need_more", count=1)


class AdaptiveVerifier(_ConditionalReplication):
    """İtibar tabanlı uyarlanabilir doğrulama: güvenilir worker (R ≥ τ ve α ≥ α_min) tek kopya.
    Sınama işleri ve geriye dönük iptal koordinatörde (uses_spot_checks)."""

    name = "adaptive"
    uses_spot_checks = True

    def _alone_ok(self, worker: WorkerView, u: float) -> bool:
        return worker.trusted


class BoincAdaptiveVerifier(_ConditionalReplication):
    """BOINC adaptive replication (ek taban, yalnızca simülatör): art arda N doğrulanmış sonucu
    olan worker'ın görevi N < 10 ise her zaman, N ≥ 10 ise 1/N olasılıkla replike edilir."""

    name = "boinc_adaptive"

    def _alone_ok(self, worker: WorkerView, u: float) -> bool:
        n = worker.consecutive_valid
        return n >= BOINC_MIN_CONSECUTIVE and u >= 1.0 / n


SCHEDULERS: dict[str, Scheduler] = {s.name: s for s in (FifoScheduler(), FastestScheduler(), ReputationScheduler())}
VERIFIERS: dict[str, Verifier] = {v.name: v for v in (FixedVerifier(2), FixedVerifier(3), AdaptiveVerifier(),
                                                       BoincAdaptiveVerifier(), AcceptFirstVerifier())}

__all__ = ["SCHEDULERS", "VERIFIERS", "AssignDecision", "Decision", "ReplicaView", "TaskView", "WorkerView"]
