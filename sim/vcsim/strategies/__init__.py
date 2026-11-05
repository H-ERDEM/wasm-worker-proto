"""7. hafta yer tutucu stratejileri; 8. hafta gerçek stratejiler buraya eklenir."""

from __future__ import annotations

from typing import Optional

from .base import Decision, ReplicaView, Scheduler, TaskView, Verifier, WorkerView


class FifoScheduler:
    name = "fifo"

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]:
        return idle[0] if idle else None


class AcceptFirstVerifier:
    """İlk başarılı sonucu kabul eder (güvensiz; yalnızca karşılaştırma tabanı)."""

    name = "accept_first"

    def initial_replicas(self, task: TaskView) -> int:
        return 1

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision:
        for r in replicas:
            if r.state == "RETURNED_OK":
                return Decision("accept", output=r.output)
        if any(r.state in ("QUEUED", "ASSIGNED") for r in replicas):
            return Decision("wait")
        return Decision("need_more", count=1)


SCHEDULERS: dict[str, Scheduler] = {"fifo": FifoScheduler()}
VERIFIERS: dict[str, Verifier] = {"accept_first": AcceptFirstVerifier()}

__all__ = ["SCHEDULERS", "VERIFIERS", "Decision", "ReplicaView", "TaskView", "WorkerView"]
