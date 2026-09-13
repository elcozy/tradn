"""S4 — dump bounce (PLAN.md "Pattern research findings", day-trading version).

The one thing the hindsight research found that survives out of sample on intraday bars: after a
sharp fall, a volatile coin tends to recover more than it continues, once fees are paid and the stop
is wide enough. Two modes, chosen per instance with `mode`:

- `dump`: the coin's own return over the last `ret_bars` bars is at or below `ret_max_pct` (a 24h
  drop of 5% or more on 15m bars) and ATR is at least `atr_min_pct` of price.
- `crash_bounce`: the coin is at least `dd_max_pct` below its `dd_days`-day high and has already
  bounced `bounce_min_pct` above its `bounce_bars`-bar low.

Entry at the close of the qualifying bar (filled at the next open), stop = entry - stop_atr_k x ATR,
target = entry + r_mult x risk, and the instance's `max_bars` time exit. There is deliberately NO
trend filter: the dump is the regime. The regime frame is still loaded because the engine expects
one, but nothing in it gates the entry.
"""

from __future__ import annotations

from typing import ClassVar

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..config import TIMEFRAME_MS
from ..data import align_regime
from ..regime import regime_features
from .base import SearchSpace, SignalDraft, Strategy

DEFAULTS = {
    "mode": "dump",             # dump | crash_bounce
    "ret_bars": 96,             # dump: return over this many entry bars (96 x 15m = 24h) ...
    "ret_max_pct": -5.0,        # ... must be at or below this
    "atr_len": 14, "atr_min_pct": 2.0,  # ATR as % of price must be at least this (0: off)
    "dd_days": 30, "dd_max_pct": -35.0,  # crash_bounce: close vs rolling high over dd_days ...
    "bounce_bars": 20, "bounce_min_pct": 5.0,  # ... and close vs rolling low over bounce_bars
    "stop_atr_k": 2.0, "r_mult": 2.0,
    "max_risk_pct": 12.0,       # skip if (entry - stop) / entry exceeds this
    "max_fee_r": 0.25,          # skip if round-trip fees would cost more than this many R
}


class DumpBounce(Strategy):
    type = "dump_bounce"
    SEARCH_SPACE: ClassVar[SearchSpace] = {
        "ret_max_pct": ("float", -10.0, -2.0), "atr_min_pct": ("float", 1.0, 3.0),
        "stop_atr_k": ("float", 1.5, 3.0), "r_mult": ("float", 1.5, 3.0),
    }
    # exits: when trailing starts (tp1_r, with tp1_fraction 0 nothing is sold there), how tight it trails, whether the
    # stop moves to breakeven (99 = never), whether the target ratchets, and the time limit
    EXIT_SEARCH_SPACE: ClassVar[SearchSpace] = {
        "tp1_r": ("float", 0.5, 2.0), "trail_atr_k": ("cat", [None, 1.5, 2.5, 4.0]), "breakeven_r": ("cat", [1.0, 99.0]),
        "tp_ratchet_atr": ("cat", [None, 1.0]), "max_bars": ("int", 24, 96),
    }
    WALK_FORWARD_GRID: ClassVar[dict[str, list]] = {"ret_max_pct": [-3.0, -5.0, -8.0], "atr_min_pct": [1.5, 2.0]}
    WALK_FORWARD_EXIT_GRID: ClassVar[dict[str, list]] = {}

    def __init__(self, instance, regime_cfg):
        super().__init__(instance, regime_cfg)
        self.p = {**DEFAULTS, **self.params}
        if self.p["mode"] not in ("dump", "crash_bounce"):
            raise ValueError(f"{instance.id}: mode must be dump or crash_bounce, got {self.p['mode']!r}")

    @classmethod
    def warmup_bars(cls, instance, regime_cfg) -> dict[str, int]:
        p = {**DEFAULTS, **instance.params}
        day = 86_400_000 // TIMEFRAME_MS[instance.entry_tf]
        need = int(p["dd_days"]) * day if p["mode"] == "crash_bounce" else int(p["ret_bars"])
        return {"entry": max(600, need + 100), "regime": regime_cfg.ema_slow + 50, "range": 0}

    # ---- preparation -------------------------------------------------------------------------
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None) -> None:
        p = self.p
        e = entry_df.copy()
        c = e["close"]
        e["atr"] = ind.atr(e, int(p["atr_len"]))
        e["atr_pct"] = e["atr"] / c * 100
        day = 86_400_000 // TIMEFRAME_MS[self.instance.entry_tf]
        if p["mode"] == "dump":
            k = int(p["ret_bars"])
            e["ret"] = c.pct_change(k) * 100
            warm = max(k, int(p["atr_len"]))
        else:
            dd_bars = int(p["dd_days"]) * day
            e["dd"] = (c / e["high"].rolling(dd_bars, min_periods=day).max() - 1) * 100
            e["bounce"] = (c / e["low"].rolling(int(p["bounce_bars"])).min() - 1) * 100
            warm = max(day, int(p["bounce_bars"]), int(p["atr_len"]))
        e["warm"] = pd.Series(range(len(e)), index=e.index) >= warm
        self.entry = e

        r = regime_features(regime_df, self.regime_cfg)  # loaded for the engine's bookkeeping; not a gate
        self.regime = r
        self.regime_idx = align_regime(e.index, r.index, self.instance.entry_tf, self.instance.regime_tf)

        self._close, self._atr, self._atr_pct, self._warm = c.to_numpy(), e["atr"].to_numpy(), e["atr_pct"].to_numpy(), e["warm"].to_numpy()
        self._ret = e["ret"].to_numpy() if "ret" in e else None
        self._dd = e["dd"].to_numpy() if "dd" in e else None
        self._bounce = e["bounce"].to_numpy() if "bounce" in e else None

    # ---- signal ------------------------------------------------------------------------------
    def _evaluate(self, i: int) -> tuple[SignalDraft | None, str]:
        p = self.p
        if not self._warm[i] or np.isnan(self._atr[i]):
            return None, "warmup"
        meta: dict = {}
        if p["mode"] == "dump":
            ret = self._ret[i]
            if np.isnan(ret):
                return None, "warmup"
            if ret > float(p["ret_max_pct"]):
                return None, "no_dump"
            meta["ret_pct"] = round(float(ret), 3)
        else:
            dd, bounce = self._dd[i], self._bounce[i]
            if np.isnan(dd) or np.isnan(bounce):
                return None, "warmup"
            if dd > float(p["dd_max_pct"]):
                return None, "no_crash"
            if bounce < float(p["bounce_min_pct"]):
                return None, "no_bounce"
            meta["dd_pct"], meta["bounce_pct"] = round(float(dd), 3), round(float(bounce), 3)
        if self._atr_pct[i] < float(p["atr_min_pct"]):
            return None, "atr_too_low"

        entry, atr = float(self._close[i]), float(self._atr[i])
        stop = entry - float(p["stop_atr_k"]) * atr
        risk = entry - stop
        if risk <= 0:
            return None, "bad_stop"
        if risk / entry * 100 > float(p["max_risk_pct"]):
            return None, "risk_too_wide"
        fee_r = (2 * self.instance.exit.fee_pct / 100 * entry) / risk
        if fee_r > float(p["max_fee_r"]):
            return None, "fees_vs_risk"
        r_mult = float(p["r_mult"])
        draft = SignalDraft(
            entry=entry, stop=float(stop), tp=float(entry + r_mult * risk), tp1=float(entry + self.instance.exit.tp1_r * risk),
            invalidation_level=None, confidence=0.6,
            meta={
                **meta, "mode": p["mode"], "atr": round(atr, 8), "atr_pct": round(float(self._atr_pct[i]), 3),
                "projected_r": round(r_mult, 3), "fee_r": round(float(fee_r), 3), "risk_pct": round(float(risk / entry * 100), 3),
            },
        )
        return draft, "signal"

    def signal(self, i: int) -> SignalDraft | None:
        return self._evaluate(i)[0]

    def skip_reason(self, i: int) -> str | None:
        draft, reason = self._evaluate(i)
        return None if draft else reason
