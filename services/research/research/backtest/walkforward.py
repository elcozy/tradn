"""Rolling walk-forward: optimise a small grid on a train window, evaluate on the following test window.

`windows`, `slice_frames`, `with_params` and `score_train` are shared with optimize.py (optuna variant).
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass

import pandas as pd

from ..config import AppConfig, StrategyInstance
from ..strategies.base import make_strategy, strategy_class
from . import engine
from .metrics import compute_metrics

MIN_TRAIN_TRADES = 5  # a train window with fewer trades cannot be trusted; rank it below every real score


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


def with_params(instance: StrategyInstance, params: dict, exit_over: dict) -> StrategyInstance:
    return instance.model_copy(update={"params": {**instance.params, **params}, "exit": instance.exit.model_copy(update=exit_over)})


def _slice(df: pd.DataFrame, a: pd.Timestamp, b: pd.Timestamp, warmup_bars: int) -> pd.DataFrame:
    i = df.index.searchsorted(a)
    return df.iloc[max(0, i - warmup_bars) : df.index.searchsorted(b)]


def slice_frames(
    cfg: AppConfig, instance: StrategyInstance, a: pd.Timestamp, b: pd.Timestamp,
    entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None]:
    """[a, b) of every frame with each frame's own warmup ahead of `a`."""
    warm = strategy_class(instance.type).warmup_bars(instance, cfg.regime)
    g = _slice(range_df, a, b, warm["range"]) if range_df is not None else None
    return _slice(entry_df, a, b, warm["entry"]), _slice(regime_df, a, b, warm["regime"]), g


def evaluate(
    cfg: AppConfig, inst: StrategyInstance, frames: tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None],
    start: pd.Timestamp, days: int,
) -> tuple[dict, pd.DataFrame]:
    """Backtest `inst` on the frames, keep trades signalled at/after `start` (the warmup is excluded)."""
    e, r, g = frames
    out = engine.run(cfg, inst, make_strategy(inst, cfg.regime), e, r, range_df=g)
    df = out.frame()
    df = df[df["ts"] >= start] if not df.empty else df
    return compute_metrics(df, out.bars, out.bars_in_position, days), df


def score_train(metrics: dict) -> float:
    return (metrics.get("sum_r") or 0.0) if metrics["trades"] >= MIN_TRAIN_TRADES else -1e9 + metrics["trades"]


def walk_forward(
    cfg: AppConfig, instance: StrategyInstance, entry_df: pd.DataFrame, regime_df: pd.DataFrame,
    grid: dict[str, list], exit_grid: dict[str, list] | None = None, train_days: int = 180, test_days: int = 60,
    range_df: pd.DataFrame | None = None,
) -> dict:
    exit_grid = exit_grid or {}
    keys, ekeys = list(grid), list(exit_grid)
    combos = [
        (dict(zip(keys, v, strict=False)), dict(zip(ekeys, ev, strict=False)))
        for v in itertools.product(*grid.values())
        for ev in (itertools.product(*exit_grid.values()) if ekeys else [()])
    ]
    wins = windows(entry_df.index[0], entry_df.index[-1], train_days, test_days)
    test_trades: list[pd.DataFrame] = []
    per_window = []
    for w in wins:
        best, best_score = None, -1e9
        train = slice_frames(cfg, instance, w.train_start, w.train_end, entry_df, regime_df, range_df)
        for params, ex in combos:
            m, _ = evaluate(cfg, with_params(instance, params, ex), train, w.train_start, train_days)
            score = score_train(m)
            if score > best_score:
                best, best_score = (params, ex), score
        params, ex = best
        test = slice_frames(cfg, instance, w.train_end, w.test_end, entry_df, regime_df, range_df)
        m, df = evaluate(cfg, with_params(instance, params, ex), test, w.train_end, test_days)
        per_window.append({"train": [str(w.train_start.date()), str(w.train_end.date())], "test_end": str(w.test_end.date()),
                           "params": params, "exit": ex, "train_sum_r": round(best_score, 3), "test": m})
        if not df.empty:
            test_trades.append(df)
    all_test = pd.concat(test_trades) if test_trades else pd.DataFrame()
    total_days = sum(test_days for _ in wins)
    return {"windows": per_window, "oos": compute_metrics(all_test, 0, 0, total_days), "oos_trades": all_test}
