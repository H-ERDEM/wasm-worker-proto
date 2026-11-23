"""Beta itibar modeli testleri (Kapsam Dokümanı v2 §5; Hafta 6–7 raporu §2.2.7)."""

from __future__ import annotations

import json
import pytest

from vcsim import SHARED_DIR
from vcsim.config import deep_merge, load_config
from vcsim.reputation import RepParams, is_trusted, replication_events, score, update
from vcsim.run import simulate

VECTORS = json.loads((SHARED_DIR / "test" / "reputation-vectors.json").read_text(encoding="utf-8"))
P = RepParams.from_shared(load_config("default")["shared"])


# ---------- Parametreler ----------

def test_params_come_from_shared_config_with_scope_values():
    assert P == RepParams(tau=0.95, alpha_min=10, lam=0.99, w=5)
    assert VECTORS["params"] == {"tau": P.tau, "alphaMin": P.alpha_min, "lambda": P.lam, "w": P.w}


@pytest.mark.parametrize("bad", [dict(lam=0.0), dict(lam=1.5), dict(w=0.0), dict(tau=1.0), dict(alpha_min=-1)])
def test_invalid_params_rejected(bad):
    with pytest.raises(ValueError):
        RepParams(**({"tau": 0.95, "alpha_min": 10, "lam": 0.99, "w": 5} | bad))


def test_unknown_event_kind_rejected():
    with pytest.raises(ValueError):
        update(0.0, 0.0, "timeout", P)


# ---------- Ortak vektörler (TypeScript koordinatörü de aynı dosyayı geçecek) ----------

@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: c["name"])
def test_shared_vectors(case):
    a = b = 0.0
    for kind in case["events"]:
        a, b = update(a, b, kind, P)
    e = case["expect"]
    assert a == pytest.approx(e["alpha"], abs=1e-9)
    assert b == pytest.approx(e["beta"], abs=1e-9)
    assert score(a, b) == pytest.approx(e["R"], abs=1e-9)
    assert is_trusted(a, b, P) is e["trusted"]


# ---------- Modelin özellikleri ----------

def test_initial_score_is_half():
    assert score(0.0, 0.0) == 0.5


def test_decay_applied_before_increment():
    """Sıra yanlışsa (önce +1, sonra λ) iki match sonrası α = 1,9701 olurdu; doğrusu 1,99."""
    a, b = update(*update(0.0, 0.0, "match", P), "match", P)
    assert a == pytest.approx(1.99) and b == 0.0


def test_spot_events_weigh_same_as_replication_events():
    assert update(3.0, 1.0, "spot_pass", P) == update(3.0, 1.0, "match", P)
    assert update(3.0, 1.0, "spot_fail", P) == update(3.0, 1.0, "mismatch", P)


def test_fault_free_worker_needs_20_verified_results_for_single_copy():
    """τ = 0,95 için hatasız worker α ≥ 18 olunca güvenilir olur; λ ile bu 20 olay eder."""
    a = b = 0.0
    n = 0
    while not is_trusted(a, b, P):
        a, b = update(a, b, "match", P)
        n += 1
    assert n == 20 and a >= 18.0


def test_alpha_min_not_binding_at_tau_095_but_binding_at_lower_tau():
    # τ = 0,95: R ≥ τ zaten α ≥ 18 gerektirir, α_min = 10 hiç bağlayıcı olmaz.
    a = b = 0.0
    for _ in range(100):
        a, b = update(a, b, "match", P)
        assert is_trusted(a, b, P) == (score(a, b) >= P.tau)
    # τ = 0,8: R ≥ 0,8 için α ≥ 3 yeterli; α_min = 10 alt sınır işlevi görür.
    low = RepParams(tau=0.8, alpha_min=10, lam=0.99, w=5)
    a, b = 0.0, 0.0
    for _ in range(5):
        a, b = update(a, b, "match", low)
    assert score(a, b) >= low.tau and not is_trusted(a, b, low)


def test_single_failure_revokes_trust():
    a = b = 0.0
    for _ in range(200):
        a, b = update(a, b, "match", P)
    assert is_trusted(a, b, P)
    a, b = update(a, b, "spot_fail", P)
    assert not is_trusted(a, b, P)


@pytest.mark.parametrize("p_err, trusted", [(0.01, False), (0.008, True)])
def test_equilibrium_matches_scope_claim(p_err, trusted):
    """Beklenen değer dengesi: α → (1 − p)/(1 − λ) = 100(1 − p), β → w·p/(1 − λ) = 500p.
    p = %1'de R ≈ 0,943 < τ, p = %0,8'de R ≈ 0,952 ≥ τ (Kapsam v2 §5: '≈ %1'in altında')."""
    a = b = 0.0
    for _ in range(5000):
        a = P.lam * a + (1 - p_err)
        b = P.lam * b + P.w * p_err
    assert a == pytest.approx(100 * (1 - p_err), rel=1e-9)
    assert b == pytest.approx(500 * p_err, rel=1e-9)
    assert (score(a, b) >= P.tau) is trusted


# ---------- Replikasyon olayları ----------

def test_single_copy_acceptance_is_not_verified():
    assert replication_events("x", [("w1", "x")]) == []


def test_two_agreeing_copies_both_match():
    assert replication_events("x", [("w1", "x"), ("w2", "x")]) == [("w1", "match"), ("w2", "match")]


def test_dissenting_copy_gets_mismatch():
    assert replication_events("x", [("w1", "x"), ("w2", "y"), ("w3", "x")]) == \
        [("w1", "match"), ("w2", "mismatch"), ("w3", "match")]


def test_colluders_agreeing_on_wrong_value_both_match():
    """Kapsam v2 §5: iki colluder aynı göreve denk gelirse yanlış sonuç kabul edilir, ikisinin de itibarı artar."""
    assert replication_events("bad", [("c1", "bad"), ("c2", "bad"), ("h", "good")]) == \
        [("c1", "match"), ("c2", "match"), ("h", "mismatch")]


# ---------- Simüle koordinatörle bütünleşme ----------

def _cfg(**over):
    small = {"workload": {"n_dags": 4, "tasks_per_dag": 30}, "workers": {"initial": 12}}
    return load_config("default", deep_merge(small, over))


def test_accept_first_produces_no_reputation_events():
    _, rec, info = simulate(_cfg(faults={"f": 0.3}), 1)
    assert rec.rep_events == []
    assert all(w.alpha == 0.0 and w.beta == 0.0 for w in info["workers"].values())


def test_replication_updates_reputation_and_log_replays():
    _, rec, info = simulate(_cfg(shared={"verifier": "fixed2"}, faults={"f": 0.3, "s": 1.0}), 2)
    workers = info["workers"]
    ev = rec.frames()["rep_events"]
    assert len(ev) > 0

    # Rastgele modelde iki yanlış sonuç asla eşleşmez: kabul edilen her sonuç doğru,
    # mismatch alanlar yalnızca hatalı worker'lar, dürüst worker hiç mismatch almaz.
    mismatched = set(ev.loc[ev["kind"] == "mismatch", "worker_id"])
    assert mismatched and all(workers[w].faulty for w in mismatched)
    assert all(w.beta == 0.0 for w in workers.values() if not w.faulty)

    # Olay kaydı yeniden oynatılınca worker'ların son α, β değerleri bulunur.
    for wid, g in ev.sort_values("id").groupby("worker_id"):
        a = b = 0.0
        for kind, a_after, b_after in zip(g["kind"], g["alpha_after"], g["beta_after"]):
            a, b = update(a, b, kind, P)
            assert (a, b) == pytest.approx((a_after, b_after))
        assert (workers[wid].alpha, workers[wid].beta) == pytest.approx((a, b))

    # Her olay kabul anında dönmüş ve ödenen/ödenmeyen bir kopyaya karşılık gelir.
    reps = rec.frames()["replicas"].set_index("id")
    assert set(ev["replica_id"]) <= set(reps.index[reps["state"] == "RETURNED_OK"])
    assert (reps.loc[ev.loc[ev["kind"] == "match", "replica_id"], "paid"] == 1).all()
    assert (reps.loc[ev.loc[ev["kind"] == "mismatch", "replica_id"], "paid"] == 0).all()


def test_colluders_gain_reputation_when_paired():
    _, rec, info = simulate(_cfg(shared={"verifier": "fixed2"},
                                 faults={"f": 0.3, "s": 1.0, "collusion": True}), 3)
    ev = rec.frames()["rep_events"]
    faulty = {w.id for w in info["workers"].values() if w.faulty}
    colluder_matches = ev[(ev["kind"] == "match") & ev["worker_id"].isin(faulty)]
    assert len(colluder_matches) > 0  # colluding modelinin beklenen zayıflığı (RQ2)
