"""Strategy interface. A strategy prepares indicator columns once, then answers `signal(i)` for an
entry bar using only data available at that bar's close (no look-ahead)."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import pandas as pd

from ..config import RegimeConfig, StrategyInstance


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

    def __init__(self, instance: StrategyInstance, regime_cfg: RegimeConfig):
        self.instance = instance
        self.regime_cfg = regime_cfg
        self.params = dict(instance.params)
        self.entry: pd.DataFrame | None = None
        self.regime: pd.DataFrame | None = None

    @abstractmethod
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame) -> None: ...

    @abstractmethod
    def signal(self, i: int) -> SignalDraft | None: ...

    def skip_reason(self, i: int) -> str | None:
        """Optional: why bar i produced no signal (for logging / dashboard). None when a signal fires."""
        return None

    def invalidated(self, level: float | None, regime_close: float) -> bool:
        return level is not None and regime_close < level


def make_strategy(instance: StrategyInstance, regime_cfg: RegimeConfig) -> Strategy:
    from .sr_bounce import SrBounce

    registry: dict[str, type[Strategy]] = {SrBounce.type: SrBounce}
    if instance.type not in registry:
        raise ValueError(f"unknown strategy type {instance.type!r}; known: {sorted(registry)}")
    return registry[instance.type](instance, regime_cfg)
