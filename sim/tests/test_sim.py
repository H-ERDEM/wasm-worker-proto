"""Simülatör testleri (Hafta 6–7 raporu §2.2.7)."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pandas as pd
import pytest

from vcsim import REPO_ROOT, SHARED_DIR
from vcsim.analyze import load_coordinator, load_sim
from vcsim.config import load_config
from vcsim.metrics import compute_metrics
from vcsim.reference import expected_output
from vcsim.run import main as run_main, simulate
from vcsim.workload import DagError, critical_path_ms, load_dag, validate_dag

SMALL = {"workload": {"n_dags": 6, "tasks_per_dag": 30}, "workers": {"initial": 12}}


def cfg(**over) -> dict:
    from vcsim.config import deep_merge

    return load_config("default", deep_merge(SMALL, over))


def test_determinism_same_seed_identical_outputs(tmp_path):
    for d in ("a", "b"):
        run_main(["--seed", "7", "--out", str(tmp_path / d), "--set", "workload.n_dags=4", "--set", "faults.f=0.2"])
    for f in ("summary.json", "jobs.parquet", "tasks.parquet", "replicas.parquet"):
        assert (tmp_path / "a" / f).read_bytes() == (tmp_path / "b" / f).read_bytes(), f


def test_different_seed_changes_result():
    a, _, _ = simulate(cfg(), 1)
    b, _, _ = simulate(cfg(), 2)
    assert a["makespan_ms"] != b["makespan_ms"]


def test_crn_workload_and_population_independent_of_fault_params():
    _, _, i1 = simulate(cfg(faults={"f": 0.0}), 5)
    _, _, i2 = simulate(cfg(faults={"f": 0.3, "s": 0.5}), 5)
    assert json.dumps(i1["dags"]) == json.dumps(i2["dags"])
    assert [w.speed for w in i1["workers"].values()] == [w.speed for w in i2["workers"].values()]


def test_makespan_lower_bound_critical_path_on_fastest_worker():
    c = cfg(workers={"speed_noise_sigma": 0.0})
    summary, rec, info = simulate(c, 3)
    fastest = max(w.speed for w in info["workers"].values())
    rate = c["workers"]["base_rate"]
    net = c["workers"]["network_ms"]

    def ms(task):
        from vcsim.workload import task_cost
        return net + task_cost(task) / (rate[task["module"]] * fastest)

    lb = max(critical_path_ms(d, ms) for d in info["dags"])
    assert summary["makespan_ms"] >= lb - 1e-6


def test_no_faults_means_zero_error():
    s, _, _ = simulate(cfg(faults={"f": 0.0}), 1)
    assert s["task_error_rate"] == 0.0 and s["job_error_rate"] == 0.0
    assert s["jobs_completed"] == s["jobs"]


def test_accept_first_error_rate_close_to_f_times_s():
    c = cfg(workload={"n_dags": 20, "tasks_per_dag": 50}, workers={"initial": 60}, faults={"f": 0.3, "s": 0.5})
    s, _, info = simulate(c, 11)
    realized_f = s["workers_faulty"] / s["workers_total"]
    # accept_first tek kopya kabul eder: hata oranı ≈ (gerçekleşen f) · s
    assert abs(s["task_error_rate"] - realized_f * 0.5) < 0.06, (s["task_error_rate"], realized_f)


def test_collusion_wrong_values_are_shared():
    s, rec, _ = simulate(cfg(faults={"f": 1.0, "s": 1.0, "collusion": True}), 2)
    reps = rec.frames()["replicas"]
    ok = reps[reps["state"] == "RETURNED_OK"]
    assert (ok["output"].str.endswith(":collude")).all()
    assert s["task_error_rate"] == 1.0


def test_churn_loses_replicas_but_jobs_complete():
    c = cfg(workers={"session_mean_s": 20, "arrival_rate_per_s": 1.0})
    s, _, _ = simulate(c, 4)
    assert s["replicas_lost"] > 0
    assert s["jobs_completed"] == s["jobs"]
    assert s["task_error_rate"] == 0.0


@pytest.mark.parametrize("close", [False, True])
def test_departure_detection_delay(close):
    """Sessiz ayrılma heartbeat gecikmesiyle (2 × heartbeatMs + periyot), sekme kapanması hemen fark edilir."""
    import simpy
    from vcsim.coordinator import SimCoordinator
    from vcsim.events import Recorder
    from vcsim.rng import Streams

    c = cfg()
    env, rec = simpy.Environment(), Recorder()
    coord = SimCoordinator(env, c, Streams(1), rec)
    w = coord.add_worker()
    coord.submit_job({"version": 0, "jobId": "j", "tasks": [{"id": "t", "module": "sha_chain", "input": {"seed": "x", "iterations": 50_000_000}}]})
    env.process(coord._depart(w, 10.0, close))

    def late_worker():
        yield env.timeout(10_000)
        coord.add_worker()
    env.process(late_worker())
    env.run(until=simpy.AnyOf(env, [coord.all_done, env.timeout(10**8)]))

    reps = rec.frames()["replicas"].sort_values("id")
    assert list(reps["state"]) == ["LOST", "RETURNED_OK"]
    detected_at = reps.iloc[1]["created_at"]
    hb = c["shared"]["heartbeatMs"] * c["shared"]["missedHeartbeats"]
    if close:
        assert detected_at == pytest.approx(10.0)
    else:
        assert 10.0 + hb <= detected_at <= 10.0 + hb + coord.detect_jitter


def test_dependencies_respected():
    """Alt görevin ilk kopyası, tüm üst görevler kabul edildikten sonra atanır."""
    _, rec, info = simulate(cfg(), 6)
    f = rec.frames()
    accepted_at = f["tasks"].set_index("id")["accepted_at"]
    first_assign = f["replicas"].groupby("task_id")["assigned_at"].min()
    for dag in info["dags"]:
        for t in dag["tasks"]:
            for d in t.get("deps", []):
                assert first_assign[f"{dag['jobId']}/{t['id']}"] >= accepted_at[f"{dag['jobId']}/{d}"]


def test_debug_panic_fails_after_max_replicas():
    c = cfg(shared={"maxReplicas": 3})
    c["workload"]["dag_files"] = []
    dag = {"version": 0, "jobId": "p", "tasks": [{"id": "p", "module": "debug_panic", "input": {}},
                                                   {"id": "c", "module": "sha_chain", "input": {"seed": "x", "iterations": 1}, "deps": ["p"]}]}
    p = REPO_ROOT / "experiments" / "data" / "_panic_test.json"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(dag))
    try:
        c["workload"]["dag_files"] = [str(p)]
        s, rec, _ = simulate(c, 1)
    finally:
        p.unlink()
    assert s["jobs_failed"] == 1
    assert s["replicas_error"] == 3


# ---------- Ortak sözleşme ----------

def test_shared_examples_load_and_generated_dags_valid():
    for f in (SHARED_DIR / "examples").glob("*.json"):
        load_dag(f)
    _, _, info = simulate(cfg(), 1)
    for d in info["dags"]:
        validate_dag(d)
        assert len(d["tasks"]) == 30


def test_invalid_dags_rejected():
    with pytest.raises(DagError):
        validate_dag({"version": 0, "tasks": [{"id": "a", "module": "sha_chain", "input": {}, "deps": ["b"]},
                                              {"id": "b", "module": "sha_chain", "input": {}, "deps": ["a"]}]})
    with pytest.raises(DagError):
        validate_dag({"version": 0, "tasks": [{"id": "a", "module": "rm", "input": {}}]})


def test_replica_columns_match_coordinator_schema():
    from vcsim.events import REPLICA_COLUMNS
    ddl = (REPO_ROOT / "coordinator" / "src" / "db" / "db.ts").read_text(encoding="utf-8")
    block = ddl.split("CREATE TABLE IF NOT EXISTS replicas (")[1].split(");")[0]
    cols = [part.strip().split()[0] for part in block.replace("\n", " ").split(",") if part.strip()]
    assert cols == REPLICA_COLUMNS


def test_reference_matches_readme_vectors():
    assert json.loads(expected_output("sha_chain", '{"seed":"hello","iterations":1000}'))["hash"] == \
        "f6eec10c841b542f37ffb4ca00f82c5b6b4b11b79636d20201078b667ac37159"
    assert json.loads(expected_output("matmul", '{"seed":42,"n":64}'))["hash"] == \
        "21bfb70784701c76d11da1401dec6eb95c570e074e7a831c5ac69a56514433cb"
    assert json.loads(expected_output("matmul", '{"seed":4294967295,"n":100}'))["n"] == 100


def test_full_default_run_within_time_budget():
    import time
    t0 = time.perf_counter()
    s, _, _ = simulate(load_config("default"), 1)
    assert time.perf_counter() - t0 < 5.0
    assert s["tasks"] == 1000 and s["jobs_completed"] == 20


# ---------- Ortak analiz: simülatör ve koordinatör aynı metrik kodu ----------

def test_analyze_reads_sim_output(tmp_path):
    run_main(["--seed", "2", "--out", str(tmp_path), "--set", "workload.n_dags=3"])
    m = compute_metrics(load_sim(tmp_path), 0.001)
    assert m == {k: v for k, v in json.loads((tmp_path / "summary.json").read_text()).items() if k in m}


def test_analyze_reads_coordinator_db(tmp_path):
    """Gerçek koordinatörü sahte worker'larla çalıştırıp SQLite kaydını analiz eder."""
    db = tmp_path / "c.db"
    script = tmp_path / "run.ts"
    script.write_text(f"""
import {{ createServer }} from "{REPO_ROOT}/coordinator/src/server.ts";
import {{ startFakeWorker }} from "{REPO_ROOT}/coordinator/test/fake-worker.ts";
import {{ readFileSync }} from "node:fs";
const s = await createServer({{ dbPath: "{db}" }});
const ws = [startFakeWorker(s.wsUrl), startFakeWorker(s.wsUrl)];
await Promise.all(ws.map((w) => w.id));
const {{ jobId }} = s.coord.submitJob(JSON.parse(readFileSync("{SHARED_DIR}/examples/three-task-dag.json", "utf8")));
while (s.coord.getJob(jobId).status === "RUNNING") await new Promise((r) => setTimeout(r, 20));
ws.forEach((w) => w.close());
await s.close();
""")
    subprocess.run(["node", "--disable-warning=ExperimentalWarning", str(script)], check=True, cwd=REPO_ROOT, timeout=60)
    m = compute_metrics(load_coordinator(db), 0.001)
    assert m["jobs_completed"] == 1 and m["tasks"] == 3
    assert m["tasks_with_truth"] == 3
    assert m["task_error_rate"] == 0.0
    assert m["cost_per_job"] == pytest.approx(0.003)
