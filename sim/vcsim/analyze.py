"""Ortak analiz: simülatör çıktısı ve koordinatörün SQLite kaydı için aynı metrik tablosu (Ç7.5).

    python -m vcsim.analyze experiments/data/sim/default-s1  coordinator/coordinator.db

Koordinatör kaydında doğru sonuç bilinmez; kabul edilen her görevin beklenen çıktısı
vcsim.reference ile (görevin çözülmüş girdisinden) hesaplanır. DAG'de üst görev yanlış kabul
edildiyse alt görevin beklenen çıktısı o yanlış girdiye göre hesaplanır; yanlış üst görev zaten
işi hatalı saydırdığından iş düzeyinde hatalı oran etkilenmez.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

import pandas as pd

from .config import load_config
from .events import JOB_COLUMNS, REPLICA_COLUMNS, TASK_COLUMNS
from .metrics import compute_metrics
from .reference import expected_output


def load_sim(run_dir: Path) -> dict[str, pd.DataFrame]:
    return {name: pd.read_parquet(run_dir / f"{name}.parquet") for name in ("jobs", "tasks", "replicas")}


def load_coordinator(db_path: Path, with_truth: bool = True) -> dict[str, pd.DataFrame]:
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        jobs = pd.read_sql_query("SELECT * FROM jobs", con)
        tasks = pd.read_sql_query("SELECT * FROM tasks", con)
        reps = pd.read_sql_query("SELECT * FROM replicas", con)
    finally:
        con.close()
    if with_truth:
        tasks["expected_output"] = [
            expected_output(m, i) if s == "ACCEPTED" and i else None
            for m, i, s in zip(tasks["module"], tasks["input_resolved"], tasks["state"])
        ]
    else:
        tasks["expected_output"] = None
    for df, cols in ((jobs, JOB_COLUMNS), (tasks, TASK_COLUMNS), (reps, REPLICA_COLUMNS)):
        for c in cols:
            if c not in df.columns:
                df[c] = None
    return {"jobs": jobs[JOB_COLUMNS], "tasks": tasks[TASK_COLUMNS], "replicas": reps[REPLICA_COLUMNS]}


def load_any(path: Path, with_truth: bool = True) -> dict[str, pd.DataFrame]:
    return load_sim(path) if path.is_dir() else load_coordinator(path, with_truth)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Simülatör ve koordinatör kayıtları için ortak metrik tablosu")
    ap.add_argument("paths", nargs="+", type=Path, help="simülatör çıktı klasörü ya da koordinatör .db dosyası")
    ap.add_argument("--unit-price", type=float, default=None, help="varsayılan: shared/config unitPrice")
    ap.add_argument("--no-truth", action="store_true", help="koordinatör kaydı için referans hesaplamayı atla")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args(argv)

    price = args.unit_price if args.unit_price is not None else load_config()["shared"]["unitPrice"]
    table = {str(p): compute_metrics(load_any(p, not args.no_truth), price) for p in args.paths}
    if args.json:
        print(json.dumps(table, indent=2))
    else:
        print(pd.DataFrame(table).to_string())


if __name__ == "__main__":
    main()
