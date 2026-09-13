"""Which observable conditions preceded good trades?

Joins hindsight labels (research/labels.py) with the feature snapshot (research/features.py) and
reports, for every feature bucket: coverage, win rate, expectancy in R (net of fees), the lift over
the base rate, a t-statistic, and how consistent the edge is across coins and years. Then the same
for pairs of the strongest features. Output: a markdown report plus CSVs.

Descriptive, in-sample statistics: they say where the money WAS, not where it will be. Anything that
looks good here still has to pass the walk-forward test before it becomes a strategy.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd

from .features import FEATURES

N_BINS = 8


@dataclass
class Condition:
    feature: str
    bucket: str
    n: int
    coverage_pct: float
    win_rate: float
    expectancy_r: float
    lift_r: float
    t_stat: float
    coins_positive: float  # fraction of coins with positive expectancy in this bucket
    years_positive: float  # fraction of years with positive expectancy in this bucket


def bucketize(df: pd.DataFrame) -> pd.DataFrame:
    """Add a `<feature>__b` string column per feature: quantile bins (pooled edges) or the category."""
    out = df.copy()
    for feat, kind in FEATURES.items():
        if feat not in df:
            continue
        s = df[feat]
        if kind == "cat":
            out[f"{feat}__b"] = s.map(lambda x: "nan" if pd.isna(x) else f"{x:g}")
            continue
        try:
            q = pd.qcut(s, N_BINS, duplicates="drop")
        except ValueError:
            continue
        out[f"{feat}__b"] = q.map(lambda iv: "nan" if pd.isna(iv) else f"{iv.left:.3g}..{iv.right:.3g}").astype(str)
    return out


def _stats(g: pd.DataFrame, base: float, total: int) -> dict:
    r = g["realized_r"]
    n = len(r)
    sd = r.std(ddof=1) if n > 1 else np.nan
    by_coin = g.groupby("symbol")["realized_r"].mean()
    by_year = g.groupby(g.index.year)["realized_r"].mean()
    return {
        "n": n, "coverage_pct": 100 * n / total, "win_rate": float((r > 0).mean()), "expectancy_r": float(r.mean()),
        "gross_r": float(g["gross_r"].mean()),  # before fees: separates a pattern from a fee artifact
        "lift_r": float(r.mean() - base), "t_stat": float(r.mean() / sd * np.sqrt(n)) if sd and sd > 0 else 0.0,
        "coins_positive": float((by_coin > 0).mean()) if len(by_coin) else 0.0,
        "years_positive": float((by_year > 0).mean()) if len(by_year) else 0.0,
    }


def condition_table(df: pd.DataFrame, min_n: int) -> pd.DataFrame:
    """One row per (feature, bucket), the whole pooled data set. `df` must be bucketized and carry `symbol`."""
    base = float(df["realized_r"].mean())
    total = len(df)
    rows = []
    for feat in FEATURES:
        col = f"{feat}__b"
        if col not in df:
            continue
        for bucket, g in df.groupby(col, sort=False):
            if bucket == "nan" or len(g) < min_n:
                continue
            rows.append({"feature": feat, "bucket": bucket, **_stats(g, base, total)})
    return pd.DataFrame(rows).sort_values("expectancy_r", ascending=False).reset_index(drop=True)


def pair_table(df: pd.DataFrame, single: pd.DataFrame, min_n: int, top_features: int = 8) -> pd.DataFrame:
    """Cross the buckets of the features with the largest single-bucket lift."""
    strength = single.groupby("feature")["lift_r"].apply(lambda s: s.abs().max()).sort_values(ascending=False)
    feats = list(strength.index[:top_features])
    base = float(df["realized_r"].mean())
    total = len(df)
    rows = []
    for a, b in combinations(feats, 2):
        for (ba, bb), g in df.groupby([f"{a}__b", f"{b}__b"], sort=False):
            if "nan" in (ba, bb) or len(g) < min_n:
                continue
            rows.append({"feature": f"{a} & {b}", "bucket": f"{ba} & {bb}", **_stats(g, base, total)})
    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows).sort_values("expectancy_r", ascending=False).reset_index(drop=True)


def _md_table(t: pd.DataFrame, n: int) -> str:
    if t.empty:
        return "_none_\n"
    head = "| condition | bucket | n | cov % | win % | net R | gross R | lift R | t | coins + | years + |\n"
    head += "|" + "---|" * 11 + "\n"
    body = ""
    for _, r in t.head(n).iterrows():
        body += (f"| {r.feature} | {r.bucket} | {r.n:,} | {r.coverage_pct:.1f} | {100 * r.win_rate:.1f} | {r.expectancy_r:+.3f} | "
                 f"{r.gross_r:+.3f} | {r.lift_r:+.3f} | {r.t_stat:.1f} | {100 * r.coins_positive:.0f}% | {100 * r.years_positive:.0f}% |\n")
    return head + body


def report(df: pd.DataFrame, side: str, tf: str, params_tag: str, min_n: int, out_dir: Path, top: int = 25) -> Path:
    """Write <out_dir>/explain_<tf>_<side>.md (+ CSVs) and return the markdown path."""
    out_dir.mkdir(parents=True, exist_ok=True)
    b = bucketize(df)
    single = condition_table(b, min_n)
    pairs = pair_table(b, single, min_n * 2)
    base_r = df["realized_r"].mean()
    base_gross = df["gross_r"].mean()
    base_fee = df["fee_r"].mean()
    base_win = (df["realized_r"] > 0).mean()
    outcomes = df["outcome"].value_counts(normalize=True)
    per_coin = df.groupby("symbol")["realized_r"].agg(["count", "mean"]).sort_values("mean", ascending=False)
    per_year = df.groupby(df.index.year)["realized_r"].agg(["count", "mean"])
    good = single[(single.t_stat >= 3) & (single.coins_positive >= 0.7) & (single.years_positive >= 0.7)]
    bad = single.sort_values("expectancy_r").head(top)

    md = [f"# What preceded good {'buys' if side == 'long' else 'sells'} — {tf} bars, {params_tag}", ""]
    scope = f"Bars: {len(df):,} across {df['symbol'].nunique()} coins, {df.index.min().date()} → {df.index.max().date()}. "
    md += [scope + f"Every bar is a hypothetical {side} entered at the next open; labels net of 0.1% fees per side and 0.05% slippage.", ""]
    md += ["## Base rate", "", f"- expectancy **{base_r:+.3f} R** per bar net of fees ({base_gross:+.3f} R gross, fees {base_fee:.2f} R per trade), win rate {100 * base_win:.1f}%",
           "- outcomes: " + ", ".join(f"{k} {100 * v:.1f}%" for k, v in outcomes.items()),
           f"- a random entry loses about {-base_r:.2f} R on average; a condition is only interesting if its lift is well above that noise.", ""]
    md += ["## Robust single conditions (t ≥ 3, positive in ≥ 70% of coins and ≥ 70% of years)", "", _md_table(good, top)]
    md += [f"## Top {top} single conditions by expectancy", "", _md_table(single, top)]
    md += [f"## Worst {top} single conditions (when NOT to {'buy' if side == 'long' else 'sell'})", "", _md_table(bad, top)]
    md += [f"## Top {top} pairs of conditions", "", _md_table(pairs, top)]
    md += ["## Per coin", "", "| coin | bars | exp R |", "|---|---|---|"]
    md += [f"| {s} | {int(r['count']):,} | {r['mean']:+.3f} |" for s, r in per_coin.iterrows()]
    md += ["", "## Per year", "", "| year | bars | exp R |", "|---|---|---|"]
    md += [f"| {y} | {int(r['count']):,} | {r['mean']:+.3f} |" for y, r in per_year.iterrows()]
    md += ["", "_Descriptive, in-sample. Candidates go through `research walkforward` / `optimize` before they become a strategy._", ""]
    path = out_dir / f"explain_{tf}_{side}.md"
    path.write_text("\n".join(md), encoding="utf-8")
    single.to_csv(out_dir / f"explain_{tf}_{side}_conditions.csv", index=False)
    if not pairs.empty:
        pairs.to_csv(out_dir / f"explain_{tf}_{side}_pairs.csv", index=False)
    return path
