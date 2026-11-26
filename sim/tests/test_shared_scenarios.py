"""Ortak altın senaryolar (9.2): simülatörün stratejileri shared/test/strategy-scenarios.json'ı geçer.
Aynı dosyayı coordinator/test/strategies.test.ts de koşar."""

from __future__ import annotations

import json

import pytest

from vcsim import SHARED_DIR
from vcsim.reputation import replication_events
from vcsim.strategies import SCHEDULERS, VERIFIERS
from vcsim.strategies.base import ReplicaView, TaskView, WorkerView

S = json.loads((SHARED_DIR / "test" / "strategy-scenarios.json").read_text(encoding="utf-8"))
T = TaskView(key="j/t", module="sha_chain", cost=1000.0)


def replicas(rows):
    out = []
    for i, row in enumerate(rows, start=1):
        state, output = row[0], row[1]
        alone_ok = row[2] if len(row) > 2 else False
        out.append(ReplicaView(id=i, task_id="j/t", worker_id=f"w{i}", state=state, output=output, fatal=False,
                               alone_ok=alone_ok))
    return out


@pytest.mark.parametrize("sc", S["on_result"], ids=lambda s: s["name"])
def test_on_result(sc):
    d = VERIFIERS[sc["verifier"]].on_result(T, replicas(sc["replicas"]))
    got = {"kind": d.kind}
    if d.kind == "accept":
        got["output"] = d.output
    if d.kind == "need_more":
        got["count"] = d.count
    assert got == sc["expect"]


@pytest.mark.parametrize("sc", S["on_assign"], ids=lambda s: s["name"])
def test_on_assign(sc):
    w = WorkerView(id="w", speed_ema=None, alpha=0.0, beta=0.0, trusted=sc["worker"].get("trusted", False),
                   consecutive_valid=sc["worker"].get("consecutive_valid", 0))
    d = VERIFIERS[sc["verifier"]].on_assign(T, replicas(sc["replicas"]), w, sc["u"])
    assert {"extra": d.extra, "alone_ok": d.alone_ok} == sc["expect"]


@pytest.mark.parametrize("sc", S["pick"], ids=lambda s: s["name"])
def test_pick(sc):
    idle = [WorkerView(id=i, speed_ema=sp, alpha=a, beta=b) for i, sp, a, b in sc["idle"]]
    picked = SCHEDULERS[sc["scheduler"]].pick(T, idle)
    assert (picked.id if picked else None) == sc["expect"]


@pytest.mark.parametrize("sc", S["replication_events"], ids=lambda s: s["name"])
def test_replication_events(sc):
    got = replication_events(sc["accepted"], [tuple(r) for r in sc["returned"]])
    assert [list(e) for e in got] == sc["expect"]


def test_every_strategy_has_scenarios():
    assert {s["verifier"] for s in S["on_result"]} == set(VERIFIERS)
    assert {s["scheduler"] for s in S["pick"]} == set(SCHEDULERS)
