"""İş yükü: ortak DAG v0 formatında üretme, yükleme ve doğrulama.

Üretilen DAG'ler diske yazılıp koordinatöre de gönderilebilir (aynı iş yükü simülasyonda ve
gerçek tarayıcılarda: RQ3).
"""

from __future__ import annotations

import json
from collections import deque
from pathlib import Path

import numpy as np

from . import SHARED_DIR


class DagError(ValueError):
    pass


def task_cost(task: dict) -> float:
    """coordinator/src/queue/dag.ts taskCost ile aynı: sha_chain → iterations, matmul → n³."""
    if isinstance(task.get("cost"), (int, float)):
        return float(task["cost"])
    inp = task.get("input", {})
    if task["module"] == "sha_chain" and isinstance(inp.get("iterations"), int):
        return float(inp["iterations"])
    if task["module"] == "matmul" and isinstance(inp.get("n"), int):
        return float(inp["n"] ** 3)
    return 1.0


def _refs(value, out: list[str]) -> list[str]:
    if isinstance(value, list):
        for v in value:
            _refs(v, out)
    elif isinstance(value, dict):
        if set(value) == {"$ref"} and isinstance(value["$ref"], str):
            out.append(value["$ref"])
        else:
            for v in value.values():
                _refs(v, out)
    return out


def validate_dag(dag: dict) -> list[str]:
    """Şema (jsonschema varsa) + anlamsal kontroller; topolojik sırayı döndürür."""
    try:
        import jsonschema

        schema = json.loads((SHARED_DIR / "schemas" / "dag.v0.schema.json").read_text(encoding="utf-8"))
        jsonschema.validate(dag, schema)
    except ImportError:  # pragma: no cover - jsonschema isteğe bağlı
        if dag.get("version") != 0 or not dag.get("tasks"):
            raise DagError("şema hatası")
    except Exception as e:  # jsonschema.ValidationError
        raise DagError(f"şema hatası: {getattr(e, 'message', e)}") from e

    ids = [t["id"] for t in dag["tasks"]]
    if len(set(ids)) != len(ids):
        raise DagError("yinelenen görev kimliği")
    idset = set(ids)
    for t in dag["tasks"]:
        deps = t.get("deps", [])
        for d in deps:
            if d not in idset or d == t["id"]:
                raise DagError(f"{t['id']}: geçersiz bağımlılık {d}")
        for ref in _refs(t["input"], []):
            if ref.split(".")[0] not in deps:
                raise DagError(f"{t['id']}: $ref {ref} deps içinde değil")
    indeg = {t["id"]: len(t.get("deps", [])) for t in dag["tasks"]}
    children: dict[str, list[str]] = {i: [] for i in ids}
    for t in dag["tasks"]:
        for d in t.get("deps", []):
            children[d].append(t["id"])
    q = deque(i for i in ids if indeg[i] == 0)
    order = []
    while q:
        i = q.popleft()
        order.append(i)
        for c in children[i]:
            indeg[c] -= 1
            if indeg[c] == 0:
                q.append(c)
    if len(order) != len(ids):
        raise DagError("bağımlılıklarda döngü var")
    return order


def load_dag(path: str | Path) -> dict:
    dag = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_dag(dag)
    return dag


# ---------- Üretici ----------


def _make_task(tid: str, deps: list[str], wl: dict, rng: np.random.Generator) -> dict:
    mods = list(wl["modules"])
    probs = np.array([wl["modules"][m] for m in mods], dtype=float)
    module = mods[int(rng.choice(len(mods), p=probs / probs.sum()))]
    if module == "sha_chain":
        lo, hi = wl["sha_iterations"]
        it = int(rng.integers(lo, hi + 1))
        # İlk bağımlılığın çıktısını tohum olarak kullan: gerçek veri bağımlılığı.
        seed: object = {"$ref": f"{deps[0]}.output.hash"} if deps else f"s-{tid}"
        inp = {"seed": seed, "iterations": it}
    else:
        lo, hi = wl["matmul_n"]
        inp = {"seed": int(rng.integers(0, 2**32)), "n": int(rng.integers(lo, hi + 1))}
    task = {"id": tid, "module": module, "input": inp, "deps": deps}
    return task


def generate_dag(shape: str, n_tasks: int, wl: dict, rng: np.random.Generator, job_id: str) -> dict:
    """chain | fork_join | layered biçiminde yaklaşık n_tasks görevli DAG."""
    tasks: list[dict] = []
    if shape == "chain":
        for i in range(n_tasks):
            tasks.append(_make_task(f"t{i}", [f"t{i-1}"] if i else [], wl, rng))
    elif shape == "fork_join":
        tasks.append(_make_task("t0", [], wl, rng))
        mids = [f"t{i}" for i in range(1, n_tasks - 1)]
        for m in mids:
            tasks.append(_make_task(m, ["t0"], wl, rng))
        tasks.append(_make_task(f"t{n_tasks-1}", mids, wl, rng))
    elif shape == "layered":
        depth = max(2, int(round(np.sqrt(n_tasks))))
        sizes = np.full(depth, n_tasks // depth)
        sizes[: n_tasks % depth] += 1
        prev: list[str] = []
        k = 0
        for size in sizes:
            layer = []
            for _ in range(int(size)):
                tid = f"t{k}"
                k += 1
                deps: list[str] = []
                if prev:
                    n_par = int(rng.integers(1, min(3, len(prev)) + 1))
                    deps = sorted(rng.choice(prev, size=n_par, replace=False).tolist(), key=lambda s: int(s[1:]))
                tasks.append(_make_task(tid, deps, wl, rng))
                layer.append(tid)
            prev = layer
    else:
        raise ValueError(f"bilinmeyen DAG biçimi: {shape}")
    dag = {"version": 0, "jobId": job_id, "tasks": tasks}
    validate_dag(dag)
    return dag


def build_workload(wl: dict, rng: np.random.Generator) -> list[dict]:
    """Dosyadan DAG'ler (dag_files) varsa onları, yoksa üretilmiş DAG'leri döndürür."""
    if wl.get("dag_files"):
        return [load_dag(p) for p in wl["dag_files"]]
    shapes = wl["shapes"]
    return [
        generate_dag(shapes[i % len(shapes)], wl["tasks_per_dag"], wl, rng, f"dag{i:03d}")
        for i in range(wl["n_dags"])
    ]


def critical_path_ms(dag: dict, ms_of) -> float:
    """En uzun yol süresi; ms_of(task) her görevin süresini verir."""
    order = validate_dag(dag)
    by_id = {t["id"]: t for t in dag["tasks"]}
    finish: dict[str, float] = {}
    for i in order:
        t = by_id[i]
        finish[i] = max((finish[d] for d in t.get("deps", [])), default=0.0) + ms_of(t)
    return max(finish.values())
