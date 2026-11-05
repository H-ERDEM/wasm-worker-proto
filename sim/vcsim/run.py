"""Bir konfigürasyon × bir tohum → olay tabloları (Parquet) + summary.json.

    python -m vcsim.run --config default --seed 1 --out experiments/data/sim/ornek
    python -m vcsim.run --seed 3 --set faults.f=0.2 --set workers.session_mean_s=600
    python -m vcsim.run --set 'workload.dag_files=["shared/examples/three-task-dag.json"]'
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import simpy

from . import REPO_ROOT
from .config import load_config
from .coordinator import SimCoordinator
from .events import Recorder
from .metrics import compute_metrics
from .rng import Streams
from .workload import build_workload


def simulate(cfg: dict, seed: int) -> tuple[dict, Recorder, dict]:
    """Simülasyonu çalıştırır; (özet, kayıt, iş yükü bilgisi) döndürür."""
    streams = Streams(seed)
    wl = dict(cfg["workload"])
    wl["dag_files"] = [str((REPO_ROOT / p) if not Path(p).is_absolute() else p) for p in wl.get("dag_files", [])]
    dags = build_workload(wl, streams["workload"])

    env = simpy.Environment()
    rec = Recorder()
    coord = SimCoordinator(env, cfg, streams, rec)
    for _ in range(cfg["workers"]["initial"]):
        coord.add_worker()

    rate = cfg["workers"].get("arrival_rate_per_s") or 0.0
    if rate > 0:
        def arrivals():
            while True:
                yield env.timeout(float(streams["arrivals"].exponential(1000.0 / rate)))
                coord.add_worker()
        env.process(arrivals())

    for dag in dags:
        coord.submit_job(dag)

    max_ms = cfg["max_time_s"] * 1000.0
    env.run(until=simpy.AnyOf(env, [coord.all_done, env.timeout(max_ms)]))

    summary = compute_metrics(rec.frames(), cfg["shared"]["unitPrice"])
    summary.update({
        "seed": seed,
        "scheduler": coord.scheduler.name,
        "verifier": coord.verifier.name,
        "workers_total": len(coord.workers),
        "workers_faulty": sum(w.faulty for w in coord.workers.values()),
        "sim_end_ms": round(float(env.now), 3),
        "timed_out": not coord.all_done.triggered,
    })
    return summary, rec, {"dags": dags, "workers": coord.workers}


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="vcsim: gönüllü hesaplama simülatörü")
    ap.add_argument("--config", default="default", help="sim/configs/<ad>.json ya da dosya yolu")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--set", action="append", default=[], metavar="ANAHTAR=DEĞER",
                    help="üzerine yaz, ör. faults.f=0.2 veya shared.maxReplicas=3")
    ap.add_argument("--out", default=None, help="çıktı klasörü (varsayılan experiments/data/sim/<config>-s<seed>)")
    args = ap.parse_args(argv)

    cfg = load_config(args.config, args.set)
    t0 = time.perf_counter()
    summary, rec, _ = simulate(cfg, args.seed)
    wall = time.perf_counter() - t0

    out = Path(args.out) if args.out else REPO_ROOT / "experiments" / "data" / "sim" / f"{Path(args.config).stem}-s{args.seed}"
    rec.write(out)
    (out / "config.json").write_text(json.dumps(cfg, indent=2, sort_keys=True), encoding="utf-8")
    (out / "summary.json").write_text(json.dumps(summary, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps(summary, indent=2, sort_keys=True))
    print(f"→ {out}  ({wall:.2f} sn)")


if __name__ == "__main__":
    main()
