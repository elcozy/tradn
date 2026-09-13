"""Per-bar feature snapshot, using only information available when the bar closed.

Every column is a rolling/lagged computation ending at the bar itself, plus slower-timeframe context
aligned by close time (align_regime) and the BTC context for altcoins. `research explain` joins these
to the hindsight labels (research/labels.py) to find which conditions preceded good trades.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import indicators as ind
from .config import TIMEFRAME_MS
from .data import align_regime

BARS_PER_DAY = {tf: 86_400_000 // ms for tf, ms in TIMEFRAME_MS.items()}

# feature -> how to bucket it in the report: "q" quantile bins, "cat" categorical as-is
FEATURES: dict[str, str] = {
    "rsi": "q", "ret_4": "q", "ret_16": "q", "ret_96": "q", "ema20_rel": "q", "ema50_rel": "q", "ema200_rel": "q",
    "ema_stack": "cat", "atr_pct": "q", "bb_pos": "q", "bb_width_pctile": "q", "vol_ratio": "q",
    "wick_lower_pct": "q", "wick_upper_pct": "q", "body_pct": "q", "bullish": "cat",
    "dd_30d": "q", "up_from_low_30d": "q", "dist_low_20": "q", "dist_high_20": "q", "consec_down": "cat", "consec_up": "cat",
    "hour": "cat", "dow": "cat",
    "trend_1h": "cat", "rsi_1h": "q", "trend_4h": "cat", "ret_1d_5": "q", "above_ema20_1d": "cat",
    "btc_trend_1h": "cat", "btc_ret_24h": "q",
}


def _consecutive(cond: np.ndarray, cap: int = 5) -> np.ndarray:
    out = np.zeros(len(cond), dtype=np.int64)
    run = 0
    for i, v in enumerate(cond):
        run = run + 1 if v else 0
        out[i] = min(run, cap)
    return out


def _slow_context(entry: pd.DataFrame, entry_tf: str, slow: pd.DataFrame, slow_tf: str, cols: dict[str, pd.Series]) -> dict[str, np.ndarray]:
    """Align columns computed on a slower frame onto the entry index without look-ahead."""
    idx = align_regime(entry.index, slow.index, entry_tf, slow_tf)
    out = {}
    for name, s in cols.items():
        v = s.to_numpy(dtype=float)
        a = np.full(len(entry), np.nan)
        ok = idx >= 0
        a[ok] = v[idx[ok]]
        out[name] = a
    return out


def features(
    entry: pd.DataFrame, entry_tf: str, h1: pd.DataFrame | None = None, h4: pd.DataFrame | None = None,
    d1: pd.DataFrame | None = None, btc_h1: pd.DataFrame | None = None,
) -> pd.DataFrame:
    c, h, lo, o, v = entry["close"], entry["high"], entry["low"], entry["open"], entry["volume"]
    day = BARS_PER_DAY[entry_tf]
    f = pd.DataFrame(index=entry.index)
    f["rsi"] = ind.rsi(c, 14)
    for k in (4, 16, 96):
        f[f"ret_{k}"] = c.pct_change(k) * 100
    e20, e50, e200 = ind.ema(c, 20), ind.ema(c, 50), ind.ema(c, 200)
    f["ema20_rel"] = (c / e20 - 1) * 100
    f["ema50_rel"] = (c / e50 - 1) * 100
    f["ema200_rel"] = (c / e200 - 1) * 100
    f["ema_stack"] = np.select([(e20 > e50) & (e50 > e200), (e20 < e50) & (e50 < e200)], [1, -1], 0)
    f["atr_pct"] = ind.atr(entry, 14) / c * 100
    bb = ind.bollinger(c, 20, 2.0)
    f["bb_pos"] = (c - bb["bb_lower"]) / (bb["bb_upper"] - bb["bb_lower"]).replace(0, np.nan)
    f["bb_width_pctile"] = bb["bb_width"].rolling(30 * day, min_periods=5 * day).rank(pct=True)
    f["vol_ratio"] = v / v.rolling(20).mean().replace(0, np.nan)
    rng = (h - lo).replace(0, np.nan)
    f["wick_lower_pct"] = (np.minimum(o, c) - lo) / rng * 100
    f["wick_upper_pct"] = (h - np.maximum(o, c)) / rng * 100
    f["body_pct"] = (c - o).abs() / rng * 100
    f["bullish"] = (c > o).astype(int)
    f["dd_30d"] = (c / h.rolling(30 * day, min_periods=day).max() - 1) * 100
    f["up_from_low_30d"] = (c / lo.rolling(30 * day, min_periods=day).min() - 1) * 100
    f["dist_low_20"] = (c / lo.rolling(20).min() - 1) * 100
    f["dist_high_20"] = (h.rolling(20).max() / c - 1) * 100
    down = (c < c.shift(1)).to_numpy()
    f["consec_down"] = _consecutive(down)
    f["consec_up"] = _consecutive((c > c.shift(1)).to_numpy())
    f["hour"] = entry.index.hour
    f["dow"] = entry.index.dayofweek

    if h1 is not None and len(h1):
        e50h, e200h = ind.ema(h1["close"], 50), ind.ema(h1["close"], 200)
        trend = ((e50h > e200h) & (h1["close"] > e50h)).astype(float)
        f = f.assign(**_slow_context(entry, entry_tf, h1, "1h", {"trend_1h": trend, "rsi_1h": ind.rsi(h1["close"], 14)}))
    if h4 is not None and len(h4):
        e50, e200 = ind.ema(h4["close"], 50), ind.ema(h4["close"], 200)
        f = f.assign(**_slow_context(entry, entry_tf, h4, "4h", {"trend_4h": (e50 > e200).astype(float)}))
    if d1 is not None and len(d1):
        f = f.assign(**_slow_context(entry, entry_tf, d1, "1d", {
            "ret_1d_5": d1["close"].pct_change(5) * 100,
            "above_ema20_1d": (d1["close"] > ind.ema(d1["close"], 20)).astype(float),
        }))
    if btc_h1 is not None and len(btc_h1):
        e50b, e200b = ind.ema(btc_h1["close"], 50), ind.ema(btc_h1["close"], 200)
        f = f.assign(**_slow_context(entry, entry_tf, btc_h1, "1h", {
            "btc_trend_1h": ((e50b > e200b) & (btc_h1["close"] > e50b)).astype(float),
            "btc_ret_24h": btc_h1["close"].pct_change(24) * 100,
        }))
    return f
