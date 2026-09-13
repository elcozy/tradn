"""Loader and validator for config/strategies.yaml. Mirrors apps/engine/src/config.ts."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

Timeframe = Literal["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]
Mode = Literal["shadow", "paper", "testnet", "live"]

TIMEFRAME_MS: dict[str, int] = {
    "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
    "1h": 3_600_000, "2h": 7_200_000, "4h": 14_400_000, "1d": 86_400_000,
}


class ExitParams(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tp1_r: float = 1.0
    tp1_fraction: float = Field(0.5, ge=0, le=1)
    breakeven_r: float = 1.0
    trail_atr_k: float | None = 2.0  # None: never trail (mean-reversion strategies)
    tp_ratchet_atr: float | None = 1.0  # None: target never ratchets
    fee_pct: float = 0.1
    max_bars: int | None = None


class StrategyInstance(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    type: str
    symbol: str
    entry_tf: Timeframe
    regime_tf: Timeframe
    range_tf: Timeframe | None = None
    enabled: bool = True
    params: dict = Field(default_factory=dict)
    exit: ExitParams = Field(default_factory=ExitParams)

    @model_validator(mode="after")
    def _regime_slower_than_entry(self) -> StrategyInstance:
        if TIMEFRAME_MS[self.regime_tf] <= TIMEFRAME_MS[self.entry_tf]:
            raise ValueError(f"{self.id}: regime_tf must be slower than entry_tf")
        return self


class RegimeConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ema_fast: int = 50
    ema_slow: int = 200
    atr_len: int = 14
    atr_pct_min: float = 0.3
    atr_pct_max: float = 3.0
    no_trade_minutes_after_daily_open: int = 15


class RiskConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    per_trade_pct: float = 1.0
    daily_loss_pct: float = 3.0
    max_open: int = 3
    max_per_symbol: int = 1
    consecutive_loss_cooldown: int = 3
    cooldown_minutes: int = 120
    notional_cap_pct: float = 25.0


class PaperConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    starting_balance: float = 10_000
    slippage_pct: float = 0.05
    fee_pct: float = 0.1


class UniverseConfig(BaseModel):
    """Liquidity-filtered symbol universe maintained by `research universe` (see research/universe.py)."""

    model_config = ConfigDict(extra="forbid")
    pinned: list[str] = Field(default_factory=list)  # always kept, whatever their liquidity
    min_volume_usd: float = 10_000_000  # average daily quote volume over lookback_days
    max_spread_pct: float = 0.05  # best bid/ask spread at refresh time
    lookback_days: int = 30
    max_symbols: int = 50  # pinned + auto-added, sorted by volume
    exclude: list[str] = Field(default_factory=list)  # base assets never traded (stablecoins, wrapped coins, ...)
    template: str = "s1_btc_15m"  # instance copied for every auto-added symbol


class AppConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Mode = "shadow"
    symbols: list[str]
    chart_timeframes: list[Timeframe] = Field(default_factory=list)
    chart_lookback_days: int = 30
    strategies: list[StrategyInstance]
    regime: RegimeConfig = Field(default_factory=RegimeConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    paper: PaperConfig = Field(default_factory=PaperConfig)
    universe: UniverseConfig | None = None

    @model_validator(mode="after")
    def _consistent(self) -> AppConfig:
        ids = [s.id for s in self.strategies]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate strategy ids")
        for s in self.strategies:
            if s.symbol not in self.symbols:
                raise ValueError(f"{s.id}: symbol {s.symbol} not in symbols list")
        if self.universe is not None:
            missing = [s for s in self.universe.pinned if s not in self.symbols]
            if missing:
                raise ValueError(f"universe.pinned symbols not in symbols list: {missing}")
            if self.universe.template not in ids:
                raise ValueError(f"universe.template {self.universe.template!r} is not a strategy id")
        return self

    @property
    def enabled_strategies(self) -> list[StrategyInstance]:
        return [s for s in self.strategies if s.enabled]

    @property
    def strategy_timeframes(self) -> list[str]:
        """Union of every timeframe any strategy needs, fastest first."""
        tfs = {tf for s in self.strategies for tf in (s.entry_tf, s.regime_tf, s.range_tf) if tf}
        return sorted(tfs, key=lambda t: TIMEFRAME_MS[t])

    @property
    def timeframes(self) -> list[str]:
        """Strategy timeframes plus chart-only ones, fastest first (what ingest and the engine stream)."""
        return sorted(set(self.strategy_timeframes) | set(self.chart_timeframes), key=lambda t: TIMEFRAME_MS[t])


def load_config(path: Path | str) -> AppConfig:
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return AppConfig.model_validate(raw)
