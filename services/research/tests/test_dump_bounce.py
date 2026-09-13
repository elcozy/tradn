"""S4 (dump_bounce) on hand-built candles: both modes fire where they should, skip reasons are named,
nothing looks ahead, the backtester runs it end to end, and one instance can be pointed at another symbol."""

import numpy as np
import pandas as pd
import pytest

from research.backtest import engine
from research.backtest.runner import instance_for
from research.config import load_config
from research.strategies.base import registry, strategy_class
from research.strategies.dump_bounce import DumpBounce

from .synth import candles, resample


@pytest.fixture
def cfg(repo_root):
    return load_config(repo_root / "config" / "strategies.yaml")


@pytest.fixture
def s4(cfg):
    return next(s for s in cfg.strategies if s.id == "s4_btc_15m")


@pytest.fixture
def s4b(cfg):
    return next(s for s in cfg.strategies if s.id == "s4b_btc_15m")


def _set(e: pd.DataFrame, close: np.ndarray, wide: np.ndarray) -> pd.DataFrame:
    """Rewrite a series from a close path; bars flagged `wide` get a 1.2% range each side (high ATR)."""
    e = e.copy()
    e["close"] = close
    e["open"] = np.concatenate([[close[0]], close[:-1]])
    half = np.where(wide, 0.012, 0.0005)
    e["high"] = np.maximum(e["open"], e["close"]) * (1 + half)
    e["low"] = np.minimum(e["open"], e["close"]) * (1 - half)
    return e


def dump_series(n: int = 3000, k: int = 2500, drop: float = 0.08, wide_slide: bool = True) -> tuple[pd.DataFrame, int]:
    """Quiet 15m series; a 24h (96-bar) slide of `drop` ending at bar k with wide bars; then a +10% recovery."""
    e = candles(n, "15m", seed=3, vol=0.0005)
    close = e["close"].to_numpy().copy()
    start = close[k - 96]
    for j in range(96):
        close[k - 95 + j] = start * (1 - drop * (j + 1) / 96)
    for j in range(1, 80):
        close[k + j] = close[k] * (1 + 0.16 * min(j, 40) / 40)  # +16% off the bottom: past a 4 ATR target from mid-slide
    wide = np.zeros(n, dtype=bool)
    wide[k - 95 : k + 1] = wide_slide
    return _set(e, close, wide), k


def crash_series(n: int = 3400, bottom: int = 3000, depth: float = 0.40, bounce: float = 0.06) -> tuple[pd.DataFrame, int]:
    """A 30-day slide of `depth` to bar `bottom`, then a `bounce` over the next 20 bars, then flat."""
    e = candles(n, "15m", seed=4, vol=0.0005)
    close = np.full(n, 100.0)
    for j in range(100, bottom + 1):
        close[j] = 100 * (1 - depth * (j - 100) / (bottom - 100))
    for j in range(1, 21):
        close[bottom + j] = close[bottom] * (1 + bounce * j / 20)
    close[bottom + 21 :] = close[bottom + 20]
    return _set(e, close, np.ones(n, dtype=bool)), bottom + 20  # wide bars throughout: a real ATR for the stop


def test_registered_with_warmup(cfg, s4, s4b):
    assert registry()["dump_bounce"] is DumpBounce and strategy_class("dump_bounce") is DumpBounce
    assert DumpBounce.warmup_bars(s4, cfg.regime)["entry"] >= 96 + 100
    assert DumpBounce.warmup_bars(s4b, cfg.regime)["entry"] >= 30 * 96


def test_dump_fires_after_a_slide(cfg, s4):
    e, k = dump_series()
    strat = DumpBounce(s4, cfg.regime)
    strat.prepare(e, resample(e, "1h"))
    d, reason = strat._evaluate(k)
    assert d is not None, reason
    p = strat.p
    atr = float(strat.entry["atr"].iloc[k])
    assert d.meta["ret_pct"] <= p["ret_max_pct"] and d.meta["atr_pct"] >= p["atr_min_pct"] and d.meta["mode"] == "dump"
    assert d.entry == pytest.approx(float(e["close"].iloc[k]))
    assert d.stop == pytest.approx(d.entry - p["stop_atr_k"] * atr)
    assert d.tp == pytest.approx(d.entry + p["r_mult"] * d.risk)
    assert d.tp1 == pytest.approx(d.entry + s4.exit.tp1_r * d.risk)
    assert d.invalidation_level is None
    assert strat.skip_reason(k) is None and strat.signal(k) is not None


def test_dump_skip_reasons(cfg, s4):
    e, k = dump_series()
    strat = DumpBounce(s4, cfg.regime)
    strat.prepare(e, resample(e, "1h"))
    assert strat.skip_reason(5) == "warmup"
    assert strat.skip_reason(k - 300) == "no_dump"  # quiet stretch before the slide
    small, k2 = dump_series(drop=0.03)
    strat.prepare(small, resample(small, "1h"))
    assert strat.skip_reason(k2) == "no_dump"
    narrow, k3 = dump_series(wide_slide=False)
    strat.prepare(narrow, resample(narrow, "1h"))
    assert strat.skip_reason(k3) == "atr_too_low"


def test_no_look_ahead(cfg, s4):
    e, k = dump_series()
    strat = DumpBounce(s4, cfg.regime)
    strat.prepare(e, resample(e, "1h"))
    before = strat._evaluate(k)[0]
    wrecked = e.copy()
    wrecked.iloc[k + 1 :, :4] *= 0.5
    strat.prepare(wrecked, resample(wrecked, "1h"))
    after = strat._evaluate(k)[0]
    assert before is not None and after is not None
    assert (before.entry, before.stop, before.tp) == (after.entry, after.stop, after.tp)


def test_backtest_end_to_end(cfg, s4):
    e, k = dump_series()
    out = engine.run(cfg, s4, DumpBounce(s4, cfg.regime), e, resample(e, "1h"))
    assert len(out.trades) >= 1
    t = out.trades[0]
    i = e.index.get_loc(t.ts)
    assert k - 60 <= i <= k  # fires the first bar the 24h return is through -5%, i.e. during the slide, not after it
    assert t.actual_entry == pytest.approx(float(e["open"].iloc[i + 1]) * (1 + cfg.paper.slippage_pct / 100))
    assert t.close_reason == "take_profit" and t.outcome == "win" and t.bars_held <= s4.exit.max_bars
    assert t.realized_r == pytest.approx(2.0, abs=0.1)  # pure barrier exit: +2R minus fees, no partial TP1
    assert set(out.skip_reasons) <= {"warmup", "no_dump", "atr_too_low", "risk_too_wide", "fees_vs_risk", "gap_at_fill"}


def test_crash_bounce_mode(cfg, s4b):
    e, k = crash_series()
    strat = DumpBounce(s4b, cfg.regime)
    strat.prepare(e, resample(e, "1h"))
    d, reason = strat._evaluate(k)
    assert d is not None, reason
    assert d.meta["dd_pct"] <= s4b.params["dd_max_pct"] and d.meta["bounce_pct"] >= s4b.params["bounce_min_pct"]
    assert strat.skip_reason(k - 20) == "no_bounce"  # at the bottom, before the bounce
    assert strat.skip_reason(1000) == "no_crash"  # only a third of the way down
    bad = s4b.model_copy(update={"params": {**s4b.params, "mode": "sideways"}})
    with pytest.raises(ValueError):
        DumpBounce(bad, cfg.regime)


def test_instance_for_other_symbol(cfg):
    inst = instance_for(cfg, "s4_btc_15m", "SOLUSDT")
    assert inst.symbol == "SOLUSDT" and inst.id == "s4_btc_15m@SOLUSDT" and inst.type == "dump_bounce"
    assert inst.params == instance_for(cfg, "s4_btc_15m").params  # a copy, same parameters
    assert instance_for(cfg, "s4_btc_15m", None).id == "s4_btc_15m"
    with pytest.raises(ValueError):
        instance_for(cfg, "s4_btc_15m", "NOPEUSDT")
    with pytest.raises(ValueError):
        instance_for(cfg, "nope", None)
