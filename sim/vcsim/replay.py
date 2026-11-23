"""Görsel simülasyon için dışa aktarım (Hafta 9, 9.6).

Aynı senaryoyu aynı tohumla iki doğrulama stratejisiyle koşar ve olay kaydını
`docs/demo/simulasyon.html` sayfasının okuyacağı tek bir dosyaya yazar. Sayfa sunucu
gerektirmez: veri `window.REPLAY = {...}` biçiminde bir .js dosyasındadır (file:// ile
açılınca fetch çalışmadığı için JSON yerine).

    python -m vcsim.replay                                   # varsayılan iki demo senaryosu
    python -m vcsim.replay --seed 4 --verifiers fixed2 adaptive --set faults.f=0.3

Olaylar simülatörün kendi kayıt çağrılarından üretilir (Recorder'ın zaman damgalı kopyası);
koordinatör mantığına dokunulmaz. Sayfadaki son sayaçlar summary.json ile aynı çıkar
(tests/test_replay.py).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import REPO_ROOT
from .config import deep_merge, load_config, parse_value, set_path
from .events import Recorder
from .reputation import RepParams, is_trusted, score
from .run import simulate

# Ara demo senaryoları: 16 tarayıcı, 10 DAG × 40 görev, hatalı worker oranı f = %20, s = 1.
# Aynı tohum → aynı worker'lar ve aynı hatalı küme (ortak rastgele sayılar); iki senaryo yalnızca
# hata modelinde ayrılır (Kapsam §5).
DEMO = {
    "workload": {"n_dags": 10, "tasks_per_dag": 40},
    "workers": {"initial": 16},
    "faults": {"f": 0.2, "s": 1.0, "collusion": True},
}
SCENARIOS = [
    {"key": "colluding", "title": "Colluding, f = %20", "set": {"faults": {"collusion": True}}},
    {"key": "random", "title": "Rastgele hata, f = %20", "set": {"faults": {"collusion": False}}},
]
DEFAULT_OUT = REPO_ROOT / "docs" / "demo" / "replay-data.js"
SUMMARY_KEYS = ["makespan_ms", "paid_units", "cost_per_job", "jobs", "jobs_completed", "jobs_failed", "tasks",
                "tasks_wrong", "task_error_rate", "replicas_per_task", "spotchecks", "spotchecks_failed",
                "tasks_invalidated", "late_detected_wrong"]


class TraceRecorder(Recorder):
    """Recorder'ın her çağrısını simülasyon zamanıyla birlikte sıralı bir listeye de yazar."""

    def __init__(self, env) -> None:
        super().__init__()
        self.env = env
        self.trace: list[tuple[float, str, object, dict]] = []

    def job(self, id, **fields):
        self.trace.append((self.env.now, "job", id, fields))
        super().job(id, **fields)

    def task(self, id, **fields):
        self.trace.append((self.env.now, "task", id, fields))
        super().task(id, **fields)

    def replica(self, id, **fields):
        self.trace.append((self.env.now, "replica", id, fields))
        super().replica(id, **fields)

    def rep_event(self, worker_id, replica_id, kind, alpha_after, beta_after, t):
        self.trace.append((self.env.now, "rep", worker_id, {"kind": kind, "alpha": alpha_after, "beta": beta_after}))
        super().rep_event(worker_id, replica_id, kind, alpha_after, beta_after, t)


def _r(x: float, nd: int = 1) -> float:
    return round(float(x), nd)


def to_timeline(rec: TraceRecorder, cfg: dict, dags: list[dict]) -> dict:
    """Ham kaydı sayfanın oynatacağı olaylara çevirir."""
    p = RepParams.from_shared(cfg["shared"])
    rmeta: dict[int, dict] = {}  # kopya → görev, sınama mı, beklenen çıktı, worker
    tmeta: dict[str, dict] = {}  # görev → beklenen çıktı
    jobs: list[dict] = []
    job_index: dict[str, dict] = {}
    events: list[dict] = []

    for t, table, id, f in rec.trace:
        t = _r(t)
        if table == "job":
            if "submitted_at" in f:
                dag = dags[len(jobs)]
                deps = {x["id"]: list(x.get("deps", [])) for x in dag["tasks"]}
                mods = {x["id"]: x["module"] for x in dag["tasks"]}
                j = {"id": id, "shape": dag.get("jobId", ""), "tasks": [], "deps": deps, "modules": mods}
                jobs.append(j)
                job_index[id] = j
            if f.get("status") in ("COMPLETED", "FAILED"):
                events.append({"t": t, "e": "job", "job": id, "state": f["status"]})
        elif table == "task":
            if "expected_output" in f:
                tmeta[id] = {"expected": f["expected_output"]}
                job_index[f["job_id"]]["tasks"].append(f["dag_task_id"])
            if f.get("accepted_output", 0) is None:
                events.append({"t": t, "e": "invalidate", "task": id})
            if "state" in f and "expected_output" not in f:  # oluşturma kaydı (WAITING) hariç
                ev = {"t": t, "e": "task", "task": id, "state": f["state"]}
                if f["state"] == "ACCEPTED":
                    ev["wrong"] = f["accepted_output"] != tmeta[id]["expected"]
                events.append(ev)
        elif table == "replica":
            m = rmeta.setdefault(id, {"spot": False})
            if "task_id" in f:
                m["task"] = f["task_id"]
                m["expected"] = f.get("expected_output")
                m["spot"] = bool(f.get("is_spotcheck"))
            st = f.get("state")
            if st == "ASSIGNED":
                m["worker"] = f["worker_id"]
                events.append({"t": t, "e": "assign", "r": id, "w": f["worker_id"], "task": m["task"], "spot": m["spot"]})
            elif st in ("RETURNED_OK", "RETURNED_ERROR"):
                events.append({"t": t, "e": "return", "r": id, "w": m.get("worker"), "task": m["task"], "spot": m["spot"],
                               "ok": st == "RETURNED_OK", "wrong": st == "RETURNED_OK" and f.get("output") != m["expected"]})
            elif st in ("LOST", "TIMED_OUT", "CANCELLED"):
                events.append({"t": t, "e": "close", "r": id, "w": m.get("worker"), "task": m.get("task"), "state": st})
            if f.get("paid") == 1:
                events.append({"t": t, "e": "paid", "r": id})
        elif table == "rep":
            events.append({"t": t, "e": "rep", "w": id, "kind": f["kind"], "R": round(score(f["alpha"], f["beta"]), 4),
                           "alpha": round(f["alpha"], 3), "trusted": is_trusted(f["alpha"], f["beta"], p)})
    return {"jobs": jobs, "events": events}


def run_pair(cfg: dict, seed: int, verifiers: list[str], scheduler: str = "fifo") -> list[dict]:
    runs = []
    for v in verifiers:
        c = deep_merge(cfg, {"shared": {"verifier": v, "scheduler": scheduler}})
        holder: dict = {}

        def make(env, holder=holder):
            holder["rec"] = TraceRecorder(env)
            return holder["rec"]

        summary, rec, info = simulate(c, seed, make_recorder=make)
        tl = to_timeline(rec, c, info["dags"])
        workers = [{"id": w.id, "faulty": w.faulty, "speed": round(w.speed, 3)} for w in info["workers"].values()]
        runs.append({
            "scheduler": summary["scheduler"], "verifier": summary["verifier"],
            "summary": {k: summary.get(k) for k in SUMMARY_KEYS},
            "workers": workers, **tl,
        })
    return runs


def scenario_config(scenario: dict, overrides: list[str] | None = None) -> dict:
    cfg = load_config("default", deep_merge(DEMO, scenario["set"]))
    for item in overrides or []:  # --set: tüm senaryolara
        k, _, raw = item.partition("=")
        set_path(cfg, k.strip(), parse_value(raw.strip()))
    return cfg


def export(seed: int = 3, verifiers: list[str] | None = None, overrides: list[str] | None = None,
           out: Path = DEFAULT_OUT) -> dict:
    verifiers = verifiers or ["fixed2", "adaptive"]
    scenarios = []
    for sc in SCENARIOS:
        cfg = scenario_config(sc, overrides)
        scenarios.append({
            "key": sc["key"], "title": sc["title"],
            "meta": {
                "seed": seed, "workers": cfg["workers"]["initial"], "f": cfg["faults"]["f"], "s": cfg["faults"]["s"],
                "collusion": cfg["faults"]["collusion"], "unitPrice": cfg["shared"]["unitPrice"],
                "spotCheckRate": cfg["shared"]["spotCheckRate"], "maxReplicas": cfg["shared"]["maxReplicas"],
                "dags": cfg["workload"]["n_dags"], "tasksPerDag": cfg["workload"]["tasks_per_dag"],
                "tau": cfg["shared"]["reputation"]["tau"],
            },
            "runs": run_pair(cfg, seed, verifiers),
        })
    data = {"scenarios": scenarios}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("// python -m vcsim.replay ile üretildi; elle düzenlemeyin.\nwindow.REPLAY = "
                   + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    return data


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Görsel simülasyon için iki stratejili koşuyu dışa aktarır")
    ap.add_argument("--seed", type=int, default=3)
    ap.add_argument("--verifiers", nargs=2, default=["fixed2", "adaptive"])
    ap.add_argument("--set", action="append", default=[], metavar="ANAHTAR=DEĞER")
    ap.add_argument("--out", default=str(DEFAULT_OUT))
    a = ap.parse_args(argv)
    data = export(a.seed, a.verifiers, a.set, Path(a.out))
    for sc in data["scenarios"]:
        print(sc["title"])
        for r in sc["runs"]:
            s = r["summary"]
            print(f"  {r['verifier']:>9}: makespan {s['makespan_ms'] / 1000:.1f} s, ödenen birim {s['paid_units']}, "
                  f"yanlış kabul {s['tasks_wrong']}, sınama {s['spotchecks']} (yakalanan {s['spotchecks_failed']}), "
                  f"iptal {s['tasks_invalidated']}, olay {len(r['events'])}")
    print(f"→ {a.out}")


if __name__ == "__main__":
    main()
