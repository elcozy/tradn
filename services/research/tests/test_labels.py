import numpy as np
import pandas as pd
import pytest

from research.explain import bucketize, condition_table, pair_table
from research.features import FEATURES, features
from research.labels import OUTCOME_STOP, OUTCOME_TARGET, OUTCOME_TIME, LabelParams, label

from .synth import candles, resample


def bars(rows):
    """rows: (open, high, low, close) -> DataFrame with a flat ATR so the barriers are easy to reason about."""
    idx = pd.date_range("2024-01-01", periods=len(rows), freq="15min", tz="UTC")
    df = pd.DataFrame(rows, columns=["open", "high", "low", "close"], index=idx)
    df["volume"] = 1.0
    return df


def test_label_target_stop_and_time_outcomes():
    # 20 flat bars warm the ATR to ~2 (range 2 every bar), then the scenarios
    flat = [(100, 101, 99, 100)] * 20
    rows = flat + [
        (100, 101, 99, 100),  # i=20: signal bar; entry at next open 100.05 (slippage)
        (100, 105, 99.5, 104),  # i=21: high 105 >= target ~104.05 -> target hit at k=1
        (100, 101, 99, 100),  # i=22: signal bar
        (100, 105, 97, 98),  # i=23: touches both -> stop counts first (worst case)
        (100, 101, 99, 100),  # i=24: signal bar
    ] + [(100, 100.5, 99.5, 100.2)] * 30  # never reaches either barrier -> time exit
    df = bars(rows)
    p = LabelParams(side="long", stop_atr=1.0, target_atr=2.0, max_bars=10, fee_pct=0.1, slippage_pct=0.05)
    out = label(df, p)
    r20, r22, r24 = (out.loc[df.index[i]] for i in (20, 22, 24))
    assert r20.outcome == OUTCOME_TARGET and r20.bars_held == 1
    assert r20.gross_r == pytest.approx(2.0) and r20.realized_r < 2.0 and r20.fee_r > 0
    assert r22.outcome == OUTCOME_STOP and r22.gross_r == pytest.approx(-1.0) and r22.realized_r < -1.0
    assert r24.outcome == OUTCOME_TIME and r24.bars_held == 10
    assert r24.exit_price == pytest.approx(100.2)
    assert r20.mfe_r >= 2.0 and r22.mae_r >= 1.0
    # the tail whose horizon runs past the data is dropped
    assert df.index[-1] not in out.index and len(out) < len(df)


def test_short_labels_mirror_long():
    flat = [(100, 101, 99, 100)] * 20
    df = bars(flat + [(100, 101, 99, 100), (100, 100.5, 95, 96)] + [(96, 97, 95, 96)] * 5)
    out = label(df, LabelParams(side="short", max_bars=3))
    r = out.loc[df.index[20]]
    assert r.outcome == OUTCOME_TARGET and r.gross_r == pytest.approx(2.0)
    assert r.stop > r.entry > r.target


def test_features_have_no_look_ahead():
    e = candles(3000, "15m", seed=7)
    h1 = resample(e, "1h")
    h4 = resample(e, "4h")
    d1 = resample(e, "1d")
    f = features(e, "15m", h1=h1, h4=h4, d1=d1, btc_h1=h1)
    assert set(FEATURES) <= set(f.columns)
    i = 2500
    mutated = e.copy()
    mutated.iloc[i + 1 :, :4] *= 1.5  # wreck the future
    f2 = features(mutated, "15m", h1=resample(mutated, "1h"), h4=resample(mutated, "4h"), d1=resample(mutated, "1d"), btc_h1=resample(mutated, "1h"))
    a, b = f.iloc[i].astype(float), f2.iloc[i].astype(float)
    diff = (a - b).abs()
    assert diff.fillna(0).max() < 1e-9, diff[diff > 1e-9]
    assert f["hour"].iloc[i] == e.index[i].hour and f["dow"].iloc[i] == e.index[i].dayofweek
    assert f["rsi"].between(0, 100).all() and f["trend_1h"].dropna().isin([0.0, 1.0]).all()


def test_condition_and_pair_tables():
    rng = np.random.default_rng(0)
    n = 4000
    idx = pd.date_range("2022-01-01", periods=n, freq="h", tz="UTC")
    rsi = rng.uniform(0, 100, n)
    # oversold bars are good, everything else slightly negative
    r = np.where(rsi < 25, rng.normal(0.4, 1, n), rng.normal(-0.1, 1, n))
    df = pd.DataFrame({"symbol": np.where(np.arange(n) % 2 == 0, "AUSDT", "BUSDT"), "realized_r": r, "gross_r": r + 0.2, "outcome": "x", "rsi": rsi,
                       "bullish": (rng.uniform(size=n) > 0.5).astype(int)}, index=idx)
    b = bucketize(df)
    assert "rsi__b" in b and "bullish__b" in b
    t = condition_table(b, min_n=100)
    best = t.iloc[0]
    assert best.feature == "rsi" and best.bucket.startswith("0.0") or best.bucket.split("..")[1].replace(".", "").isdigit()
    assert best.expectancy_r > 0.2 and best.lift_r > 0.2 and best.t_stat > 3 and best.coins_positive == 1.0
    assert (t.n >= 100).all()
    pairs = pair_table(b, t, min_n=50, top_features=2)
    assert not pairs.empty and pairs.feature.iloc[0] == "rsi & bullish"
