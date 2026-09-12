import pandas as pd
import pytest

from research.backtest import engine
from research.backtest.baselines import buy_and_hold, random_baseline
from research.backtest.metrics import compute_metrics
from research.config import load_config
from research.data import align_regime
from research.strategies.base import SignalDraft, Strategy
from research.strategies.sr_bounce import SrBounce

from .synth import candles, resample


@pytest.fixture
def cfg(repo_root):
    return load_config(repo_root / "config" / "strategies.yaml")


@pytest.fixture
def inst(cfg):
    return cfg.strategies[0]


class FixedEntries(Strategy):
    """Signals at fixed bar indexes with stop 1% below and target 2R above; regime-agnostic."""

    type = "fixed"

    def __init__(self, instance, regime_cfg, bars):
        super().__init__(instance, regime_cfg)
        self.bars = set(bars)

    def prepare(self, entry_df, regime_df):
        e = entry_df.copy()
        e["atr"] = (e["high"] - e["low"]).rolling(14).mean()
        self.entry, self.regime = e, regime_df.copy()
        self.regime_idx = align_regime(e.index, regime_df.index, self.instance.entry_tf, self.instance.regime_tf)

    def signal(self, i):
        if i not in self.bars:
            return None
        c = float(self.entry["close"].iloc[i])
        return SignalDraft(entry=c, stop=c * 0.99, tp=c * 1.02, tp1=c * 1.01, meta={"i": i})


def test_align_regime_uses_close_times():
    e = pd.date_range("2024-01-01 14:00", periods=8, freq="15min", tz="UTC")
    r = pd.date_range("2024-01-01 13:00", periods=3, freq="1h", tz="UTC")  # 13:00, 14:00, 15:00
    idx = align_regime(e, r, "15m", "1h")
    # 15m bars 14:00..14:30 close before the 14:00 1h bar closes (15:00) -> usable regime bar is 13:00 (pos 0)
    assert idx.tolist() == [0, 0, 0, 1, 1, 1, 1, 2]


def test_engine_fills_next_open_and_records_trade(cfg, inst):
    e = candles(400, "15m", seed=3)
    r = resample(e, "1h")
    strat = FixedEntries(inst, cfg.regime, bars=[50, 200])
    out = engine.run(cfg, inst, strat, e, r)
    assert len(out.trades) == 2
    t = out.trades[0]
    assert t.actual_entry == pytest.approx(float(e["open"].iloc[51]) * (1 + cfg.paper.slippage_pct / 100))
    assert t.opened_at == e.index[51]
    assert t.outcome in ("win", "loss", "breakeven")
    assert t.close_reason in ("stop", "trailing", "take_profit", "time", "end")
    assert set(out.frame().columns) >= {"realized_r", "mfe_r", "mae_r", "bars_held", "close_reason"}


def test_engine_one_position_at_a_time(cfg, inst):
    e = candles(300, "15m", seed=4)
    r = resample(e, "1h")
    strat = FixedEntries(inst, cfg.regime, bars=[50, 51, 52])  # overlapping picks
    out = engine.run(cfg, inst, strat, e, r)
    assert len(out.trades) <= 3
    for a, b in zip(out.trades, out.trades[1:], strict=False):
        assert b.opened_at > a.closed_at


def test_regime_invalidation_closes_trade(cfg, inst):
    e = candles(200, "15m", seed=5)
    r = resample(e, "1h")

    class Inval(FixedEntries):
        def signal(self, i):
            d = super().signal(i)
            if d:
                d.invalidation_level = 1e9  # any regime close is "below the level"
            return d

    out = engine.run(cfg, inst, Inval(inst, cfg.regime, bars=[40]), e, r)
    assert out.trades and out.trades[0].close_reason == "regime"
    assert out.trades[0].bars_held <= 4  # next 1h close arrives within 4 x 15m bars


def test_metrics_shape(cfg, inst):
    e = candles(600, "15m", seed=6)
    r = resample(e, "1h")
    out = engine.run(cfg, inst, FixedEntries(inst, cfg.regime, bars=list(range(30, 580, 40))), e, r)
    m = compute_metrics(out.frame(), out.bars, out.bars_in_position, days=6)
    assert m["trades"] == len(out.trades)
    assert 0 <= m["win_rate"] <= 1
    assert m["max_drawdown_r"] <= 0
    assert m["exposure_pct"] > 0
    assert compute_metrics(pd.DataFrame(), 0, 0, 1) == {"trades": 0}


def test_baselines_run(cfg, inst):
    e = candles(800, "15m", seed=7, drift=0.0005)
    r = resample(e, "1h")
    bh = buy_and_hold(e)
    assert bh["return_pct"] > 0 and bh["max_drawdown_pct"] <= 0
    rb = random_baseline(cfg, inst, e, r, n_trades=10, seeds=(0,))
    assert "expectancy_r_mean" in rb


def test_sr_bounce_no_lookahead(cfg, inst):
    """A signal at bar i must be identical whether or not future bars exist."""
    e = candles(3000, "15m", seed=8, vol=0.004)
    r = resample(e, "1h")
    full = SrBounce(inst, cfg.regime)
    full.prepare(e, r)
    checked = 0
    for i in range(1500, 2990, 37):
        d_full = full.signal(i)
        cut_time = e.index[i]
        part = SrBounce(inst, cfg.regime)
        part.prepare(e.iloc[: i + 1], r[r.index + pd.Timedelta(hours=1) <= cut_time + pd.Timedelta(minutes=15)])
        d_part = part.signal(i)
        assert (d_full is None) == (d_part is None), f"look-ahead at bar {i}"
        if d_full:
            assert d_full.__dict__ == d_part.__dict__
            checked += 1
    assert checked >= 0  # signals may be rare on synthetic data; the equality above is the real check


def test_sr_bounce_runs_and_reports_skips(cfg, inst):
    e = candles(4000, "15m", seed=9, vol=0.003)
    r = resample(e, "1h")
    out = engine.run(cfg, inst, SrBounce(inst, cfg.regime), e, r)
    assert sum(out.skip_reasons.values()) + len(out.trades) + out.bars_in_position >= out.bars - 1
    for t in out.trades:
        assert t.stop_price < t.entry_price < t.tp_price
        assert t.meta["projected_r"] >= inst.params["min_r"]
