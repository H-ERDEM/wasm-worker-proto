"""Tarama ve istatistik/grafik kodu testleri."""

from __future__ import annotations

import math

import pytest

from vcsim.figures import _spread_labels, aggregate, bootstrap_ci, plot_metric, wilson, write_table
from vcsim.sweep import parse_fault, parse_seeds, run_sweep


def test_parse_fault_and_seeds():
    assert parse_fault("none") == {"model": "none", "f": 0.0, "s": 1.0, "collusion": False}
    assert parse_fault("collude:0.3") == {"model": "collude", "f": 0.3, "s": 1.0, "collusion": True}
    assert parse_fault("random:0.2:0.5")["s"] == 0.5
    with pytest.raises(ValueError):
        parse_fault("sybil:0.1")
    assert parse_seeds("1-3,7") == [1, 2, 3, 7]


def test_wilson_known_values():
    p, lo, hi = wilson(0, 100)
    assert p == 0.0 and lo == 0.0 and hi == pytest.approx(0.03699, abs=1e-4)
    p, lo, hi = wilson(50, 100)
    assert (lo, hi) == pytest.approx((0.4038, 0.5962), abs=1e-4)
    assert math.isnan(wilson(0, 0)[0])


def test_bootstrap_ci_contains_mean_and_is_deterministic():
    vals = [1.0, 2.0, 3.0, 4.0, 5.0]
    m, lo, hi = bootstrap_ci(vals)
    assert m == 3.0 and lo < 3.0 < hi
    assert bootstrap_ci(vals) == (m, lo, hi)
    assert bootstrap_ci([2.0, 2.0, 2.0]) == (2.0, 2.0, 2.0)
    assert all(math.isnan(v) for v in bootstrap_ci([None, float("nan")]))


def test_spread_labels_keeps_order_and_gap():
    ys = _spread_labels([5.0, 5.1, 1.0], min_gap=1.0)
    assert ys[2] == 1.0 and ys[1] - ys[0] >= 1.0 - 1e-12


def test_sweep_aggregate_and_outputs(tmp_path):
    df = run_sweep(["fifo"], ["fixed2", "adaptive"], ["none", "collude:0.3"], [1, 2], workers=1,
                   overrides={"workload": {"n_dags": 3, "tasks_per_dag": 20}, "workers": {"initial": 10}})
    assert len(df) == 2 * 2 * 2
    agg = aggregate(df)
    assert len(agg) == 4 and (agg["runs"] == 2).all()
    f2 = agg[(agg["verifier"] == "fixed2") & (agg["fault_model"] == "none")].iloc[0]
    assert f2["paid_per_task"] == 2.0 and f2["error_rate"] == 0.0
    for name in ("maliyet", "hatali_sonuc", "makespan"):
        assert plot_metric(agg, name, tmp_path).stat().st_size > 10_000
    table = write_table(agg, tmp_path).read_text(encoding="utf-8")
    assert "Sabit 2'li" in table and "Uyarlanabilir" in table and (tmp_path / "ozet.csv").exists()
