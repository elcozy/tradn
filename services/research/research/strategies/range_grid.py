"""S3 — range / grid: entries on the entry timeframe at the bottom of a range measured on `range_tf`,
gated by a RANGING regime on `regime_tf` (PLAN.md "S3 — Range / grid").

Regime (regime_tf): ADX < adx_max AND Bollinger width in the bottom bb_width_pct % of its trailing
bb_width_lookback_days distribution; the shared volatility filter and daily-open window still apply,
the trend filter does not. Range (range_tf): highest high / lowest low of the last range_bars CLOSED
bars, height >= min_range_atr x ATR(range_tf). Entry: entry-tf close in the bottom entry_zone_pct %
of the range and bullish; one entry per touch (re-armed once a close leaves the zone). Stop below the
range low, TP1 at the midpoint, TP at tp_zone_pct % of the height.

PLAN says "exit if 1h ADX rises above 25 (range breaking)". The exit policy only knows price-based
regime invalidation, so the proxy used here is `invalidation_level = range_low`: a regime-tf close
below the range low closes the remainder. `ladder` is documented but only `ladder: 1` is implemented.
"""

from __future__ import annotations

from typing import ClassVar

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..config import TIMEFRAME_MS
from ..data import align_regime, minutes_since_daily_open
from ..regime import regime_features
from .base import SearchSpace, SignalDraft, Strategy

DEFAULTS = {
    "adx_len": 14, "adx_max": 20, "bb_len": 20, "bb_k": 2.0, "bb_width_pct": 40, "bb_width_lookback_days": 30,
    "range_bars": 48, "atr_len": 14, "min_range_atr": 3.0,
    "entry_zone_pct": 20, "tp_zone_pct": 80, "stop_atr_k": 0.5, "ladder": 1,
    "max_risk_pct": 1.5, "min_r": 1.0,
    "max_fee_r": 0.5,  # looser than S1/S2: mean-reversion stops are tight, so fees are a bigger share of R
}


def ranging_reason(row: pd.Series) -> str:
    if not row["warm"]:
        return "warmup"
    if not row["vol_ok"]:
        return "volatility"
    if not row["adx_ok"]:
        return "trend"
    if not row["bbw_ok"]:
        return "bb_width"
    return "ok"


class RangeGrid(Strategy):
    type = "range"
    SEARCH_SPACE: ClassVar[SearchSpace] = {
        "adx_max": ("float", 15, 30), "bb_width_pct": ("float", 20, 60), "range_bars": ("int", 24, 96),
        "min_range_atr": ("float", 2.0, 5.0), "entry_zone_pct": ("float", 10, 30), "tp_zone_pct": ("float", 50, 90),
        "stop_atr_k": ("float", 0.25, 1.0),
    }
    EXIT_SEARCH_SPACE: ClassVar[SearchSpace] = {"trail_atr_k": ("cat", [None, 2.0, 3.0])}
    WALK_FORWARD_GRID: ClassVar[dict[str, list]] = {"adx_max": [20, 25], "entry_zone_pct": [20, 30], "stop_atr_k": [0.5, 1.0]}
    WALK_FORWARD_EXIT_GRID: ClassVar[dict[str, list]] = {}

    def __init__(self, instance, regime_cfg):
        super().__init__(instance, regime_cfg)
        self.p = {**DEFAULTS, **self.params}
        if instance.range_tf is None:
            raise ValueError(f"{instance.id}: range strategy needs range_tf")
        if int(self.p["ladder"]) != 1:
            raise ValueError(f"{instance.id}: ladder > 1 is not implemented (set ladder: 1)")

    @classmethod
    def warmup_bars(cls, instance, regime_cfg) -> dict[str, int]:
        p = {**DEFAULTS, **instance.params}
        dist_bars = int(p["bb_width_lookback_days"]) * 86_400_000 // TIMEFRAME_MS[instance.regime_tf]
        return {"entry": 600, "regime": max(regime_cfg.ema_slow, dist_bars) + 50, "range": int(p["range_bars"]) + 100}

    # ---- preparation -------------------------------------------------------------------------
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None) -> None:
        if range_df is None:
            raise ValueError(f"{self.instance.id}: range strategy needs the range_tf frame")
        p = self.p
        e = entry_df.copy()
        e["atr"] = ind.atr(e, int(p["atr_len"]))  # entry-tf ATR for the exit policy's trailing/ratchet
        e["bullish"] = e["close"] > e["open"]
        self.entry = e

        # regime: ranging = low ADX and squeezed Bollinger width, plus the shared volatility filter
        r = regime_features(regime_df, self.regime_cfg)
        r["adx"] = ind.adx(regime_df, int(p["adx_len"]))
        r["bb_width"] = ind.bollinger(regime_df["close"], int(p["bb_len"]), float(p["bb_k"]))["bb_width"]
        window = f"{int(p['bb_width_lookback_days'])}D"  # trailing, time-based: only bars at or before each row
        r["bb_width_rank"] = r["bb_width"].rolling(window, min_periods=int(p["bb_len"])).rank(pct=True)
        r["adx_ok"] = r["adx"] < float(p["adx_max"])
        r["bbw_ok"] = r["bb_width_rank"] <= float(p["bb_width_pct"]) / 100
        # the trend EMAs are not part of this regime, so warmup is the ATR/ADX/Bollinger windows only
        warm_bars = max(self.regime_cfg.atr_len, int(p["adx_len"]), int(p["bb_len"]))
        r["warm"] = (pd.Series(range(len(r)), index=r.index) >= warm_bars) & r["bb_width_rank"].notna()
        r["regime_ok"] = r["warm"] & r["vol_ok"] & r["adx_ok"] & r["bbw_ok"]
        self.regime = r
        self.regime_idx = align_regime(e.index, r.index, self.instance.entry_tf, self.instance.regime_tf)

        # range: rolling extremes of closed range_tf bars, mapped to entry bars by close time
        g = range_df.copy()
        n_bars = int(p["range_bars"])
        g["atr"] = ind.atr(g, int(p["atr_len"]))
        g["range_high"] = g["high"].rolling(n_bars).max()
        g["range_low"] = g["low"].rolling(n_bars).min()
        self.range_frame = g
        self.range_idx = align_regime(e.index, g.index, self.instance.entry_tf, self.instance.range_tf)

        self._e_open, self._e_close = e["open"].to_numpy(), e["close"].to_numpy()
        self._e_bull = e["bullish"].to_numpy()
        self._r_ok = r["regime_ok"].to_numpy()
        self._g_high, self._g_low, self._g_atr = g["range_high"].to_numpy(), g["range_low"].to_numpy(), g["atr"].to_numpy()
        self._armed, self._in_zone = self._touch_state()

    def _range_at(self, i: int) -> tuple[float, float, float] | None:
        """(range_low, range_high, range_atr) known at entry bar i, or None when not available."""
        rk = int(self.range_idx[i])
        if rk < 0:
            return None
        lo, hi, atr = self._g_low[rk], self._g_high[rk], self._g_atr[rk]
        if np.isnan(lo) or np.isnan(hi) or np.isnan(atr):
            return None
        return float(lo), float(hi), float(atr)

    def _touch_state(self) -> tuple[np.ndarray, np.ndarray]:
        """Forward pass over the entry bars (past data only): armed[i] is True when no entry has been
        taken since price last left the entry zone; in_zone[i] when the close is inside the zone."""
        n = len(self._e_close)
        zone_pct = float(self.p["entry_zone_pct"]) / 100
        armed, in_zone = np.ones(n, dtype=bool), np.zeros(n, dtype=bool)
        state = True
        for i in range(n):
            rng = self._range_at(i)
            if rng is None:
                state = True
                armed[i] = state
                continue
            lo, hi, _ = rng
            zone_top = lo + zone_pct * (hi - lo)
            close = self._e_close[i]
            in_zone[i] = close <= zone_top
            if not in_zone[i]:
                state = True
            armed[i] = state
            if in_zone[i] and self._e_bull[i] and state:
                state = False  # this bar is the (only) entry candidate for this touch
        return armed, in_zone

    # ---- signal ------------------------------------------------------------------------------
    def _evaluate(self, i: int) -> tuple[SignalDraft | None, str]:
        p = self.p
        rj = int(self.regime_idx[i])
        if rj < 0:
            return None, "no_regime_bar"
        rrow = self.regime.iloc[rj]
        if not self._r_ok[rj]:
            return None, f"regime_{ranging_reason(rrow)}"
        ts = self.entry.index[i]
        if minutes_since_daily_open(ts) < self.regime_cfg.no_trade_minutes_after_daily_open:
            return None, "daily_open_window"
        rng = self._range_at(i)
        if rng is None:
            return None, "warmup"
        lo, hi, r_atr = rng
        height = hi - lo
        if height < float(p["min_range_atr"]) * r_atr:
            return None, "range_too_small"
        if not self._in_zone[i]:
            return None, "not_in_zone"
        if not self._e_bull[i]:
            return None, "not_bullish"
        if not self._armed[i]:
            return None, "touch_used"

        entry = float(self._e_close[i])
        stop = lo - float(p["stop_atr_k"]) * r_atr
        risk = entry - stop
        if risk <= 0:
            return None, "bad_stop"
        if risk / entry * 100 > float(p["max_risk_pct"]):
            return None, "risk_too_wide"
        fee_r = (2 * self.instance.exit.fee_pct / 100 * entry) / risk
        if fee_r > float(p["max_fee_r"]):
            return None, "fees_vs_risk"
        tp1 = lo + 0.5 * height
        tp = lo + float(p["tp_zone_pct"]) / 100 * height
        if tp1 <= entry or tp <= tp1:
            return None, "bad_target"
        r_mult = (tp - entry) / risk
        if r_mult < float(p["min_r"]):
            return None, "r_too_low"
        draft = SignalDraft(
            entry=entry, stop=float(stop), tp=float(tp), tp1=float(tp1), invalidation_level=float(lo),
            confidence=0.6,
            meta={
                "range_low": round(lo, 8), "range_high": round(hi, 8), "range_height": round(height, 8),
                "range_atr": round(r_atr, 8), "entry_zone_top": round(lo + float(p["entry_zone_pct"]) / 100 * height, 8),
                "range_tf": self.instance.range_tf, "range_bars": int(p["range_bars"]), "ladder": int(p["ladder"]),
                "projected_r": round(float(r_mult), 3), "fee_r": round(float(fee_r), 3),
                "risk_pct": round(float(risk / entry * 100), 3),
                "regime_adx": round(float(rrow["adx"]), 2), "regime_bb_width_rank": round(float(rrow["bb_width_rank"]), 3),
                "regime_atr_pct": round(float(rrow["atr_pct"]), 3),
            },
        )
        return draft, "signal"

    def signal(self, i: int) -> SignalDraft | None:
        return self._evaluate(i)[0]

    def skip_reason(self, i: int) -> str | None:
        draft, reason = self._evaluate(i)
        return None if draft else reason
