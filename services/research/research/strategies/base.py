"""Strategy interface. A strategy prepares indicator columns once, then answers `signal(i)` for an
entry bar using only data available at that bar's close (no look-ahead).

Every strategy takes an entry-timeframe frame and a regime-timeframe frame; a strategy that needs a
third timeframe (S3's range_tf) receives it as the optional `range_df`. Tunable parameters are
declared in `SEARCH_SPACE` / `EXIT_SEARCH_SPACE` (for `research optimize`) and a small grid in
`WALK_FORWARD_GRID` / `WALK_FORWARD_EXIT_GRID` (for `research walkforward`).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import ClassVar

import pandas as pd

from ..config import RegimeConfig, StrategyInstance

# ("float", lo, hi) | ("int", lo, hi) | ("cat", [choices])
SearchSpace = dict[str, tuple]


@dataclass
class SignalDraft:
    entry: float
    stop: float
    tp: float
    tp1: float
    invalidation_level: float | None = None  # regime close below this closes the trade
    confidence: float | None = None
    meta: dict = field(default_factory=dict)

    @property
    def risk(self) -> float:
        return self.entry - self.stop

    @property
    def projected_r(self) -> float:
        return (self.tp - self.entry) / self.risk


class Strategy(ABC):
    type: str = ""
    SEARCH_SPACE: ClassVar[SearchSpace] = {}
    EXIT_SEARCH_SPACE: ClassVar[SearchSpace] = {}
    WALK_FORWARD_GRID: ClassVar[dict[str, list]] = {}
    WALK_FORWARD_EXIT_GRID: ClassVar[dict[str, list]] = {}

    def __init__(self, instance: StrategyInstance, regime_cfg: RegimeConfig):
        self.instance = instance
        self.regime_cfg = regime_cfg
        self.params = dict(instance.params)
        self.entry: pd.DataFrame | None = None
        self.regime: pd.DataFrame | None = None
        self.range_frame: pd.DataFrame | None = None  # only strategies with a range_tf fill this

    @classmethod
    def warmup_bars(cls, instance: StrategyInstance, regime_cfg: RegimeConfig) -> dict[str, int]:
        """Bars to load ahead of the first evaluated entry bar, per frame: 'entry', 'regime', 'range'
        (0 when the strategy has no range frame). Loaders (live, backtest, walk-forward) use this."""
        return {"entry": 600, "regime": regime_cfg.ema_slow + 50, "range": 0}

    @abstractmethod
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None) -> None: ...

    @abstractmethod
    def signal(self, i: int) -> SignalDraft | None: ...

    def skip_reason(self, i: int) -> str | None:
        """Optional: why bar i produced no signal (for logging / dashboard). None when a signal fires."""
        return None

    def invalidated(self, level: float | None, regime_close: float) -> bool:
        return level is not None and regime_close < level


def prepare_strategy(
    strategy: Strategy, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None
) -> None:
    """Call `prepare` with the range frame only when there is one, so two-frame strategies keep their
    two-argument signature."""
    if range_df is None:
        strategy.prepare(entry_df, regime_df)
    else:
        strategy.prepare(entry_df, regime_df, range_df)


def registry() -> dict[str, type[Strategy]]:
    from .dump_bounce import DumpBounce
    from .indicator_confluence import IndicatorConfluence
    from .range_grid import RangeGrid
    from .sr_bounce import SrBounce

    return {cls.type: cls for cls in (SrBounce, IndicatorConfluence, RangeGrid, DumpBounce)}


def strategy_class(type_: str) -> type[Strategy]:
    reg = registry()
    if type_ not in reg:
        raise ValueError(f"unknown strategy type {type_!r}; known: {sorted(reg)}")
    return reg[type_]


def make_strategy(instance: StrategyInstance, regime_cfg: RegimeConfig) -> Strategy:
    return strategy_class(instance.type)(instance, regime_cfg)
