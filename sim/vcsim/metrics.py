"""Metrikler (Kapsam Dokümanı §6). Simülasyonun içinde değil, olay tablolarından hesaplanır;
aynı fonksiyon hem simülatör çıktısına hem koordinatörün SQLite kaydına uygulanır."""

from __future__ import annotations

import pandas as pd


def compute_metrics(frames: dict[str, pd.DataFrame], unit_price: float) -> dict:
    jobs, tasks, reps = frames["jobs"], frames["tasks"], frames["replicas"]
    finished = jobs[jobs["completed_at"].notna()]
    completed = jobs[jobs["status"] == "COMPLETED"]
    accepted = tasks[tasks["state"] == "ACCEPTED"]
    known = accepted[accepted["expected_output"].notna()]
    wrong = known[known["accepted_output"] != known["expected_output"]]
    wrong_jobs = set(wrong["job_id"])
    paid_units = int(reps["paid"].fillna(0).astype(int).sum())

    makespan = (finished["completed_at"].max() - jobs["submitted_at"].min()) if len(finished) else None
    per_job = (completed["completed_at"] - completed["submitted_at"]) if len(completed) else pd.Series(dtype=float)
    state_counts = reps["state"].value_counts().to_dict()

    def r(x, nd=6):
        return None if x is None or pd.isna(x) else round(float(x), nd)

    return {
        "jobs": int(len(jobs)),
        "jobs_completed": int(len(completed)),
        "jobs_failed": int((jobs["status"] == "FAILED").sum()),
        "tasks": int(len(tasks)),
        "tasks_failed": int((tasks["state"] == "FAILED").sum()),
        "makespan_ms": r(makespan, 3),
        "job_makespan_mean_ms": r(per_job.mean(), 3) if len(per_job) else None,
        "cost_per_job": r(paid_units * unit_price / len(completed)) if len(completed) else None,
        "paid_units": paid_units,
        "task_error_rate": r(len(wrong) / len(known)) if len(known) else None,
        "job_error_rate": r(len(wrong_jobs & set(completed["id"])) / len(completed)) if len(completed) else None,
        "tasks_with_truth": int(len(known)),
        "replicas_per_task": r(len(reps) / len(tasks)) if len(tasks) else None,
        "replicas_lost": int(state_counts.get("LOST", 0)),
        "replicas_timed_out": int(state_counts.get("TIMED_OUT", 0)),
        "replicas_error": int(state_counts.get("RETURNED_ERROR", 0)),
    }
