"""Olay kaydı. Sütunlar koordinatörün SQLite tablolarıyla aynıdır (coordinator/src/db/db.ts);
böylece metrics.py iki kaynağı da aynı kodla işler. Zamanlar ms."""

from __future__ import annotations

from pathlib import Path

import pandas as pd

JOB_COLUMNS = ["id", "strategy_sched", "strategy_verif", "status", "submitted_at", "completed_at"]
TASK_COLUMNS = ["id", "job_id", "dag_task_id", "module", "input_resolved", "cost", "state",
                "accepted_output", "ready_at", "accepted_at", "expected_output"]
REPLICA_COLUMNS = ["id", "task_id", "worker_id", "is_spotcheck", "expected_output", "state",
                   "created_at", "assigned_at", "deadline_at", "returned_at", "output",
                   "duration_ms", "load_ms", "fatal", "paid"]


class Recorder:
    def __init__(self) -> None:
        self.jobs: dict[str, dict] = {}
        self.tasks: dict[str, dict] = {}
        self.replicas: dict[int, dict] = {}

    def job(self, id: str, **fields) -> None:
        self.jobs.setdefault(id, {c: None for c in JOB_COLUMNS} | {"id": id}).update(fields)

    def task(self, id: str, **fields) -> None:
        self.tasks.setdefault(id, {c: None for c in TASK_COLUMNS} | {"id": id}).update(fields)

    def replica(self, id: int, **fields) -> None:
        self.replicas.setdefault(id, {c: None for c in REPLICA_COLUMNS} | {"id": id, "is_spotcheck": 0, "paid": 0}).update(fields)

    def frames(self) -> dict[str, pd.DataFrame]:
        return {
            "jobs": pd.DataFrame(list(self.jobs.values()), columns=JOB_COLUMNS),
            "tasks": pd.DataFrame(list(self.tasks.values()), columns=TASK_COLUMNS),
            "replicas": pd.DataFrame(list(self.replicas.values()), columns=REPLICA_COLUMNS),
        }

    def write(self, out_dir: Path) -> None:
        out_dir.mkdir(parents=True, exist_ok=True)
        for name, df in self.frames().items():
            df.to_parquet(out_dir / f"{name}.parquet", index=False)
