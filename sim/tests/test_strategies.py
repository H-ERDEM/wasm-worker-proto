"""Zamanlama ve doğrulama stratejileri, sınama işi ve geriye dönük iptal (Kapsam v2 §5)."""

from __future__ import annotations

import pytest

from vcsim.config import deep_merge, load_config
from vcsim.run import simulate
from vcsim.strategies import SCHEDULERS, VERIFIERS
from vcsim.strategies.base import ReplicaView, TaskView, WorkerView

T = TaskView(key="j/t", module="sha_chain", cost=1000.0)


def rv(i, state, out=None, alone_ok=False, worker=None):
    return ReplicaView(id=i, task_id="j/t", worker_id=worker or f"w{i}", state=state, output=out, fatal=False,
                       alone_ok=alone_ok)


def wv(id="w", speed=None, alpha=0.0, beta=0.0, trusted=False, n=0):
    return WorkerView(id=id, speed_ema=speed, alpha=alpha, beta=beta, trusted=trusted, consecutive_valid=n)


# ---------- Doğrulayıcılar: birim testleri ----------

def test_registry_contains_scope_strategies():
    assert set(SCHEDULERS) == {"fifo", "fastest", "reputation"}
    assert set(VERIFIERS) == {"fixed2", "fixed3", "adaptive", "boinc_adaptive", "accept_first"}
    assert [v for v in VERIFIERS if VERIFIERS[v].uses_spot_checks] == ["adaptive"]


def test_fixed2_rules():
    v = VERIFIERS["fixed2"]
    assert v.initial_replicas(T) == 2
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "ASSIGNED")]).kind == "wait"
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "x")]).output == "x"
    d = v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "y")])
    assert d.kind == "need_more" and d.count == 1
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "y"),
                           rv(3, "RETURNED_OK", "y")]).output == "y"
    # Kaybolan kopya sayılmaz: tek sonuç yetmez.
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "LOST")]).kind == "need_more"


def test_fixed3_waits_for_all_live_copies_then_majority():
    v = VERIFIERS["fixed3"]
    assert v.initial_replicas(T) == 3
    two_agree_one_running = [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "x"), rv(3, "ASSIGNED")]
    assert v.on_result(T, two_agree_one_running).kind == "wait"
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "y"),
                           rv(3, "RETURNED_OK", "x")]).output == "x"
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "y"),
                           rv(3, "RETURNED_OK", "z")]).kind == "need_more"


def test_adaptive_on_assign():
    v = VERIFIERS["adaptive"]
    assert v.initial_replicas(T) == 1
    alone = [rv(1, "ASSIGNED")]
    d = v.on_assign(T, alone, wv(trusted=True), 0.5)
    assert (d.extra, d.alone_ok) == (0, True)
    d = v.on_assign(T, alone, wv(trusted=False), 0.5)
    assert (d.extra, d.alone_ok) == (1, False)
    # İkinci kopya zaten varsa yeni kopya açılmaz.
    d = v.on_assign(T, [rv(1, "ASSIGNED"), rv(2, "ASSIGNED")], wv(trusted=False), 0.5)
    assert (d.extra, d.alone_ok) == (0, False)


def test_adaptive_on_result():
    v = VERIFIERS["adaptive"]
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x", alone_ok=True)]).output == "x"
    # Güvenilmez worker'ın görevi iki eşleşen sonuç bekler.
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "QUEUED")]).kind == "wait"
    # Görev bir kez güvenilmez worker'a atandıysa güvenilir kopya tek başına kabul ettiremez.
    assert v.on_result(T, [rv(1, "ASSIGNED", alone_ok=False), rv(2, "RETURNED_OK", "x", alone_ok=True)]).kind == "wait"
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "x", alone_ok=True)]).output == "x"
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x"), rv(2, "RETURNED_OK", "y")]).kind == "need_more"
    # Güvenilir kopya kaybolup yerine güvenilmez worker geldiyse tek sonuç yetmez.
    assert v.on_result(T, [rv(1, "LOST", alone_ok=True), rv(2, "RETURNED_OK", "x"), rv(3, "QUEUED")]).kind == "wait"


@pytest.mark.parametrize("n, u, replicate", [(0, 0.99, True), (9, 0.99, True), (10, 0.05, True),
                                             (10, 0.10, False), (40, 0.02, True), (40, 0.03, False)])
def test_boinc_adaptive_rule(n, u, replicate):
    """N < 10 her zaman, N ≥ 10 ise 1/N olasılıkla replike (BOINC sched_send.cpp)."""
    d = VERIFIERS["boinc_adaptive"].on_assign(T, [rv(1, "ASSIGNED")], wv(n=n), u)
    assert d.alone_ok is (not replicate)
    assert d.extra == (1 if replicate else 0)


def test_accept_first_unchanged():
    v = VERIFIERS["accept_first"]
    assert v.on_assign(T, [rv(1, "ASSIGNED")], wv(), 0.5).alone_ok
    assert v.on_result(T, [rv(1, "RETURNED_OK", "x")]).output == "x"


# ---------- Zamanlayıcılar ----------

def test_fifo_takes_first_idle():
    idle = [wv("a", 1.0), wv("b", 9.0)]
    assert SCHEDULERS["fifo"].pick(T, idle).id == "a"
    assert SCHEDULERS["fifo"].pick(T, []) is None


def test_fastest_picks_highest_speed_and_explores_unmeasured_on_tie():
    s = SCHEDULERS["fastest"]
    assert s.pick(T, [wv("a", 1.0), wv("b", 3.0), wv("c", 2.0)]).id == "b"
    # Ölçülmemiş worker en yüksek ölçülmüş hızla eşit sayılır; eşitlikte önce o denenir.
    assert s.pick(T, [wv("a", 1.0), wv("b", 3.0), wv("new", None)]).id == "new"
    assert s.pick(T, [wv("x", None), wv("y", None)]).id == "x"
    assert s.pick(T, []) is None


def test_reputation_scheduler_uses_R_times_speed():
    s = SCHEDULERS["reputation"]
    fast_untrusted = wv("fast", 3.0, alpha=0.0, beta=5.0)  # R = 1/7
    slow_trusted = wv("slow", 1.0, alpha=50.0, beta=0.0)  # R = 51/52
    assert s.pick(T, [fast_untrusted, slow_trusted]).id == "slow"
    # İtibarlar eşitse hız belirler.
    assert s.pick(T, [wv("a", 1.0, 10, 0), wv("b", 2.0, 10, 0)]).id == "b"


# ---------- Simülatörle bütünleşme ----------

SMALL = {"workload": {"n_dags": 6, "tasks_per_dag": 30}, "workers": {"initial": 12}}


def cfg(verifier="fixed2", scheduler="fifo", **over):
    return load_config("default", deep_merge(deep_merge(SMALL, {"shared": {"verifier": verifier,
                                                                             "scheduler": scheduler}}), over))


@pytest.mark.parametrize("scheduler", ["fifo", "fastest", "reputation"])
@pytest.mark.parametrize("verifier", ["fixed2", "fixed3", "adaptive", "boinc_adaptive", "accept_first"])
def test_every_combination_completes_without_faults(verifier, scheduler):
    s, _, _ = simulate(cfg(verifier, scheduler), 1)
    assert s["jobs_completed"] == s["jobs"] and s["task_error_rate"] == 0.0 and not s["timed_out"]


@pytest.mark.parametrize("verifier, per_task", [("accept_first", 1), ("fixed2", 2), ("fixed3", 3)])
def test_fixed_strategies_pay_exact_copies_per_task_without_faults(verifier, per_task):
    s, _, _ = simulate(cfg(verifier), 2)
    assert s["paid_units"] == per_task * s["tasks"]
    assert s["replicas_per_task"] == per_task


def test_adaptive_cheaper_than_fixed2_once_workers_are_trusted():
    more = {"workload": {"n_dags": 12, "tasks_per_dag": 50}}
    a, _, _ = simulate(cfg("adaptive", **more), 3)
    f2, _, _ = simulate(cfg("fixed2", **more), 3)
    assert a["task_error_rate"] == 0.0
    assert a["paid_units"] < f2["paid_units"]


def test_spot_check_share_close_to_q():
    s, rec, _ = simulate(cfg("adaptive", workload={"n_dags": 12, "tasks_per_dag": 50}), 4)
    assigned = rec.frames()["replicas"]["assigned_at"].notna().sum()
    assert s["spotchecks"] / assigned == pytest.approx(0.10, abs=0.03)


@pytest.mark.parametrize("verifier", ["fixed2", "fixed3", "boinc_adaptive", "accept_first"])
def test_no_spot_checks_outside_adaptive(verifier):
    s, _, _ = simulate(cfg(verifier, faults={"f": 0.2}), 1)
    assert s["spotchecks"] == 0 and s["tasks_invalidated"] == 0


def test_spot_check_rate_zero_disables_spot_checks():
    s, _, _ = simulate(cfg("adaptive", shared={"spotCheckRate": 0.0}, faults={"f": 0.3, "s": 0.05}), 1)
    assert s["spotchecks"] == 0 and s["tasks_invalidated"] == 0


@pytest.mark.parametrize("verifier", ["fixed2", "fixed3", "adaptive", "boinc_adaptive"])
def test_random_faults_never_accepted_when_s_is_1(verifier):
    """Rastgele modelde iki yanlış sonuç eşleşmez; s = 1'de hatalı worker hiç güvenilir olamaz."""
    s, _, _ = simulate(cfg(verifier, faults={"f": 0.3, "s": 1.0}), 1)
    assert s["task_error_rate"] == 0.0


def test_accept_first_error_reflects_faults_while_replication_does_not():
    af, _, _ = simulate(cfg("accept_first", faults={"f": 0.3}), 2)
    f2, _, _ = simulate(cfg("fixed2", faults={"f": 0.3}), 2)
    assert af["task_error_rate"] > 0.1 and f2["task_error_rate"] == 0.0


def test_collusion_defeats_fixed2_sometimes():
    s, _, _ = simulate(cfg("fixed2", faults={"f": 0.3, "collusion": True}), 1)
    assert s["task_error_rate"] > 0.0  # RQ2'nin ölçtüğü zayıflık


def test_payment_happens_only_at_job_end():
    s, rec, _ = simulate(cfg("adaptive", faults={"f": 0.3, "s": 0.05}), 5)
    f = rec.frames()
    paid = f["replicas"][f["replicas"]["paid"] == 1]
    assert len(paid) == s["paid_units"] > 0
    assert set(f["jobs"]["status"]) <= {"COMPLETED", "FAILED"}
    # Ödenen her gerçek kopya kabul edilen sonuçla eşleşir; ödenen her sınama işi geçilmiştir.
    tasks = f["tasks"].set_index("id")
    real = paid[paid["is_spotcheck"] == 0]
    assert (real["output"].values == tasks.loc[real["task_id"], "accepted_output"].values).all()
    spot = paid[paid["is_spotcheck"] == 1]
    assert (spot["output"] == spot["expected_output"]).all()


def test_retroactive_cancellation_reruns_single_copy_results_of_caught_worker():
    """Seyrek hata yapan worker güven kazanıp tek kopyaya geçer; sınamada yakalanınca ödenmemiş
    işlerdeki tek kopyalı sonuçları yeniden hesaplanır ve işler yine tamamlanır."""
    total_invalidated = 0
    for seed in (1, 2, 3):
        s, rec, info = simulate(cfg("adaptive", workload={"n_dags": 12, "tasks_per_dag": 50},
                                    faults={"f": 0.3, "s": 0.02}), seed)
        total_invalidated += s["tasks_invalidated"]
        assert s["jobs_completed"] + s["jobs_failed"] == s["jobs"] and not s["timed_out"]
        if s["tasks_invalidated"]:
            ev = rec.frames()["rep_events"]
            assert (ev["kind"] == "spot_fail").any()
    assert total_invalidated > 0


def test_spot_checks_reduce_errors_with_rarely_lying_workers():
    """RQ2 yönü: q > 0 hatalı sonuç sayısını q = 0'a göre azaltır (aynı tohumlar, toplam)."""
    def wrong(q):
        n = 0
        for seed in (1, 2, 3, 4):
            s, _, _ = simulate(cfg("adaptive", shared={"spotCheckRate": q},
                                   workload={"n_dags": 12, "tasks_per_dag": 50}, faults={"f": 0.3, "s": 0.05}), seed)
            n += round(s["task_error_rate"] * s["tasks_with_truth"])
        return n
    assert wrong(0.2) < wrong(0.0)


def test_determinism_with_adaptive_and_spot_checks():
    c = cfg("adaptive", "reputation", faults={"f": 0.3, "s": 0.05})
    a, ra, _ = simulate(c, 9)
    b, rb, _ = simulate(c, 9)
    assert a == b
    for name in ("replicas", "rep_events", "tasks"):
        assert ra.frames()[name].equals(rb.frames()[name])


def test_crn_fault_decisions_shared_across_verifiers():
    """Aynı worker aynı görevde her stratejide aynı kararı verir (ortak rastgele sayılar)."""
    outs = []
    for v in ("fixed2", "adaptive"):
        _, rec, _ = simulate(cfg(v, faults={"f": 0.3, "s": 0.5}), 6)
        r = rec.frames()["replicas"]
        r = r[(r["state"] == "RETURNED_OK") & (r["is_spotcheck"] == 0)]
        outs.append({(w, t): o.split(":")[1] for w, t, o in zip(r["worker_id"], r["task_id"], r["output"])})
    common = outs[0].keys() & outs[1].keys()
    assert len(common) > 50
    assert all(outs[0][k] == outs[1][k] for k in common)


@pytest.mark.parametrize("verifier", ["fixed2", "adaptive"])
def test_max_replicas_10_keeps_job_failures_rare_at_f30(verifier):
    """maxReplicas = 10 ile f = %30, s = 1'de görev başına başarısızlık ≈ 1,4·10⁻⁴; 5 ile ≈ 3·10⁻²."""
    c = load_config("default", {"shared": {"verifier": verifier}, "faults": {"f": 0.3, "s": 1.0}})
    assert c["shared"]["maxReplicas"] == 10
    failed = sum(simulate(c, seed)[0]["jobs_failed"] for seed in (1, 2, 3))
    assert failed <= 2  # 60 işte; 5 ile yaklaşık 40 iş başarısız oluyordu
