"""Görsel simülasyon dışa aktarımı (9.6): olay akışı, aynı koşunun summary.json'uyla tutarlı olmalı."""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from vcsim import REPO_ROOT

from vcsim import replay
from vcsim.config import deep_merge, load_config
from vcsim.run import simulate

PLAYER = REPO_ROOT / "docs" / "demo" / "replay-player.js"
SMALL = {"workload": {"n_dags": 3, "tasks_per_dag": 15}, "workers": {"initial": 8}}


def small_cfg(collusion: bool) -> dict:
    return load_config("default", deep_merge(replay.DEMO, deep_merge(SMALL, {"faults": {"collusion": collusion}})))


def final_counters(run: dict) -> dict:
    """Sayfanın oynatıcısıyla (docs/demo/replay-player.js) aynı kurallar: olaylar sırayla işlenir."""
    paid, wrong, spots, spot_fail = set(), set(), 0, 0
    accepted_wrong: dict[str, bool] = {}
    end = 0.0
    for e in run["events"]:
        if e["e"] == "paid":
            paid.add(e["r"])
        elif e["e"] == "assign" and e["spot"]:
            spots += 1
        elif e["e"] == "return" and e["spot"] and e["ok"] and e["wrong"]:
            spot_fail += 1
        elif e["e"] == "task" and e["state"] == "ACCEPTED":
            accepted_wrong[e["task"]] = e["wrong"]
        elif e["e"] == "invalidate":
            accepted_wrong.pop(e["task"], None)
        elif e["e"] == "job":
            end = max(end, e["t"])
    wrong = {k for k, v in accepted_wrong.items() if v}
    return {"paid_units": len(paid), "tasks_wrong": len(wrong), "spotchecks": spots,
            "spotchecks_failed": spot_fail, "end_ms": end}


@pytest.mark.parametrize("collusion", [True, False])
@pytest.mark.parametrize("verifier", ["fixed2", "adaptive"])
def test_timeline_matches_summary(collusion, verifier):
    cfg = small_cfg(collusion)
    run = replay.run_pair(cfg, 5, [verifier])[0]
    c = final_counters(run)
    s = run["summary"]
    assert c["paid_units"] == s["paid_units"]
    assert c["tasks_wrong"] == s["tasks_wrong"]
    assert c["spotchecks"] == s["spotchecks"]
    assert c["spotchecks_failed"] == s["spotchecks_failed"]
    assert c["end_ms"] == pytest.approx(s["makespan_ms"], abs=0.1)
    assert len(run["workers"]) == cfg["workers"]["initial"]
    assert sum(len(j["tasks"]) for j in run["jobs"]) == s["tasks"]


def test_trace_does_not_change_simulation():
    """Zaman çizelgesi kaydı simülasyonun sonucunu değiştirmez."""
    cfg = deep_merge(small_cfg(True), {"shared": {"verifier": "adaptive"}})
    plain, _, _ = simulate(cfg, 9)
    traced, _, _ = simulate(cfg, 9, make_recorder=replay.TraceRecorder)
    assert plain == traced


def test_same_seed_same_workers_in_both_runs():
    """Ortak rastgele sayılar: iki strateji aynı worker'ları ve aynı hatalı kümeyi görür."""
    a, b = replay.run_pair(small_cfg(True), 5, ["fixed2", "adaptive"])
    assert a["workers"] == b["workers"]
    assert a["jobs"] == b["jobs"]


def test_export_writes_js(tmp_path):
    out = tmp_path / "data.js"
    replay.export(seed=2, overrides=["workload.n_dags=2", "workload.tasks_per_dag=8", "workers.initial=6"], out=out)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("//") and "window.REPLAY = " in text
    data = json.loads(text.split("window.REPLAY = ", 1)[1].rstrip().rstrip(";"))
    assert [s["key"] for s in data["scenarios"]] == ["colluding", "random"]
    for sc in data["scenarios"]:
        assert [r["verifier"] for r in sc["runs"]] == ["fixed2", "adaptive"]
        assert sc["meta"]["workers"] == 6


@pytest.mark.skipif(shutil.which("node") is None, reason="node yok")
@pytest.mark.parametrize("collusion", [True, False])
def test_page_player_matches_summary(tmp_path, collusion):
    """Sayfanın kendi oynatıcısı (docs/demo/replay-player.js) da aynı son sayaçları verir."""
    runs = replay.run_pair(small_cfg(collusion), 5, ["fixed2", "adaptive"])
    data = tmp_path / "runs.json"
    data.write_text(json.dumps({"meta": {"unitPrice": 0.001}, "runs": runs}), encoding="utf-8")
    script = (
        "const fs = require('fs'); new Function(fs.readFileSync(process.argv[1], 'utf8'))();"
        "const P = globalThis.ReplayPlayer; const d = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));"
        "console.log(JSON.stringify(d.runs.map(r => P.counters(P.advance(P.create(r, d.meta), Infinity)))));"
    )
    out = subprocess.run(["node", "-e", script, str(PLAYER), str(data)], capture_output=True, text=True, check=True)
    for run, c in zip(runs, json.loads(out.stdout)):
        s = run["summary"]
        assert c["paidUnits"] == s["paid_units"]
        assert c["wrong"] == s["tasks_wrong"]
        assert c["spots"] == s["spotchecks"]
        assert c["spotFail"] == s["spotchecks_failed"]
        assert c["invalidated"] == s["tasks_invalidated"]
        assert c["jobsDone"] == s["jobs_completed"]
        assert c["end"] == pytest.approx(s["makespan_ms"], abs=0.1)
