"""Rolling walk-forward: optimise a small grid on a train window, evaluate on the following test window."""

from __future__ import annotations

import itertools
from dataclasses import dataclass

import pandas as pd

from ..config import AppConfig, StrategyInstance
from ..strategies.base import make_strategy
from . import engine
from .metrics import compute_metrics


@dataclass
class Window:
    train_start: pd.Timestamp
    train_end: pd.Timestamp
    test_end: pd.Timestamp


def windows(start: pd.Timestamp, end: pd.Timestamp, train_days: int, test_days: int) -> list[Window]:
    out = []
    t = start
    while t + pd.Timedelta(days=train_days + test_days) <= end:
        out.append(Window(t, t + pd.Timedelta(days=train_days), t + pd.Timedelta(days=train_days + test_days)))
        t += pd.Timedelta(days=test_days)
    return out


def _with_params(instance: StrategyInstance, params: dict, exit_over: dict) -> StrategyInstance:
    return instance.model_copy(update={"params": {**instance.params, **params}, "exit": instance.exit.model_copy(update=exit_over)})


def _slice(df: pd.DataFrame, a: pd.Timestamp, b: pd.Timestamp, warmup_bars: int) -> pd.DataFrame:
    i = df.index.searchsorted(a)
    return df.iloc[max(0, i - warmup_bars) : df.index.searchsorted(b)]


def walk_forward(
    cfg: AppConfig, instance: StrategyInstance, entry_df: pd.DataFrame, regime_df: pd.DataFrame,
    grid: dict[str, list], exit_grid: dict[str, list] | None = None, train_days: int = 180, test_days: int = 60,
) -> dict:
    exit_grid = exit_grid or {}
    keys, ekeys = list(grid), list(exit_grid)
    combos = [
        (dict(zip(keys, v)), dict(zip(ekeys, ev)))
        for v in itertools.product(*grid.values())
        for ev in (itertools.product(*exit_grid.values()) if ekeys else [()])
    ]
    wins = windows(entry_df.index[0], entry_df.index[-1], train_days, test_days)
    test_trades: list[pd.DataFrame] = []
    per_window = []
    warm_e, warm_r = 300, cfg.regime.ema_slow + 50
    for w in wins:
        best, best_score = None, -1e9
        e_train, r_train = _slice(entry_df, w.train_start, w.train_end, warm_e), _slice(regime_df, w.train_start, w.train_end, warm_r)
        for params, ex in combos:
            inst = _with_params(instance, params, ex)
            out = engine.run(cfg, inst, make_strategy(inst, cfg.regime), e_train, r_train)
            df = out.frame()
            df = df[df["ts"] >= w.train_start] if not df.empty else df
            m = compute_metrics(df, out.bars, out.bars_in_position, train_days)
            score = (m.get("sum_r") or 0.0) if m["trades"] >= 5 else -1e9 + m["trades"]
            if score > best_score:
                best, best_score = (params, ex), score
        params, ex = best
        inst = _with_params(instance, params, ex)
        e_test, r_test = _slice(entry_df, w.train_end, w.test_end, warm_e), _slice(regime_df, w.train_end, w.test_end, warm_r)
        out = engine.run(cfg, inst, make_strategy(inst, cfg.regime), e_test, r_test)
        df = out.frame()
        df = df[df["ts"] >= w.train_end] if not df.empty else df
        m = compute_metrics(df, out.bars, out.bars_in_position, test_days)
        per_window.append({"train": [str(w.train_start.date()), str(w.train_end.date())], "test_end": str(w.test_end.date()),
                           "params": params, "exit": ex, "train_sum_r": round(best_score, 3), "test": m})
        if not df.empty:
            test_trades.append(df)
    all_test = pd.concat(test_trades) if test_trades else pd.DataFrame()
    total_days = sum(test_days for _ in wins)
    return {"windows": per_window, "oos": compute_metrics(all_test, 0, 0, total_days), "oos_trades": all_test}
