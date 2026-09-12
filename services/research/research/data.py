"""Alignment of a slower (regime) timeframe onto a faster (entry) timeframe without look-ahead."""

from __future__ import annotations

import numpy as np
import pandas as pd

from .config import TIMEFRAME_MS


def align_regime(entry_index: pd.DatetimeIndex, regime_index: pd.DatetimeIndex, entry_tf: str, regime_tf: str) -> np.ndarray:
    """For each entry bar, the positional index of the latest regime bar that had CLOSED by the time
    the entry bar closed; -1 when none. Uses close times, so a 1h bar opened at 14:00 is only usable
    from the 15m bar opened at 14:45 (which closes at 15:00) onwards.
    """
    entry_close = entry_index.asi8 // 1_000_000 + TIMEFRAME_MS[entry_tf]
    regime_close = regime_index.asi8 // 1_000_000 + TIMEFRAME_MS[regime_tf]
    pos = np.searchsorted(regime_close, entry_close, side="right") - 1
    return pos.astype(np.int64)


def minutes_since_daily_open(ts: pd.Timestamp) -> int:
    return ts.hour * 60 + ts.minute
