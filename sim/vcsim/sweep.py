"""Konfigürasyon taraması: zamanlayıcı × doğrulayıcı × hata düzeyi × tohum → tek özet tablosu.

    python -m vcsim.sweep --name hafta8-ilk \\
        --schedulers fifo --verifiers fixed2,fixed3,adaptive \\
        --faults none,random:0.1,random:0.2,random:0.3,collude:0.1,collude:0.2,collude:0.3 \\
        --seeds 1-30

Hata düzeyi biçimi: `none` | `random:<f>` | `collude:<f>`, isteğe bağlı `:<s>` (varsayılan s = 1).
Her koşu bir satırdır (konfigürasyon sütunları + summary.json alanları); sonuç
experiments/data/sim/<ad>/summaries.parquet dosyasına yazılır. Tüm stratejiler aynı tohumları
kullanır (ortak rastgele sayılar), böylece eşleştirilmiş karşılaştırma yapılabilir (Kapsam v2 §6).
"""

from __future__ import annotations

import argparse
import itertools
import json
import os
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pandas as pd

from . import REPO_ROOT
from .config import load_config
from .run import simulate


def parse_fault(spec: str) -> dict:
    """`none`, `random:0.2`, `collude:0.3:0.5` → faults sözlüğü ve etiketler."""
    parts = spec.split(":")
    if parts[0] == "none":
        return {"model": "none", "f": 0.0, "s": 1.0, "collusion": False}
    if parts[0] not in ("random", "collude") or len(parts) not in (2, 3):
        raise ValueError(f"geçersiz hata düzeyi: {spec!r} (beklenen none | random:<f> | collude:<f>[:<s>])")
    s = float(parts[2]) if len(parts) == 3 else 1.0
    return {"model": parts[0], "f": float(parts[1]), "s": s, "collusion": parts[0] == "collude"}


def parse_seeds(spec: str) -> list[int]:
    out: list[int] = []
    for part in spec.split(","):
        if "-" in part:
            a, b = part.split("-")
            out.extend(range(int(a), int(b) + 1))
        else:
            out.append(int(part))
    return out


def _one(job: tuple) -> dict:
    config, overrides, sched, verif, fault, seed = job
    cfg = load_config(config, {**overrides, "shared": {**overrides.get("shared", {}), "scheduler": sched,
                                                       "verifier": verif},
                               "faults": {"f": fault["f"], "s": fault["s"], "collusion": fault["collusion"]}})
    t0 = time.perf_counter()
    summary, _, _ = simulate(cfg, seed)
    return {"scheduler": sched, "verifier": verif, "fault_model": fault["model"], "f": fault["f"], "s": fault["s"],
            "seed": seed, "wall_s": round(time.perf_counter() - t0, 3), "unit_price": cfg["shared"]["unitPrice"],
            **{k: v for k, v in summary.items() if k not in ("seed", "scheduler", "verifier")}}


def run_sweep(schedulers: list[str], verifiers: list[str], faults: list[str], seeds: list[int],
              config: str = "default", overrides: dict | None = None, workers: int | None = None) -> pd.DataFrame:
    overrides = overrides or {}
    jobs = [(config, overrides, sc, v, parse_fault(fs), sd)
            for sc, v, fs, sd in itertools.product(schedulers, verifiers, faults, seeds)]
    workers = workers or os.cpu_count() or 1
    if workers == 1:
        rows = [_one(j) for j in jobs]
    else:
        with ProcessPoolExecutor(max_workers=workers) as ex:
            rows = list(ex.map(_one, jobs, chunksize=4))
    return pd.DataFrame(rows)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="vcsim konfigürasyon taraması")
    ap.add_argument("--name", required=True, help="çıktı klasörü adı (experiments/data/sim/<ad>)")
    ap.add_argument("--config", default="default")
    ap.add_argument("--schedulers", default="fifo")
    ap.add_argument("--verifiers", default="fixed2,fixed3,adaptive")
    ap.add_argument("--faults", default="none,random:0.1,random:0.2,random:0.3")
    ap.add_argument("--seeds", default="1-30")
    ap.add_argument("--workers", type=int, default=None, help="paralel süreç sayısı (varsayılan: çekirdek sayısı)")
    ap.add_argument("--out", default=None, help="varsayılan experiments/data/sim/<ad>")
    args = ap.parse_args(argv)

    seeds = parse_seeds(args.seeds)
    spec = {"schedulers": args.schedulers.split(","), "verifiers": args.verifiers.split(","),
            "faults": args.faults.split(","), "seeds": seeds}
    t0 = time.perf_counter()
    df = run_sweep(spec["schedulers"], spec["verifiers"], spec["faults"], seeds, args.config, workers=args.workers)
    out = Path(args.out) if args.out else REPO_ROOT / "experiments" / "data" / "sim" / args.name
    out.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out / "summaries.parquet", index=False)
    (out / "sweep.json").write_text(json.dumps({**spec, "config": args.config,
                                                "shared": load_config(args.config)["shared"]},
                                               indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"{len(df)} koşu, {time.perf_counter() - t0:.1f} sn → {out}")


if __name__ == "__main__":
    main()
