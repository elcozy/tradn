"""Baselines every strategy must beat out-of-sample: buy-and-hold and random entries with the same exit policy."""

from __future__ import annotations

import numpy as np
import pandas as pd

from ..config import AppConfig, StrategyInstance
from ..strategies.base import SignalDraft, Strategy
from . import engine


def buy_and_hold(entry_df: pd.DataFrame) -> dict:
    c = entry_df["close"]
    ret = c.iloc[-1] / c.iloc[0] - 1
    dd = (c / c.cummax() - 1).min()
    return {"return_pct": round(float(ret) * 100, 2), "max_drawdown_pct": round(float(dd) * 100, 2)}


class RandomEntries(Strategy):
    """Enter at random bars with stop = close - k*ATR and target = entry + 2R. Same exit policy as S1."""

    type = "random"

    def __init__(self, instance, regime_cfg, n_trades: int, seed: int = 0, atr_k: float = 1.5, r_mult: float = 2.0):
        super().__init__(instance, regime_cfg)
        self.n_trades, self.seed, self.atr_k, self.r_mult = n_trades, seed, atr_k, r_mult

    def prepare(self, entry_df, regime_df, range_df=None):
        from .. import indicators as ind
        from ..data import align_regime

        e = entry_df.copy()
        e["atr"] = ind.atr(e, 14)
        self.entry = e
        self.regime = regime_df.copy()
        self.regime_idx = align_regime(e.index, regime_df.index, self.instance.entry_tf, self.instance.regime_tf)
        rng = np.random.default_rng(self.seed)
        # 4x oversample: while a trade is open, other picks are ignored
        self.picks = set(rng.choice(np.arange(20, len(e) - 1), size=min(len(e) - 21, self.n_trades * 4), replace=False).tolist())

    def signal(self, i):
        if i not in self.picks:
            return None
        close, atr = float(self.entry["close"].iloc[i]), float(self.entry["atr"].iloc[i])
        if np.isnan(atr) or atr <= 0:
            return None
        stop = close - self.atr_k * atr
        tp = close + self.r_mult * (close - stop)
        return SignalDraft(entry=close, stop=stop, tp=tp, tp1=close + (close - stop), meta={"baseline": "random"})


def random_baseline(
    cfg: AppConfig, instance: StrategyInstance, entry_df, regime_df, n_trades: int, seeds=(0, 1, 2), range_df=None
) -> dict:
    from .metrics import compute_metrics

    exps, sums = [], []
    for s in seeds:
        strat = RandomEntries(instance, cfg.regime, n_trades=max(n_trades, 1), seed=s)
        out = engine.run(cfg, instance, strat, entry_df, regime_df, range_df=range_df)
        df = out.frame()
        m = compute_metrics(df, out.bars, out.bars_in_position, days=(out.end - out.start).total_seconds() / 86400)
        exps.append(m.get("expectancy_r") or 0.0)
        sums.append(m.get("sum_r") or 0.0)
    return {"expectancy_r_mean": round(float(np.mean(exps)), 4), "sum_r_mean": round(float(np.mean(sums)), 3), "seeds": list(seeds)}
