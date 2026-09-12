"""S2 (indicator confluence) and S3 (range) on hand-built candles: the rules fire where they should,
skip reasons are named, nothing looks ahead, and the backtester runs each instance end to end."""

import numpy as np
import pandas as pd
import pytest

from research.backtest import engine
from research.config import TIMEFRAME_MS, load_config
from research.strategies.base import make_strategy, strategy_class
from research.strategies.indicator_confluence import IndicatorConfluence
from research.strategies.range_grid import RangeGrid

from .synth import candles, resample


@pytest.fixture
def cfg(repo_root):
    return load_config(repo_root / "config" / "strategies.yaml")


@pytest.fixture
def s2(cfg):
    return next(s for s in cfg.strategies if s.type == "indicator_confluence")


@pytest.fixture
def s3(cfg):
    return next(s for s in cfg.strategies if s.type == "range")


# ---- hand-built series -------------------------------------------------------------------------
def dip_series(n: int = 2400, k: int = 2000) -> tuple[pd.DataFrame, int]:
    """Trending 15m series (regime trend OK) with a sharp 5-bar sell-off at bar k followed by a bounce:
    RSI drops under 30 and crosses back up, closes pierce the lower band, the MACD histogram turns up."""
    e = candles(n, "15m", seed=21, drift=0.0004, vol=0.005)
    closes = e["close"].to_numpy().copy()
    for j in range(5):
        closes[k + j] = closes[k - 1] * (1 - 0.008 * (j + 1))
    for j in range(5, 12):
        closes[k + j] = closes[k + 4] * (1 + 0.005 * (j - 4))
    e["close"] = closes
    e["open"] = np.concatenate([[closes[0]], closes[:-1]])
    e["high"] = np.maximum(e["open"], e["close"]) * 1.0005
    e["low"] = np.minimum(e["open"], e["close"]) * 0.9995
    return e, k


def range_series(days: int = 40) -> pd.DataFrame:
    """5m series oscillating in a 12h sine range around 100: a wide range for the first 30 days, a
    narrower one after, so the regime's Bollinger width sits in the bottom of its 30-day distribution."""
    n = days * 288
    idx = pd.date_range("2024-01-01", periods=n, freq="5min", tz="UTC")
    t = np.arange(n)
    rng = np.random.default_rng(5)
    amp = np.where(t < 30 * 288, 4.0, 2.5)
    close = 100 + amp * np.sin(2 * np.pi * t / 144) + rng.normal(0, 0.05, n)
    open_ = np.concatenate([[100.0], close[:-1]])
    return pd.DataFrame(
        {"open": open_, "high": np.maximum(open_, close) + 0.03, "low": np.minimum(open_, close) - 0.03, "close": close, "volume": 1.0},
        index=idx,
    )


def closed_by(df: pd.DataFrame, tf: str, cut_close: pd.Timestamp) -> pd.DataFrame:
    """Bars of a slower frame that had closed by `cut_close` (what a live evaluation could see)."""
    return df[df.index + pd.Timedelta(milliseconds=TIMEFRAME_MS[tf]) <= cut_close]


def entry_close(e: pd.DataFrame, i: int, tf: str) -> pd.Timestamp:
    return e.index[i] + pd.Timedelta(milliseconds=TIMEFRAME_MS[tf])


# ---- S2 ----------------------------------------------------------------------------------------
def test_s2_fires_after_dip(cfg, s2):
    e, k = dip_series()
    r = resample(e, "1h")
    strat = IndicatorConfluence(s2, cfg.regime)
    strat.prepare(e, r)
    hits = [(i, strat._evaluate(i)) for i in range(k, k + 15)]
    fired = [(i, d) for i, (d, _) in hits if d is not None]
    assert fired, [reason for _, (_, reason) in hits]
    i, d = fired[0]
    p = strat.p
    rsi, atr = strat.entry["rsi"].to_numpy(), strat.entry["atr"].to_numpy()
    look = int(p["lookback_bars"])
    # the rules, checked by hand on the bar that fired
    assert any(rsi[j - 1] < p["rsi_oversold"] <= rsi[j] for j in range(i - look, i + 1))
    assert any(e["close"].iloc[j] <= strat.entry["bb_lower"].iloc[j] for j in range(i - look, i + 1))
    hist = strat.entry["macd_hist"].to_numpy()
    assert hist[i] > hist[i - 1]
    assert d.entry == pytest.approx(float(e["close"].iloc[i]))
    assert d.stop == pytest.approx(d.entry - p["stop_atr_k"] * atr[i])
    assert d.tp == pytest.approx(d.entry + p["r_mult"] * d.risk)
    assert d.tp1 == pytest.approx(d.entry + s2.exit.tp1_r * d.risk)
    assert d.invalidation_level is None
    assert {"rsi", "bb_lower", "macd_hist", "atr", "regime_ema_fast", "regime_ema_slow", "regime_atr_pct", "fee_r"} <= set(d.meta)
    assert strat.skip_reason(i) is None and strat.signal(i) is not None


def test_s2_skip_reasons(cfg, s2):
    e, k = dip_series()
    r = resample(e, "1h")
    strat = IndicatorConfluence(s2, cfg.regime)
    strat.prepare(e, r)
    assert strat.skip_reason(5) == "warmup"
    assert strat.skip_reason(k - 20) in {"no_rsi_cross", "no_bb_touch", "regime_trend", "regime_volatility"}
    midnight = next(i for i in range(k - 200, k) if e.index[i].hour == 0 and e.index[i].minute == 0)
    assert strat.skip_reason(midnight) in {"daily_open_window", "regime_trend", "regime_volatility"}
    # the components are visible in the frame for the dashboard / debugging
    assert {"rsi_cross_recent", "bb_touch_recent", "macd_rising"} <= set(strat.entry.columns)


def test_s2_no_lookahead(cfg, s2):
    e, k = dip_series()
    r = resample(e, "1h")
    full = IndicatorConfluence(s2, cfg.regime)
    full.prepare(e, r)
    for i in list(range(k - 3, k + 12)) + list(range(600, 1900, 173)):
        expected = full._evaluate(i)
        cut = entry_close(e, i, s2.entry_tf)
        part = IndicatorConfluence(s2, cfg.regime)
        part.prepare(e.iloc[: i + 1], closed_by(r, s2.regime_tf, cut))
        assert part._evaluate(i)[1] == expected[1], f"look-ahead at bar {i}"
        if expected[0] is not None:
            assert part._evaluate(i)[0].__dict__ == expected[0].__dict__
        # a different future must not change the past either
        mutated = e.copy()
        mutated.iloc[i + 1 :, :4] *= 1.08
        mut = IndicatorConfluence(s2, cfg.regime)
        mut.prepare(mutated, resample(mutated, "1h"))
        assert mut._evaluate(i)[1] == expected[1]


def test_s2_backtest_end_to_end(cfg, s2):
    e, _ = dip_series()
    r = resample(e, "1h")
    out = engine.run(cfg, s2, make_strategy(s2, cfg.regime), e, r)
    assert out.trades, out.skip_reasons
    for t in out.trades:
        assert t.stop_price < t.entry_price < t.tp1_price < t.tp_price
        assert t.bars_held <= s2.exit.max_bars  # the 24-bar time stop is an exit param
        assert t.close_reason in {"stop", "trailing", "take_profit", "time", "end"}
    assert sum(out.skip_reasons.values()) + len(out.trades) + out.bars_in_position >= out.bars - 1


# ---- S3 ----------------------------------------------------------------------------------------
def _s3_prepared(cfg, s3):
    e = range_series()
    r, g = resample(e, "1h"), resample(e, "15m")
    strat = RangeGrid(s3, cfg.regime)
    strat.prepare(e, r, g)
    return e, r, g, strat


def test_s3_fires_at_range_bottom(cfg, s3):
    e, _r, g, strat = _s3_prepared(cfg, s3)
    p = strat.p
    tail = range(31 * 288, len(e))
    fired = [(i, strat._evaluate(i)[0]) for i in tail]
    fired = [(i, d) for i, d in fired if d is not None]
    assert fired
    for i, d in fired[:5]:
        lo, hi = d.meta["range_low"], d.meta["range_high"]
        height = hi - lo
        rk = int(strat.range_idx[i])
        # the range is made of range_tf bars that had closed by the entry bar's close
        assert g.index[rk] + pd.Timedelta(minutes=15) <= entry_close(e, i, s3.entry_tf)
        assert lo == pytest.approx(float(g["low"].iloc[rk - p["range_bars"] + 1 : rk + 1].min()))
        assert hi == pytest.approx(float(g["high"].iloc[rk - p["range_bars"] + 1 : rk + 1].max()))
        assert height >= p["min_range_atr"] * d.meta["range_atr"]
        assert e["close"].iloc[i] > e["open"].iloc[i]
        assert d.entry <= lo + p["entry_zone_pct"] / 100 * height
        assert d.stop == pytest.approx(lo - p["stop_atr_k"] * d.meta["range_atr"])
        assert d.tp1 == pytest.approx(lo + 0.5 * height)
        assert d.tp == pytest.approx(lo + p["tp_zone_pct"] / 100 * height)
        assert d.stop < d.entry < d.tp1 < d.tp
        assert d.invalidation_level == pytest.approx(lo)
        assert d.meta["ladder"] == 1 and d.meta["range_tf"] == "15m"
        assert {"regime_adx", "regime_bb_width_rank", "regime_atr_pct"} <= set(d.meta)


def test_s3_one_entry_per_touch(cfg, s3):
    e, _r, _g, strat = _s3_prepared(cfg, s3)
    fired = [i for i in range(31 * 288, len(e)) if strat.signal(i) is not None]
    assert fired
    for i in fired:
        # no second signal until a close leaves the entry zone
        j = i + 1
        while j < len(e) and strat._in_zone[j]:
            assert strat.signal(j) is None
            assert strat.skip_reason(j) in {"touch_used", "not_bullish", "daily_open_window", "regime_trend", "regime_bb_width",
                                            "regime_volatility"}
            j += 1


def test_s3_regime_is_ranging_not_trending(cfg, s3):
    _e, _r, _g, strat = _s3_prepared(cfg, s3)
    reg = strat.regime
    ok = reg[reg["regime_ok"]]
    assert len(ok) > 0
    assert (ok["adx"] < strat.p["adx_max"]).all()
    assert (ok["bb_width_rank"] <= strat.p["bb_width_pct"] / 100).all()
    assert ok["vol_ok"].all()
    assert not ok["trend_ok"].all()  # the trend filter is deliberately not part of this regime


def test_s3_requires_range_frame(cfg, s3):
    e = range_series(days=3)
    r = resample(e, "1h")
    with pytest.raises(ValueError, match="range_tf"):
        RangeGrid(s3, cfg.regime).prepare(e, r)
    with pytest.raises(ValueError, match="range_tf"):
        engine.run(cfg, s3, make_strategy(s3, cfg.regime), e, r)
    with pytest.raises(ValueError, match="range_tf"):
        RangeGrid(s3.model_copy(update={"range_tf": None}), cfg.regime)
    with pytest.raises(ValueError, match="ladder"):
        RangeGrid(s3.model_copy(update={"params": {**s3.params, "ladder": 3}}), cfg.regime)


def test_s3_no_lookahead(cfg, s3):
    e, r, g, full = _s3_prepared(cfg, s3)
    fired = [i for i in range(31 * 288, len(e)) if full.signal(i) is not None]
    sample = fired[:3] + [i + 1 for i in fired[:2]] + list(range(31 * 288, len(e), 997))
    for i in sample:
        expected = full._evaluate(i)
        cut = entry_close(e, i, s3.entry_tf)
        part = RangeGrid(s3, cfg.regime)
        part.prepare(e.iloc[: i + 1], closed_by(r, s3.regime_tf, cut), closed_by(g, s3.range_tf, cut))
        got = part._evaluate(i)
        assert got[1] == expected[1], f"look-ahead at bar {i}"
        if expected[0] is not None:
            assert got[0].__dict__ == expected[0].__dict__
        mutated = e.copy()
        mutated.iloc[i + 1 :, :4] *= 1.1
        mut = RangeGrid(s3, cfg.regime)
        mut.prepare(mutated, resample(mutated, "1h"), resample(mutated, "15m"))
        assert mut._evaluate(i)[1] == expected[1]


def test_s3_backtest_end_to_end(cfg, s3):
    e = range_series()
    r, g = resample(e, "1h"), resample(e, "15m")
    out = engine.run(cfg, s3, make_strategy(s3, cfg.regime), e, r, range_df=g)
    assert out.trades, out.skip_reasons
    for t in out.trades:
        assert t.stop_price < t.entry_price < t.tp1_price < t.tp_price
        assert t.meta["range_low"] < t.entry_price
        assert t.close_reason in {"stop", "trailing", "take_profit", "regime", "end"}
    assert {"take_profit", "stop", "regime"} & {t.close_reason for t in out.trades}


# ---- registry ----------------------------------------------------------------------------------
def test_registry_and_search_spaces():
    for type_, cls in (("sr_bounce", None), ("indicator_confluence", IndicatorConfluence), ("range", RangeGrid)):
        c = strategy_class(type_)
        assert cls is None or c is cls
        for space in (c.SEARCH_SPACE, c.EXIT_SEARCH_SPACE):
            for key, spec in space.items():
                assert spec[0] in {"float", "int", "cat"}, key
                if spec[0] == "cat":
                    assert len(spec[1]) >= 2
                else:
                    assert spec[1] < spec[2]
    with pytest.raises(ValueError, match="unknown strategy type"):
        strategy_class("nope")
