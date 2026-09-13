"""Fixed S4 entries, a few exit policies, every configured coin, 2024-01-01 onward: which exit makes the most per trade?"""
import sys
from datetime import datetime, timezone

import pandas as pd

from research.backtest import engine
from research.backtest.metrics import compute_metrics
from research.backtest.runner import instance_for, load_frames
from research.config import load_config
from research.settings import REPO_ROOT
from research.strategies.base import make_strategy

VARIANTS = {
    "barrier (current): no trail, no breakeven": {},
    "breakeven at +1R": {"breakeven_r": 1.0},
    "trail 2.5 ATR from +1R": {"tp1_r": 1.0, "trail_atr_k": 2.5},
    "trail 4 ATR from +1R": {"tp1_r": 1.0, "trail_atr_k": 4.0},
    "trail 2.5 ATR from +0.5R + breakeven": {"tp1_r": 0.5, "trail_atr_k": 2.5, "breakeven_r": 1.0},
    "runner: trail 2.5 ATR from +1R, target ratchets": {"tp1_r": 1.0, "trail_atr_k": 2.5, "tp_ratchet_atr": 1.0},
    "take half at +1R, trail 2.5 ATR on the rest": {"tp1_r": 1.0, "tp1_fraction": 0.5, "trail_atr_k": 2.5},
}
cfg = load_config(REPO_ROOT / "config" / "strategies.yaml")
since = datetime(2024, 1, 1, tzinfo=timezone.utc)
frames = {}
for sym in cfg.symbols:
    inst = instance_for(cfg, "s4_btc_15m", sym)
    e, r, _ = load_frames(cfg, inst, since, None)
    if not e.empty and not r.empty:
        frames[sym] = (inst, e, r)
print(f"{len(frames)} coins loaded", flush=True)
for name, over in VARIANTS.items():
    dfs = []
    for sym, (inst, e, r) in frames.items():
        vi = inst.model_copy(update={"exit": inst.exit.model_copy(update=over)})
        out = engine.run(cfg, vi, make_strategy(vi, cfg.regime), e, r)
        df = out.frame()
        if not df.empty:
            dfs.append(df)
    t = pd.concat(dfs)
    m = compute_metrics(t, 0, 0, 1)
    per_coin = t.groupby("symbol")["realized_r"].mean()
    print(f"{name:48} trades {m['trades']:5d}  win {m['win_rate']:.0%}  exp {m['expectancy_r']:+.3f}R  sum {m['sum_r']:+.1f}R  "
          f"max DD {m['max_drawdown_r']}R  PF {m['profit_factor']}  avg bars {m['avg_bars_held']}  coins+ {(per_coin > 0).mean():.0%}  "
          f"{m['close_reasons']}", flush=True)
