"""The pure would-have-won replay on hand-built candles: win, loss, still open, gap at fill, regime
invalidation. No database."""

import numpy as np
import pandas as pd
import pytest

from research.config import ExitParams
from research.jobs.would_have_won import replay

SIGNAL = {
    "id": "s1_btc_15m:BTCUSDT:15m:2024-01-01T10:00:00Z", "ts": "2024-01-01T10:15:00Z", "timeframe": "15m",
    "entry_price": 100.0, "stop_price": 99.0, "tp1_price": 101.0, "tp_price": 102.0, "meta": {},
}
NO_TRAIL = ExitParams(trail_atr_k=None, tp_ratchet_atr=None)


def bars(closes_after: list[float], first_open: float | None = None, warmup: int = 20, tf: str = "15min") -> pd.DataFrame:
    """`warmup` flat bars at 100 up to the signal candle (open 10:00), then one bar per close from 10:15."""
    closes = np.array([100.0] * warmup + closes_after)
    start = pd.Timestamp("2024-01-01 10:15", tz="UTC") - pd.Timedelta(tf) * warmup
    idx = pd.date_range(start, periods=len(closes), freq=tf)
    opens = np.concatenate([[100.0], closes[:-1]])
    if first_open is not None:
        opens[warmup] = first_open
    return pd.DataFrame(
        {"open": opens, "high": np.maximum(opens, closes) + 0.1, "low": np.minimum(opens, closes) - 0.1, "close": closes, "volume": 1.0},
        index=idx,
    )


def test_win_takes_tp1_then_tp():
    e = bars([100.3, 100.6, 100.9, 101.3, 101.6, 101.9, 102.3, 102.6])
    res = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None)
    assert res["outcome"] == "win" and res["close_reason"] == "take_profit"
    assert res["exit_price"] == pytest.approx(102.0)
    # half out at +1R, half at +2R, minus fees on entry and both exits
    fees_r = (100 * 0.001 + 101 * 0.5 * 0.001 + 102 * 0.5 * 0.001) / 1.0
    assert res["realized_r"] == pytest.approx(1.5 - fees_r)
    assert res["bars_held"] == 6 and res["closed_at"] == e.index[20 + 5]


def test_loss_hits_stop():
    e = bars([99.7, 99.4, 99.2, 98.8, 98.5])
    res = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None)
    assert res["outcome"] == "loss" and res["close_reason"] == "stop"
    assert res["exit_price"] == pytest.approx(99.0)
    assert res["realized_r"] == pytest.approx(-1 - (100 * 0.001 + 99 * 0.001))
    assert res["bars_held"] == 4  # third bar's low (99.1) is still above the stop; the fourth (98.7) hits it


def test_open_when_candles_run_out():
    e = bars([100.2, 99.8, 100.1, 99.9, 100.3, 99.7])
    res = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None)
    assert res == {"outcome": "open", "realized_r": None, "exit_price": None, "close_reason": "open", "bars_held": 6, "closed_at": None}
    # no candle after the signal at all
    res = replay(SIGNAL, e.iloc[:20], None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None)
    assert res["outcome"] == "open" and res["bars_held"] == 0


def test_max_bars_caps_the_replay():
    e = bars([100.0 + (0.2 if i % 2 else -0.2) for i in range(40)])
    res = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None, max_bars=10)
    assert res["outcome"] == "open" and res["bars_held"] == 10


def test_gap_at_fill_is_not_replayed():
    up = bars([102.5, 103.0], first_open=102.4)  # opens above the target
    assert replay(SIGNAL, up, None, NO_TRAIL, 0.0, None)["outcome"] == "gap_at_fill"
    down = bars([98.0, 97.0], first_open=98.9)  # opens below the stop
    assert replay(SIGNAL, down, None, NO_TRAIL, 0.0, None)["outcome"] == "gap_at_fill"
    # slippage can push the fill through the target too
    assert replay(SIGNAL, bars([102.5], first_open=101.95), None, NO_TRAIL, 0.1, None)["outcome"] == "gap_at_fill"


def test_slippage_worsens_the_fill():
    e = bars([100.3, 100.6, 100.9, 101.3, 101.6, 101.9, 102.3, 102.6])
    clean = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.0, invalidation_level=None)["realized_r"]
    slipped = replay(SIGNAL, e, None, NO_TRAIL, slippage_pct=0.2, invalidation_level=None)["realized_r"]
    assert slipped < clean


def test_regime_invalidation_closes_at_next_open():
    e = bars([100.2, 99.8, 100.1, 99.9, 100.3, 99.7, 100.2, 99.9])  # never reaches stop or target
    # 1h regime candles: the 10:00 bar (closes 11:00) settles below the invalidation level
    ridx = pd.date_range("2024-01-01 06:00", periods=6, freq="1h", tz="UTC")
    r = pd.DataFrame({"open": 100.0, "high": 100.5, "low": 99.0, "close": [100.0, 100.0, 100.0, 100.0, 99.2, 100.0], "volume": 1.0}, index=ridx)
    res = replay(SIGNAL, e, r, NO_TRAIL, slippage_pct=0.0, invalidation_level=99.5)
    assert res["close_reason"] == "regime"
    assert res["closed_at"] == pd.Timestamp("2024-01-01 11:00", tz="UTC")  # first entry bar after the 1h close
    assert res["exit_price"] == pytest.approx(float(e.loc[res["closed_at"], "open"]))
    assert res["outcome"] in {"win", "loss", "breakeven"}
    # without a level the same candles stay open
    assert replay(SIGNAL, e, r, NO_TRAIL, 0.0, None)["outcome"] == "open"


def test_default_exit_policy_trails_after_tp1():
    e = bars([100.3, 100.6, 100.9, 101.3, 101.6, 101.2, 100.6, 100.0, 99.5])
    res = replay(SIGNAL, e, None, ExitParams(), slippage_pct=0.0, invalidation_level=None)
    assert res["close_reason"] in {"trailing", "stop"}
    assert res["outcome"] in {"win", "breakeven", "loss"}
