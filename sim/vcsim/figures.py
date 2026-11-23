"""Tarama özetlerinden istatistikler, grafikler ve tablo (Kapsam Dokümanı v2 §6).

    python -m vcsim.figures experiments/data/sim/hafta8-ilk --out docs/figures/hafta8

İstatistikler:
  - Ortalama ve %95 güven aralığı: tohumlar üzerinden yüzdelik bootstrap (B = 10 000, sabit tohum).
  - Hatalı sonuç oranı: tüm tohumların görevleri birleştirilerek Wilson aralığı.
Grafikler: her metrik için iki panel (rastgele | colluding hata modeli), x = hatalı worker oranı f;
f = 0 noktası iki panelde de aynıdır. Renkler varlığa bağlıdır (strateji → sabit renk).
"""

from __future__ import annotations

import argparse
import math
from pathlib import Path

import numpy as np
import pandas as pd

# Doğrulayıcı → (görünen ad, renk, işaretçi). Renkler sabit sırada, varlığa bağlı;
# palet dataviz doğrulayıcısından geçti (aqua'nın kontrastı düşük: doğrudan etiket + işaretçi + tablo).
STYLE = {
    "fixed2": ("Sabit 2'li", "#2a78d6", "o"),
    "fixed3": ("Sabit 3'lü + çoğunluk", "#eb6834", "s"),
    "adaptive": ("Uyarlanabilir", "#1baf7a", "^"),
    "boinc_adaptive": ("BOINC adaptive", "#eda100", "D"),
    "accept_first": ("accept_first", "#e87ba4", "v"),
}
SURFACE, INK, INK_2, GRID = "#fcfcfb", "#1f1f1e", "#5f5e58", "#e6e5df"
MODEL_TITLE = {"random": "Rastgele hata modeli", "collude": "Colluding hata modeli"}


# ---------- İstatistik ----------

def bootstrap_ci(values, b: int = 10_000, seed: int = 0, level: float = 0.95) -> tuple[float, float, float]:
    """Ortalama ve yüzdelik bootstrap güven aralığı."""
    x = np.asarray([v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))], float)
    if len(x) == 0:
        return (math.nan, math.nan, math.nan)
    if np.all(x == x[0]):  # tek değer ya da hepsi aynı: aralık sıfır genişlikte
        return (float(x[0]), float(x[0]), float(x[0]))
    rng = np.random.default_rng(seed)
    means = x[rng.integers(0, len(x), size=(b, len(x)))].mean(axis=1)
    a = (1 - level) / 2
    return (float(x.mean()), float(np.quantile(means, a)), float(np.quantile(means, 1 - a)))


def wilson(k: int, n: int, z: float = 1.959963984540054) -> tuple[float, float, float]:
    """Oran ve Wilson skor aralığı."""
    if n == 0:
        return (math.nan, math.nan, math.nan)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    lo = 0.0 if k == 0 else max(0.0, c - h)  # kenarlarda kayan nokta artığını bırakma
    hi = 1.0 if k == n else min(1.0, c + h)
    return (p, lo, hi)


def aggregate(df: pd.DataFrame) -> pd.DataFrame:
    """Konfigürasyon başına özet: maliyet ve makespan için bootstrap, hata için Wilson."""
    df = df.copy()
    df["makespan_s"] = df["makespan_ms"] / 1000.0
    df["paid_per_task"] = df["paid_units"] / df["tasks"]
    rows = []
    for key, g in df.groupby(["scheduler", "verifier", "fault_model", "f", "s"], sort=False):
        row = dict(zip(["scheduler", "verifier", "fault_model", "f", "s"], key))
        row["runs"] = len(g)
        for col in ("cost_per_job", "makespan_s", "paid_per_task"):
            m, lo, hi = bootstrap_ci(g[col].tolist())
            row.update({col: m, f"{col}_lo": lo, f"{col}_hi": hi})
        k, n = int(g["tasks_wrong"].sum()), int(g["tasks_with_truth"].sum())
        p, lo, hi = wilson(k, n)
        row.update({"error_rate": p, "error_rate_lo": lo, "error_rate_hi": hi, "tasks_wrong": k, "tasks_judged": n})
        row.update({"jobs": int(g["jobs"].sum()), "jobs_failed": int(g["jobs_failed"].sum()),
                    "spotchecks": int(g["spotchecks"].sum()), "tasks_invalidated": int(g["tasks_invalidated"].sum())})
        rows.append(row)
    return pd.DataFrame(rows)


# ---------- Grafik ----------

METRICS = {
    "maliyet": ("cost_per_job", "İş başına maliyet (test USDC, sınama işleri dahil)", "{:.3f}"),
    "hatali_sonuc": ("error_rate", "Görev düzeyinde hatalı sonuç oranı (%)", "{:.1%}"),
    "makespan": ("makespan_s", "Makespan (s)", "{:.1f}"),
}


def _panel_data(agg: pd.DataFrame, verifier: str, model: str, col: str) -> pd.DataFrame:
    g = agg[(agg["verifier"] == verifier) & agg["fault_model"].isin(["none", model])].sort_values("f")
    return g[["f", col, f"{col}_lo", f"{col}_hi"]]


def _spread_labels(ys: list[float], min_gap: float) -> list[float]:
    """Doğrudan etiketlerin üst üste binmemesi için dikey konumları en az min_gap aralıkla dağıtır."""
    order = sorted(range(len(ys)), key=lambda i: ys[i])
    out = list(ys)
    for a, b in zip(order, order[1:]):
        if out[b] - out[a] < min_gap:
            out[b] = out[a] + min_gap
    return out


def plot_metric(agg: pd.DataFrame, name: str, out_dir: Path) -> Path:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.ticker import FuncFormatter, PercentFormatter

    col, ylabel, _ = METRICS[name]
    verifiers = [v for v in STYLE if v in set(agg["verifier"])]
    models = [m for m in ("random", "collude") if m in set(agg["fault_model"])]
    scale = 100.0 if col == "error_rate" else 1.0

    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 10, "axes.edgecolor": GRID,
                         "axes.labelcolor": INK_2, "xtick.color": INK_2, "ytick.color": INK_2,
                         "text.color": INK})
    fig, axes = plt.subplots(1, len(models), figsize=(4.6 * len(models) + 1.6, 4.0), sharey=True,
                             facecolor=SURFACE, squeeze=False)
    axes = axes[0]
    ymax = 0.0
    for ax, model in zip(axes, models):
        ax.set_facecolor(SURFACE)
        for v in verifiers:
            label, color, marker = STYLE[v]
            d = _panel_data(agg, v, model, col)
            x = d["f"].to_numpy() * 100
            y = d[col].to_numpy() * scale
            lo = d[f"{col}_lo"].to_numpy() * scale
            hi = d[f"{col}_hi"].to_numpy() * scale
            ax.fill_between(x, lo, hi, color=color, alpha=0.14, linewidth=0)
            ax.plot(x, y, color=color, linewidth=2, marker=marker, markersize=6,
                    markeredgecolor=SURFACE, markeredgewidth=1.5, label=label, zorder=3)
            ymax = max(ymax, float(np.nanmax(hi)) if len(hi) else 0.0)
        ax.set_title(MODEL_TITLE[model], fontsize=10.5, color=INK, loc="left")
        ax.set_xlabel("Hatalı worker oranı f (%)")
        ax.set_xticks([0, 10, 20, 30])
        ax.set_xlim(-2, 37)
        ax.grid(axis="y", color=GRID, linewidth=0.8)
        ax.tick_params(length=0)
        for side in ("top", "right", "left"):
            ax.spines[side].set_visible(False)
    axes[0].set_ylabel(ylabel)
    top = ymax * 1.08 if ymax > 0 else 1.0
    axes[0].set_ylim(0, top)
    if col == "error_rate":
        axes[0].yaxis.set_major_formatter(PercentFormatter(decimals=0))
    else:
        axes[0].yaxis.set_major_formatter(FuncFormatter(lambda v, _: f"{v:g}".replace(".", ",")))

    # Doğrudan etiketler: son panelin sağ ucunda, çakışmayacak şekilde.
    last = axes[-1]
    ends = []
    for v in verifiers:
        d = _panel_data(agg, v, models[-1], col)
        ends.append(float(d[col].to_numpy()[-1]) * scale)
    ys = _spread_labels(ends, min_gap=top * 0.06)
    for v, y in zip(verifiers, ys):
        last.annotate(STYLE[v][0], xy=(31, y), fontsize=9, color=INK, va="center")
    fig.legend(*axes[0].get_legend_handles_labels(), loc="upper center", ncol=len(verifiers), frameon=False,
               bbox_to_anchor=(0.5, 1.02), fontsize=9)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    path = out_dir / f"{name}.png"
    fig.savefig(path, dpi=200, facecolor=SURFACE)
    plt.close(fig)
    return path


def write_table(agg: pd.DataFrame, out_dir: Path) -> Path:
    """Grafiklerin sayısal karşılığı (erişilebilirlik ve rapor için)."""
    def ci(m, lo, hi, fmt):
        if math.isnan(m):
            return "—"
        return f"{fmt.format(m)} [{fmt.format(lo)}, {fmt.format(hi)}]".replace(".", ",")

    lines = ["| Strateji | Hata modeli | f | Koşu | İş başına maliyet (test USDC) | Görev başına ödenen kopya | "
             "Hatalı sonuç oranı | Makespan (s) | FAILED iş | Sınama işi |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for _, r in agg.sort_values(["verifier", "fault_model", "f"]).iterrows():
        lines.append(
            f"| {STYLE.get(r.verifier, (r.verifier,))[0]} | {r.fault_model} | {r.f:.0%} | {r.runs} | "
            f"{ci(r.cost_per_job, r.cost_per_job_lo, r.cost_per_job_hi, '{:.4f}')} | "
            f"{ci(r.paid_per_task, r.paid_per_task_lo, r.paid_per_task_hi, '{:.3f}')} | "
            f"{ci(r.error_rate * 100, r.error_rate_lo * 100, r.error_rate_hi * 100, '{:.2f}')} % | "
            f"{ci(r.makespan_s, r.makespan_s_lo, r.makespan_s_hi, '{:.1f}')} | "
            f"{r.jobs_failed}/{r.jobs} | {r.spotchecks} |")
    path = out_dir / "ozet_tablo.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    agg.to_csv(out_dir / "ozet.csv", index=False)
    return path


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description="Tarama özetlerinden grafik ve tablo")
    ap.add_argument("sweep_dir", type=Path, help="vcsim.sweep çıktı klasörü (summaries.parquet)")
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    df = pd.read_parquet(args.sweep_dir / "summaries.parquet")
    args.out.mkdir(parents=True, exist_ok=True)
    agg = aggregate(df)
    for name in METRICS:
        print("→", plot_metric(agg, name, args.out))
    print("→", write_table(agg, args.out))


if __name__ == "__main__":
    main()
