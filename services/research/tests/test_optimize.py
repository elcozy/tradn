"""Optuna walk-forward on synthetic candles (skipped when optuna is not installed)."""

import importlib.util
import sys

import pytest

from research.config import load_config
from research.strategies.base import strategy_class

from .synth import candles, resample
from .test_strategies_m8 import range_series

HAS_OPTUNA = importlib.util.find_spec("optuna") is not None
needs_optuna = pytest.mark.skipif(not HAS_OPTUNA, reason="optuna not installed (uv sync --extra research)")


@pytest.fixture
def cfg(repo_root):
    return load_config(repo_root / "config" / "strategies.yaml")


def _in_bounds(values: dict, space: dict) -> None:
    for k, v in values.items():
        kind = space[k][0]
        if kind == "cat":
            assert v in space[k][1]
        else:
            assert space[k][1] <= v <= space[k][2]
            assert isinstance(v, int) if kind == "int" else True


@needs_optuna
def test_optimize_three_trials_per_window(cfg):
    from research.backtest.optimize import optimize
    from research.backtest.walkforward import windows

    inst = next(s for s in cfg.strategies if s.type == "indicator_confluence")
    e = candles(2000, "15m", seed=31, vol=0.005)
    r = resample(e, "1h")
    res = optimize(cfg, inst, e, r, None, trials=3, train_days=8, test_days=4, seed=1)
    assert set(res) == {"windows", "oos", "oos_trades"}
    assert len(res["windows"]) == len(windows(e.index[0], e.index[-1], 8, 4)) == 3
    cls = strategy_class(inst.type)
    for w in res["windows"]:
        assert set(w) >= {"train", "test_end", "params", "exit", "train_sum_r", "test", "trials"}
        assert w["trials"] == 3
        assert set(w["params"]) == set(cls.SEARCH_SPACE) and set(w["exit"]) == set(cls.EXIT_SEARCH_SPACE)
        _in_bounds(w["params"], cls.SEARCH_SPACE)
        _in_bounds(w["exit"], cls.EXIT_SEARCH_SPACE)
        assert "trades" in w["test"]
    assert "trades" in res["oos"]
    # a fixed seed makes the study reproducible
    again = optimize(cfg, inst, e, r, None, trials=3, train_days=8, test_days=4, seed=1)
    assert [w["params"] for w in again["windows"]] == [w["params"] for w in res["windows"]]


@needs_optuna
def test_optimize_passes_range_frame_for_s3(cfg):
    from research.backtest.optimize import optimize

    inst = next(s for s in cfg.strategies if s.type == "range")
    e = range_series(days=40)
    r, g = resample(e, "1h"), resample(e, "15m")
    res = optimize(cfg, inst, e, r, g, trials=2, train_days=32, test_days=3, seed=0)
    assert len(res["windows"]) == 2  # 32+3 and 35+3 fit in 40 days; a third window would need day 41
    for w in res["windows"]:
        assert "trail_atr_k" in w["exit"] and w["exit"]["trail_atr_k"] in (None, 2.0, 3.0)


@needs_optuna
def test_suggest_rejects_unknown_kind():
    import optuna

    from research.backtest.optimize import suggest

    trial = optuna.create_study().ask()
    with pytest.raises(ValueError, match="unknown search-space kind"):
        suggest(trial, {"x": ("bool", True, False)})


def test_missing_optuna_has_actionable_error(cfg, monkeypatch):
    from research.backtest.optimize import optimize

    monkeypatch.setitem(sys.modules, "optuna", None)  # makes `import optuna` raise ImportError
    inst = cfg.strategies[0]
    e = candles(100, "15m")
    with pytest.raises(RuntimeError, match="uv sync --extra research"):
        optimize(cfg, inst, e, resample(e, "1h"), None, trials=1)
