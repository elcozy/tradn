"""Synthetic candle generators for tests (no network, no database)."""

from __future__ import annotations

import numpy as np
import pandas as pd


def candles(n: int, tf: str, start="2024-01-01", seed=0, drift=0.0, vol=0.002, base=100.0) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    idx = pd.date_range(start, periods=n, freq=tf.replace("m", "min").replace("h", "h"), tz="UTC")
    rets = rng.normal(drift, vol, size=n)
    close = base * np.exp(np.cumsum(rets))
    open_ = np.concatenate([[base], close[:-1]])
    spread = np.abs(rng.normal(0, vol, size=n)) * close
    high = np.maximum(open_, close) + spread
    low = np.minimum(open_, close) - spread
    return pd.DataFrame({"open": open_, "high": high, "low": low, "close": close, "volume": 1.0}, index=idx)


def resample(df: pd.DataFrame, tf: str) -> pd.DataFrame:
    rule = tf.replace("m", "min").replace("h", "h")
    o = df.resample(rule, label="left", closed="left").agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"})
    return o.dropna()
