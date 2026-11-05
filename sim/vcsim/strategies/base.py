"""Strateji arayüzleri. coordinator/src/strategies.ts ile bire bir aynı anlam:

    Scheduler.pick(task, idle)            → seçilen worker ya da None
    Verifier.initial_replicas(task)       → görev HAZIR olduğunda kaç kopya
    Verifier.on_result(task, replicas)    → accept | need_more | wait | fail
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional, Protocol

ReplicaState = Literal["QUEUED", "ASSIGNED", "RETURNED_OK", "RETURNED_ERROR", "TIMED_OUT", "LOST", "CANCELLED"]


@dataclass(frozen=True)
class WorkerView:
    id: str
    speed_ema: Optional[float]
    alpha: float
    beta: float


@dataclass(frozen=True)
class ReplicaView:
    id: int
    task_id: str
    worker_id: Optional[str]
    state: ReplicaState
    output: Optional[str]
    fatal: bool


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


class Scheduler(Protocol):
    name: str

    def pick(self, task: TaskView, idle: list[WorkerView]) -> Optional[WorkerView]: ...


class Verifier(Protocol):
    name: str

    def initial_replicas(self, task: TaskView) -> int: ...

    def on_result(self, task: TaskView, replicas: list[ReplicaView]) -> Decision: ...
