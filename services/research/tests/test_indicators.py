import numpy as np
import pandas as pd
import pytest

from research import indicators as ind


def frame(closes, highs=None, lows=None):
    closes = np.asarray(closes, dtype=float)
    highs = closes + 1 if highs is None else np.asarray(highs, dtype=float)
    lows = closes - 1 if lows is None else np.asarray(lows, dtype=float)
    idx = pd.date_range("2024-01-01", periods=len(closes), freq="15min", tz="UTC")
    return pd.DataFrame({"open": closes, "high": highs, "low": lows, "close": closes, "volume": 1.0}, index=idx)


def test_ema_matches_hand_calc():
    s = pd.Series([1.0, 2.0, 3.0, 4.0])
    e = ind.ema(s, 3)  # alpha = 0.5
    assert e.tolist() == pytest.approx([1.0, 1.5, 2.25, 3.125])


def test_rsi_bounds_and_direction():
    up = pd.Series(np.linspace(100, 120, 30))
    down = pd.Series(np.linspace(120, 100, 30))
    assert ind.rsi(up).iloc[-1] == pytest.approx(100)
    assert ind.rsi(down).iloc[-1] == pytest.approx(0)
    flat = pd.Series([5.0] * 20)
    assert ind.rsi(flat).iloc[-1] == 50


def test_atr_wilder_first_values():
    df = frame([10, 11, 12], highs=[11, 12, 13], lows=[9, 10, 11])
    tr = ind.true_range(df)
    assert tr.tolist() == pytest.approx([2.0, 2.0, 2.0])  # bar 2: max(12-10, |12-10|, |10-10|) = 2
    df2 = frame([10, 11, 15], highs=[11, 12, 16], lows=[9, 10, 14])  # bar 3 gaps: TR = max(2, 16-11=5, 11-14->3) = 5
    a = ind.atr(df2, 2)  # alpha 0.5: 2, 2, 3.5
    assert a.tolist() == pytest.approx([2.0, 2.0, 3.5])


def test_bollinger_symmetry():
    df = frame(np.sin(np.linspace(0, 10, 100)) * 5 + 100)
    bb = ind.bollinger(df["close"], 20, 2)
    mid = bb["bb_mid"].dropna()
    assert ((bb["bb_upper"] - mid) - (mid - bb["bb_lower"])).dropna().abs().max() < 1e-9


def test_macd_hist_is_line_minus_signal():
    df = frame(np.cumsum(np.random.default_rng(0).normal(size=200)) + 100)
    m = ind.macd(df["close"])
    assert (m["macd_hist"] - (m["macd"] - m["macd_signal"])).abs().max() < 1e-12


def test_adx_range():
    df = frame(np.cumsum(np.random.default_rng(1).normal(size=300)) + 100)
    a = ind.adx(df).dropna()
    assert a.between(0, 100).all()


def test_swing_points_and_confirmation():
    lows = [10, 9, 8, 7, 8, 9, 10, 11, 12, 11, 10, 9, 8.5, 9, 10, 11, 12, 13, 14, 15]
    highs = [x + 2 for x in lows]
    df = frame(lows, highs=highs, lows=lows)
    sw = ind.swing_points(df, width=3)
    assert sw["swing_low"].tolist().index(True) == 3  # low 7 at index 3
    assert sw.loc[sw["swing_low"], "confirmed_idx"].tolist()[0] == 6
    assert sw["swing_high"].iloc[8]  # high 14 at index 8 is the local max within +-3


def test_cluster_levels():
    levels = ind.cluster_levels([100.0, 100.1, 100.2, 105.0, 104.9, 120.0], tolerance_pct=0.25)
    assert [round(p, 2) for p, _ in levels] == [100.1, 104.95, 120.0]
    assert [n for _, n in levels] == [3, 2, 1]
    assert ind.cluster_levels([]) == []
