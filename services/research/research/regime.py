"""Shared regime filter computed on the regime timeframe."""

from __future__ import annotations

import pandas as pd

from . import indicators as ind
from .config import RegimeConfig


def regime_features(df: pd.DataFrame, cfg: RegimeConfig) -> pd.DataFrame:
    out = df.copy()
    out["ema_fast"] = ind.ema(df["close"], cfg.ema_fast)
    out["ema_slow"] = ind.ema(df["close"], cfg.ema_slow)
    out["atr"] = ind.atr(df, cfg.atr_len)
    out["atr_pct"] = out["atr"] / df["close"] * 100
    out["warm"] = pd.Series(range(len(df)), index=df.index) >= max(cfg.ema_slow, cfg.atr_len)
    out["trend_ok"] = (out["ema_fast"] > out["ema_slow"]) & (df["close"] > out["ema_fast"])
    out["vol_ok"] = out["atr_pct"].between(cfg.atr_pct_min, cfg.atr_pct_max)
    out["regime_ok"] = out["warm"] & out["trend_ok"] & out["vol_ok"]
    return out


def regime_reason(row: pd.Series) -> str:
    if not row["warm"]:
        return "warmup"
    if not row["trend_ok"]:
        return "trend"
    if not row["vol_ok"]:
        return "volatility"
    return "ok"
