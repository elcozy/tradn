import numpy as np
import pandas as pd

from research.explain import apply_edges, fit_edges
from research.forward import Rule, non_overlapping, rule_mask, run, score


def frame(n=12000, seed=0):
    """Two coins, hourly bars over ~1.5 years; rsi < 25 is a real edge, everything else is noise."""
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2023-01-01", periods=n, freq="h", tz="UTC")
    rows = []
    for sym in ("AUSDT", "BUSDT"):
        rsi = rng.uniform(0, 100, n)
        r = np.where(rsi < 25, rng.normal(0.5, 1.0, n), rng.normal(-0.15, 1.0, n))
        rows.append(pd.DataFrame({
            "symbol": sym, "realized_r": r, "gross_r": r + 0.1, "outcome": "x", "bars_held": rng.integers(1, 6, n),
            "rsi": rsi, "atr_pct": rng.uniform(0.1, 3, n), "bullish": rng.integers(0, 2, n), "hour": idx.hour, "dow": idx.dayofweek,
        }, index=idx))
    return pd.concat(rows)


def test_non_overlapping_skips_bars_while_a_trade_is_open():
    idx = pd.date_range("2024-01-01", periods=6, freq="h", tz="UTC")
    df = pd.DataFrame({"symbol": "AUSDT", "bars_held": [3, 1, 1, 1, 2, 1], "realized_r": 1.0, "gross_r": 1.0}, index=idx)
    kept = non_overlapping(df, "1h")
    assert list(kept.index.hour) == [0, 3, 4]  # 00:00 holds 3h (skip 01,02); 03:00 holds 1h; 04:00 holds 2h (skip 05)
    two = pd.concat([df, df.assign(symbol="BUSDT")])
    assert len(non_overlapping(two, "1h")) == 6  # per coin


def test_edges_fit_on_train_apply_to_test_with_same_labels():
    df = frame()
    train, test = df[df.index < "2023-10-01"], df[df.index >= "2023-10-01"]
    edges = fit_edges(train)
    tb, sb = apply_edges(train, edges), apply_edges(test, edges)
    assert set(sb["rsi__b"].unique()) <= set(tb["rsi__b"].unique()) | {"nan"}
    rule = Rule([("rsi", min(tb["rsi__b"].unique()))], 0.0, 0)
    assert rule_mask(sb, rule).sum() > 0


def test_score_metrics():
    idx = pd.date_range("2024-01-01", periods=4, freq="D", tz="UTC")
    t = pd.DataFrame({"symbol": ["A", "A", "B", "B"], "realized_r": [1.0, -1.0, -1.0, 2.0], "gross_r": [1.1, -0.9, -0.9, 2.1]}, index=idx)
    s = score(t, "x")
    assert s.trades == 4 and s.expectancy_r == 0.25 and s.win_rate == 0.5 and s.max_drawdown_r == -2.0 and s.coins_positive == 0.5
    assert s.per_year == {2024: 0.25} and s.years_positive == 1.0
    assert not s.passes and not s.robust
    idx2 = pd.date_range("2024-12-31", periods=4, freq="D", tz="UTC")
    s2 = score(t.set_index(idx2), "y")
    assert set(s2.per_year) == {2024, 2025} and s2.years_positive == 0.5 and "2025" in s2.years_str


def test_run_finds_the_planted_edge_out_of_sample():
    df = frame()
    res = run(df, "1h", test_from="2023-10-01", min_n=100)
    best = res.rules[0]
    assert "rsi" in best.name and best.expectancy_r > 0.2 and best.trades > 100
    assert best.years_positive == 1.0 and set(best.per_year) == {2023, 2024}  # test months span 2023-10 → 2024-05
    assert any(s.robust and "rsi" in s.name for s in res.rules)  # the single-bucket rsi rule has enough trades
    assert res.model[0].expectancy_r > res.test_base  # any model threshold beats random
    assert res.importances.index[0] == "rsi"
