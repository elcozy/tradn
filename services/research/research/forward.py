"""Step 3: does anything found in the past keep working in the future?

Splits the labelled bars in time (train years / test years), mines candidate rules on the training
years only (the best single and paired feature buckets from research/explain.py), then scores each
rule on the test years as a sequence of NON-overlapping trades per coin: expectancy net of fees, win
rate, trades per month, max drawdown of cumulative R, and in how many coins it stayed positive.
A gradient-boosting model trained on the same training years gives the ceiling: the best any
combination of these features can do, at several selectivity thresholds.

The bar to pass: positive out-of-sample expectancy on at least a few hundred trades. Anything that
clears it is a candidate for a strategy; anything that does not is a pattern that only existed in
hindsight.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from .config import TIMEFRAME_MS
from .explain import Edges, apply_edges, condition_table, fit_edges, pair_table
from .features import FEATURES

CLIP_R = (-3.0, 6.0)


@dataclass
class Rule:
    conditions: list[tuple[str, str]]  # (feature, bucket string), all must hold
    train_expectancy: float
    train_n: int

    @property
    def name(self) -> str:
        return " & ".join(f"{f} in {b}" for f, b in self.conditions)


@dataclass
class Score:
    name: str
    trades: int
    expectancy_r: float
    gross_r: float
    win_rate: float
    trades_per_month: float
    max_drawdown_r: float
    coins_positive: float
    train_expectancy: float | None = None
    per_coin: dict[str, float] = field(default_factory=dict)
    per_year: dict[int, float] = field(default_factory=dict)  # test expectancy per calendar year

    @property
    def years_positive(self) -> float:
        return sum(v > 0 for v in self.per_year.values()) / len(self.per_year) if self.per_year else 0.0

    @property
    def passes(self) -> bool:
        return self.trades >= 300 and self.expectancy_r > 0

    @property
    def robust(self) -> bool:
        """Passes AND made money in every test year AND in most coins: not carried by one year or one coin."""
        return self.passes and self.years_positive == 1.0 and self.coins_positive >= 0.6

    @property
    def years_str(self) -> str:
        return ", ".join(f"{y} {v:+.2f}" for y, v in sorted(self.per_year.items()))


# ---- trade sequencing ----------------------------------------------------------------------------


def non_overlapping(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    """Keep, per coin, only the trades that could actually have been taken one after another:
    a bar is skipped while the previous trade of that coin is still open."""
    bar_ms = TIMEFRAME_MS[tf]
    keep = np.zeros(len(df), dtype=bool)
    order = np.lexsort((df.index.asi8, df["symbol"].to_numpy()))
    sym = df["symbol"].to_numpy()[order]
    t = df.index.asi8[order] // 1_000_000
    held = df["bars_held"].to_numpy()[order]
    free_at = -1
    cur = None
    for k in range(len(order)):
        if sym[k] != cur:
            cur, free_at = sym[k], -1
        if t[k] >= free_at:
            keep[order[k]] = True
            free_at = t[k] + int(held[k]) * bar_ms
    return df[keep]


def score(trades: pd.DataFrame, name: str, train_expectancy: float | None = None) -> Score:
    if trades.empty:
        return Score(name, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, train_expectancy)
    r = trades["realized_r"]
    months = max((trades.index.max() - trades.index.min()).days / 30.4, 1.0)
    cum = r.sort_index().cumsum().to_numpy()
    dd = cum - np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    per_coin = trades.groupby("symbol")["realized_r"].mean()
    per_year = r.groupby(trades.index.year).mean()
    return Score(
        name=name, trades=len(r), expectancy_r=float(r.mean()), gross_r=float(trades["gross_r"].mean()),
        win_rate=float((r > 0).mean()), trades_per_month=len(r) / months, max_drawdown_r=float(dd.min()),
        coins_positive=float((per_coin > 0).mean()), train_expectancy=train_expectancy, per_coin=per_coin.round(3).to_dict(),
        per_year={int(y): float(v) for y, v in per_year.items()},
    )


# ---- rules ---------------------------------------------------------------------------------------


def mine_rules(train_b: pd.DataFrame, min_n: int, top: int = 15) -> list[Rule]:
    """Best single buckets and best pairs on the training years, by expectancy."""
    single = condition_table(train_b, min_n)
    pairs = pair_table(train_b, single, min_n * 2)
    rules: list[Rule] = []
    for _, r in single.head(top).iterrows():
        rules.append(Rule([(r.feature, r.bucket)], float(r.expectancy_r), int(r.n)))
    for _, r in pairs.head(top).iterrows():
        feats, buckets = r.feature.split(" & "), r.bucket.split(" & ")
        rules.append(Rule(list(zip(feats, buckets, strict=True)), float(r.expectancy_r), int(r.n)))
    return rules


def rule_mask(df_b: pd.DataFrame, rule: Rule) -> np.ndarray:
    m = np.ones(len(df_b), dtype=bool)
    for feat, bucket in rule.conditions:
        m &= (df_b[f"{feat}__b"] == bucket).to_numpy()
    return m


def test_rules(rules: list[Rule], test_b: pd.DataFrame, tf: str) -> list[Score]:
    out = []
    for rule in rules:
        trades = non_overlapping(test_b[rule_mask(test_b, rule)], tf)
        out.append(score(trades, rule.name, rule.train_expectancy))
    return sorted(out, key=lambda s: -s.expectancy_r)


# ---- model ceiling -------------------------------------------------------------------------------


def _feature_matrix(df: pd.DataFrame) -> tuple[pd.DataFrame, list[bool]]:
    cols = [f for f in FEATURES if f in df]
    x = df[cols].astype(float)
    return x, [FEATURES[f] == "cat" for f in cols]


def fit_model(train: pd.DataFrame, seed: int = 0, max_rows: int = 600_000):
    from sklearn.ensemble import HistGradientBoostingRegressor

    sample = train.sample(min(len(train), max_rows), random_state=seed)
    x, cat = _feature_matrix(sample)
    y = sample["realized_r"].clip(*CLIP_R)
    model = HistGradientBoostingRegressor(
        max_iter=300, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=200, l2_regularization=1.0,
        categorical_features=cat, random_state=seed,
    )
    model.fit(x, y)
    return model


def test_model(model, test: pd.DataFrame, tf: str, thresholds: tuple[float, ...] = (0.0, 0.1, 0.2, 0.3, 0.5)) -> list[Score]:
    x, _ = _feature_matrix(test)
    pred = model.predict(x)
    out = []
    for thr in thresholds:
        picked = test[pred > thr]
        trades = non_overlapping(picked, tf)
        out.append(score(trades, f"model: predicted R > {thr:g}"))
    return out


def importances(model, test: pd.DataFrame, seed: int = 0, rows: int = 40_000) -> pd.Series:
    from sklearn.inspection import permutation_importance

    sample = test.sample(min(len(test), rows), random_state=seed)
    x, _ = _feature_matrix(sample)
    y = sample["realized_r"].clip(*CLIP_R)
    imp = permutation_importance(model, x, y, n_repeats=3, random_state=seed, n_jobs=-1)
    return pd.Series(imp.importances_mean, index=x.columns).sort_values(ascending=False)


# ---- report --------------------------------------------------------------------------------------


@dataclass
class ForwardResult:
    rules: list[Score]
    model: list[Score]
    importances: pd.Series
    train_base: float
    test_base: float
    edges: Edges
    train_rows: int
    test_rows: int


def run(df: pd.DataFrame, tf: str, test_from: str, min_n: int, seed: int = 0) -> ForwardResult:
    cut = pd.Timestamp(test_from, tz="UTC")
    train, test = df[df.index < cut], df[df.index >= cut]
    if train.empty or test.empty:
        raise ValueError(f"split at {test_from} leaves {len(train)} train / {len(test)} test rows")
    edges = fit_edges(train)
    train_b, test_b = apply_edges(train, edges), apply_edges(test, edges)
    rules = test_rules(mine_rules(train_b, min_n), test_b, tf)
    model = fit_model(train, seed)
    return ForwardResult(
        rules=rules, model=test_model(model, test, tf), importances=importances(model, test, seed),
        train_base=float(train["realized_r"].mean()), test_base=float(test["realized_r"].mean()), edges=edges,
        train_rows=len(train), test_rows=len(test),
    )


def _flag(s: Score) -> str:
    return " **ROBUST**" if s.robust else (" **PASS**" if s.passes else "")


def _rows(scores: list[Score], with_train: bool) -> str:
    head = "| rule | train exp R | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |\n" if with_train else \
        "| selection | test trades | test exp R | gross R | win % | trades/month | max DD R | coins + | years + |\n"
    head += "|" + "---|" * (10 if with_train else 9) + "\n"
    body = ""
    for s in scores:
        tr = f" {s.train_expectancy:+.3f} |" if with_train else ""
        body += (f"| {s.name}{_flag(s)} |{tr} {s.trades:,} | {s.expectancy_r:+.3f} | {s.gross_r:+.3f} | {100 * s.win_rate:.1f} | "
                 f"{s.trades_per_month:.1f} | {s.max_drawdown_r:.1f} | {100 * s.coins_positive:.0f}% | {100 * s.years_positive:.0f}% |\n")
    return head + body


def _verdict_line(s: Score) -> str:
    tag = "ROBUST" if s.robust else "pass"
    return (f"- **{tag}** {s.name}: {s.expectancy_r:+.3f} R over {s.trades:,} trades, {s.trades_per_month:.1f}/month, "
            f"positive in {100 * s.coins_positive:.0f}% of coins; by year: {s.years_str}")


def report(res: ForwardResult, side: str, tf: str, params_tag: str, test_from: str, out_dir: Path) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    passing = sorted((s for s in res.rules + res.model if s.passes), key=lambda s: (not s.robust, -s.expectancy_r))
    robust = [s for s in passing if s.robust]
    md = [f"# Forward test — {tf} {side}, {params_tag}", ""]
    intro = (
        f"Train: bars before {test_from} ({res.train_rows:,} bars, base rate {res.train_base:+.3f} R). "
        f"Test: bars from {test_from} ({res.test_rows:,} bars, base rate {res.test_base:+.3f} R). "
        "Rules were chosen on the training years only; every number below is measured on the test years, "
        "as non-overlapping trades per coin, net of 0.1% fees per side and 0.05% slippage. "
        "PASS = positive test expectancy on ≥ 300 trades. ROBUST = PASS and positive in every test year and in ≥ 60% of coins."
    )
    md += [intro, ""]
    md += ["## Verdict", ""]
    if passing:
        md += [f"**{len(passing)} selection(s) stay positive out of sample with ≥ 300 trades, {len(robust)} of them robust:**", ""]
        md += [_verdict_line(s) for s in passing]
        tried = len(res.rules) + len(res.model)
        chance = (
            f"_{len(res.rules)} rules and {len(res.model)} model thresholds were tried; by chance alone about "
            f"{tried * 0.05:.1f} of them would look positive. Weight the ROBUST ones._"
        )
        md += ["", chance]
    else:
        nothing = (
            "**Nothing passes.** No rule mined on the training years, and no model threshold, has positive expectancy on the "
            "test years with enough trades. At this timeframe and barrier setting the patterns in the past did not persist, "
            "or are smaller than the costs."
        )
        md += [nothing]
    md += ["", "## Rules mined on the training years, scored on the test years", "", _rows(res.rules, True)]
    md += ["## Gradient-boosting model (ceiling), by selectivity", "", _rows(res.model, False)]
    md += ["## What the model relied on (permutation importance on the test years)", "", "| feature | importance |", "|---|---|"]
    md += [f"| {k} | {v:.4f} |" for k, v in res.importances.head(15).items()]
    md += ["", "_A rule that passes here goes through `research backtest` / `walkforward` as a strategy next; it is not yet one._", ""]
    path = out_dir / f"forward_{tf}_{params_tag}.md"  # the tag already carries the side
    path.write_text("\n".join(md), encoding="utf-8")
    return path
