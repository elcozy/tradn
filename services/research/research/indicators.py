"""Indicator helpers on OHLCV DataFrames (index = open_time UTC; float open/high/low/close/volume).

pandas/numpy only, so the maths is explicit and easy to port to TypeScript.
Wilder smoothing (ewm alpha=1/n) for RSI, ATR and ADX matches TradingView/Binance charts.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n).mean()


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0).fillna(0)
    down = (-delta.clip(upper=0)).fillna(0)
    avg_up = up.ewm(alpha=1 / n, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / n, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100).where(avg_up.ne(0) | avg_down.ne(0), 50.0)


def true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["close"].shift(1)
    return pd.concat(
        [df["high"] - df["low"], (df["high"] - prev_close).abs(), (df["low"] - prev_close).abs()], axis=1
    ).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return true_range(df).ewm(alpha=1 / n, adjust=False).mean()


def bollinger(close: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    mid = sma(close, n)
    sd = close.rolling(n).std(ddof=0)
    return pd.DataFrame(
        {"bb_mid": mid, "bb_upper": mid + k * sd, "bb_lower": mid - k * sd, "bb_width": (2 * k * sd) / mid}
    )


def macd(close: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    return pd.DataFrame({"macd": line, "macd_signal": sig, "macd_hist": line - sig})


def adx(df: pd.DataFrame, n: int = 14) -> pd.Series:
    up = df["high"].diff()
    down = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=df.index)
    atr_n = true_range(df).ewm(alpha=1 / n, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_n
    minus_di = 100 * minus_dm.ewm(alpha=1 / n, adjust=False).mean() / atr_n
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean()


def swing_points(df: pd.DataFrame, width: int = 5) -> pd.DataFrame:
    """Swing low/high flags: the bar's low/high is the extreme of `width` bars on each side.

    A swing at bar i is only KNOWN at bar i + width (confirmed_idx). Callers must not use a swing
    before its confirmation bar has closed. Ties resolve to the earliest bar.
    """
    low, high = df["low"], df["high"]
    win = 2 * width + 1
    roll_min = low.rolling(win, center=True).min()
    roll_max = high.rolling(win, center=True).max()
    is_low = (low == roll_min) & roll_min.notna()
    is_high = (high == roll_max) & roll_max.notna()
    # de-duplicate flat ties: keep the first bar of a run of equal extremes
    is_low &= ~(is_low.shift(1, fill_value=False) & (low == low.shift(1)))
    is_high &= ~(is_high.shift(1, fill_value=False) & (high == high.shift(1)))
    idx = np.arange(len(df))
    return pd.DataFrame(
        {"swing_low": is_low, "swing_high": is_high, "confirmed_idx": idx + width}, index=df.index
    )


def cluster_levels(prices: list[float], tolerance_pct: float = 0.25) -> list[tuple[float, int]]:
    """Merge nearby prices into levels. Returns [(level_price, touches)] sorted ascending."""
    if not prices:
        return []
    ps = sorted(prices)
    clusters: list[list[float]] = [[ps[0]]]
    for p in ps[1:]:
        ref = float(np.mean(clusters[-1]))
        if abs(p - ref) / ref * 100 <= tolerance_pct:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    return [(float(np.mean(c)), len(c)) for c in clusters]
