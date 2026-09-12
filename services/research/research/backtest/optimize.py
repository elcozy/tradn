"""Optuna walk-forward: the same rolling train/test windows as walkforward.py, but each train window
runs a TPE study over the strategy's SEARCH_SPACE / EXIT_SEARCH_SPACE instead of a fixed grid.

Objective = train-window sum of R (same ">= 5 trades" guard as the grid). Only the best parameters of
each train window are evaluated on the following test window, so the reported out-of-sample metrics
are never touched by the search. optuna is optional: `uv sync --extra research`.
"""

from __future__ import annotations

import pandas as pd

from ..config import AppConfig, StrategyInstance
from ..strategies.base import SearchSpace, strategy_class
from .metrics import compute_metrics
from .walkforward import evaluate, score_train, slice_frames, windows, with_params


def _optuna():
    try:
        import optuna
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise RuntimeError(
            "optuna is not installed; run `uv sync --extra research` in services/research to enable `research optimize`"
        ) from e
    return optuna


def suggest(trial, space: SearchSpace) -> dict:
    """Draw one value per key from a strategy search space: ("float", lo, hi) | ("int", lo, hi) | ("cat", [choices])."""
    out = {}
    for key, spec in space.items():
        kind = spec[0]
        if kind == "float":
            out[key] = trial.suggest_float(key, float(spec[1]), float(spec[2]))
        elif kind == "int":
            out[key] = trial.suggest_int(key, int(spec[1]), int(spec[2]))
        elif kind == "cat":
            out[key] = trial.suggest_categorical(key, list(spec[1]))
        else:
            raise ValueError(f"{key}: unknown search-space kind {kind!r} (expected float | int | cat)")
    return out


def optimize(
    cfg: AppConfig, instance: StrategyInstance, entry_df: pd.DataFrame, regime_df: pd.DataFrame,
    range_df: pd.DataFrame | None = None, trials: int = 30, train_days: int = 180, test_days: int = 60, seed: int = 0,
) -> dict:
    optuna = _optuna()
    optuna.logging.set_verbosity(optuna.logging.WARNING)
    cls = strategy_class(instance.type)
    space, exit_space = cls.SEARCH_SPACE, cls.EXIT_SEARCH_SPACE
    if not space and not exit_space:
        raise ValueError(f"{instance.type} declares no SEARCH_SPACE / EXIT_SEARCH_SPACE")
    if set(space) & set(exit_space):
        raise ValueError(f"{instance.type}: a key appears in both SEARCH_SPACE and EXIT_SEARCH_SPACE")

    wins = windows(entry_df.index[0], entry_df.index[-1], train_days, test_days)
    test_trades: list[pd.DataFrame] = []
    per_window = []
    for w in wins:
        train = slice_frames(cfg, instance, w.train_start, w.train_end, entry_df, regime_df, range_df)

        def objective(trial, train=train, start=w.train_start) -> float:
            inst = with_params(instance, suggest(trial, space), suggest(trial, exit_space))
            m, _ = evaluate(cfg, inst, train, start, train_days)
            return score_train(m)

        study = optuna.create_study(direction="maximize", sampler=optuna.samplers.TPESampler(seed=seed))
        study.optimize(objective, n_trials=trials)
        best = study.best_trial.params
        params = {k: best[k] for k in space}
        ex = {k: best[k] for k in exit_space}
        test = slice_frames(cfg, instance, w.train_end, w.test_end, entry_df, regime_df, range_df)
        m, df = evaluate(cfg, with_params(instance, params, ex), test, w.train_end, test_days)
        per_window.append({"train": [str(w.train_start.date()), str(w.train_end.date())], "test_end": str(w.test_end.date()),
                           "params": params, "exit": ex, "train_sum_r": round(float(study.best_value), 3), "test": m,
                           "trials": len(study.trials)})
        if not df.empty:
            test_trades.append(df)
    all_test = pd.concat(test_trades) if test_trades else pd.DataFrame()
    total_days = sum(test_days for _ in wins)
    return {"windows": per_window, "oos": compute_metrics(all_test, 0, 0, total_days), "oos_trades": all_test}
