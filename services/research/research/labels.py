"""Hindsight labels: for every bar, what a trade opened at the NEXT open would have done.

Triple barrier, the same rules the exit policy and the backtester use: ATR-sized stop and target,
worst-case ordering when a bar touches both (stop first), a time limit that exits at the close, fees
on both fills and slippage on the entry. The result is the ground truth for `research explain`:
which bars were good buys (or good sells, with side="short") and by how much, in R.

Everything here uses future bars on purpose. Features (research/features.py) must not.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import indicators as ind

OUTCOME_TARGET, OUTCOME_STOP, OUTCOME_TIME = "target", "stop", "time"


@dataclass(frozen=True)
class LabelParams:
    side: str = "long"  # long | short
    atr_len: int = 14
    stop_atr: float = 1.0
    target_atr: float = 2.0
    max_bars: int = 24
    fee_pct: float = 0.1  # per fill
    slippage_pct: float = 0.05  # on the entry

    @property
    def tag(self) -> str:
        return f"{self.side}_s{self.stop_atr:g}_t{self.target_atr:g}_h{self.max_bars}"


def label(df: pd.DataFrame, p: LabelParams = LabelParams()) -> pd.DataFrame:
    """One row per bar i (indexed like df): the trade entered at open[i+1].

    Columns: entry, stop, target, outcome, exit_price, bars_held, gross_r, fee_r, realized_r, mfe_r, mae_r.
    Bars whose horizon runs past the end of the data, or with no ATR yet, are dropped.
    """
    n = len(df)
    o, h, lo, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    atr = ind.atr(df, p.atr_len).to_numpy(dtype=float)
    long = p.side == "long"
    sign = 1.0 if long else -1.0

    # entry at the next open with slippage against us
    entry = np.full(n, np.nan)
    entry[:-1] = o[1:] * (1 + sign * p.slippage_pct / 100)
    stop = entry - sign * p.stop_atr * atr
    target = entry + sign * p.target_atr * atr
    risk = np.abs(entry - stop)

    outcome = np.full(n, "", dtype=object)
    exit_price = np.full(n, np.nan)
    bars = np.zeros(n, dtype=np.int64)
    best = entry.copy()  # running extreme in our favour
    worst = entry.copy()  # running extreme against us
    decided = np.zeros(n, dtype=bool)

    def shifted(a: np.ndarray, k: int) -> np.ndarray:
        out = np.full(n, np.nan)
        out[: n - k] = a[k:]
        return out

    for k in range(1, p.max_bars + 1):
        hk, lk, ck = shifted(h, k), shifted(lo, k), shifted(c, k)
        live = ~decided & ~np.isnan(hk)
        if long:
            best[live] = np.maximum(best[live], hk[live])
            worst[live] = np.minimum(worst[live], lk[live])
            hit_stop = live & (lk <= stop)
            hit_tgt = live & (hk >= target)
        else:
            best[live] = np.minimum(best[live], lk[live])
            worst[live] = np.maximum(worst[live], hk[live])
            hit_stop = live & (hk >= stop)
            hit_tgt = live & (lk <= target)
        # worst case: a bar touching both barriers counts as a stop
        s = hit_stop
        t = hit_tgt & ~hit_stop
        outcome[s], exit_price[s], bars[s] = OUTCOME_STOP, stop[s], k
        outcome[t], exit_price[t], bars[t] = OUTCOME_TARGET, target[t], k
        decided |= s | t
        if k == p.max_bars:
            tm = live & ~decided
            outcome[tm], exit_price[tm], bars[tm] = OUTCOME_TIME, ck[tm], k
            decided |= tm

    gross_r = sign * (exit_price - entry) / risk
    fee_r = (p.fee_pct / 100) * (entry + exit_price) / risk
    out = pd.DataFrame(
        {
            "entry": entry, "stop": stop, "target": target, "outcome": outcome, "exit_price": exit_price, "bars_held": bars,
            "gross_r": gross_r, "fee_r": fee_r, "realized_r": gross_r - fee_r,
            "mfe_r": sign * (best - entry) / risk, "mae_r": sign * (entry - worst) / risk,
        },
        index=df.index,
    )
    return out[decided & ~np.isnan(atr)]
