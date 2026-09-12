"""S1 — support/resistance bounce on the entry timeframe, levels from regime-timeframe swings.

Entry (on a closed entry bar): regime OK, the bar's low touched a support level (within touch_pct),
the bar closed bullish above the level, the lower wick is at least wick_min_pct of the range, and
RSI is below rsi_max. Stop below the level (with an ATR buffer), target at the next resistance.
"""

from __future__ import annotations

from typing import ClassVar

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..config import TIMEFRAME_MS
from ..data import align_regime, minutes_since_daily_open
from ..regime import regime_features, regime_reason
from .base import SearchSpace, SignalDraft, Strategy

DEFAULTS = {
    "swing_width": 5, "level_tolerance_pct": 0.25, "level_min_touches": 2, "level_lookback_days": 30, "level_break_pct": 0.5,
    "touch_pct": 0.3, "wick_min_pct": 50, "rsi_len": 14, "rsi_max": 45, "atr_len": 14,
    "stop_below_level_pct": 0.25, "stop_atr_buffer": 0.1, "max_risk_pct": 1.5, "min_r": 1.5,
    "max_fee_r": 0.25,          # skip if round-trip fees would cost more than this many R
    "invalidation_pct": 0.0,    # regime close this % below the level closes the trade (0 = at the level)
}


class SrBounce(Strategy):
    type = "sr_bounce"
    SEARCH_SPACE: ClassVar[SearchSpace] = {
        "touch_pct": ("float", 0.15, 0.5), "wick_min_pct": ("float", 30, 70), "rsi_max": ("float", 35, 55),
        "stop_below_level_pct": ("float", 0.1, 1.0), "min_r": ("float", 1.0, 3.0), "max_fee_r": ("float", 0.2, 1.0),
        "invalidation_pct": ("float", 0.0, 1.0),
    }
    EXIT_SEARCH_SPACE: ClassVar[SearchSpace] = {"trail_atr_k": ("float", 1.0, 4.0)}
    WALK_FORWARD_GRID: ClassVar[dict[str, list]] = {
        "min_r": [1.5, 2.0], "max_fee_r": [0.4, 1.0], "stop_below_level_pct": [0.25, 0.75], "invalidation_pct": [0.0, 0.5],
    }
    WALK_FORWARD_EXIT_GRID: ClassVar[dict[str, list]] = {"trail_atr_k": [2.0, 3.0]}

    def __init__(self, instance, regime_cfg):
        super().__init__(instance, regime_cfg)
        self.p = {**DEFAULTS, **self.params}
        self._level_cache: dict[int, tuple[list[tuple[float, int]], list[tuple[float, int]]]] = {}

    @classmethod
    def warmup_bars(cls, instance, regime_cfg) -> dict[str, int]:
        days = int(instance.params.get("level_lookback_days", DEFAULTS["level_lookback_days"]))
        lookback = days * 86_400_000 // TIMEFRAME_MS[instance.regime_tf]
        return {"entry": 600, "regime": regime_cfg.ema_slow + lookback + 50, "range": 0}

    # ---- preparation -------------------------------------------------------------------------
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None) -> None:
        p = self.p
        e = entry_df.copy()
        e["rsi"] = ind.rsi(e["close"], int(p["rsi_len"]))
        e["atr"] = ind.atr(e, int(p["atr_len"]))
        rng = (e["high"] - e["low"]).replace(0, np.nan)
        e["wick_pct"] = (np.minimum(e["open"], e["close"]) - e["low"]) / rng * 100
        e["bullish"] = e["close"] > e["open"]
        e["warm"] = pd.Series(range(len(e)), index=e.index) >= max(int(p["rsi_len"]), int(p["atr_len"]))
        self.entry = e

        r = regime_features(regime_df, self.regime_cfg)
        sw = ind.swing_points(regime_df, int(p["swing_width"]))
        r["swing_low"], r["swing_high"], r["confirmed_idx"] = sw["swing_low"], sw["swing_high"], sw["confirmed_idx"]
        self.regime = r
        self.regime_idx = align_regime(e.index, r.index, self.instance.entry_tf, self.instance.regime_tf)
        self._level_cache.clear()

        # numpy views for the hot loop
        self._e_open, self._e_high = e["open"].to_numpy(), e["high"].to_numpy()
        self._e_low, self._e_close = e["low"].to_numpy(), e["close"].to_numpy()
        self._e_rsi, self._e_atr = e["rsi"].to_numpy(), e["atr"].to_numpy()
        self._e_wick, self._e_bull = e["wick_pct"].to_numpy(), e["bullish"].to_numpy()
        self._e_warm = e["warm"].to_numpy()
        self._r_low, self._r_high, self._r_close = r["low"].to_numpy(), r["high"].to_numpy(), r["close"].to_numpy()
        self._r_ok = r["regime_ok"].to_numpy()
        self._r_swing_low, self._r_swing_high = r["swing_low"].to_numpy(), r["swing_high"].to_numpy()
        self._r_confirmed = r["confirmed_idx"].to_numpy()
        self._r_time_ms = r.index.asi8 // 1_000_000

    # ---- levels ------------------------------------------------------------------------------
    def levels_at(self, rj: int) -> tuple[list[tuple[float, int]], list[tuple[float, int]]]:
        """(supports, resistances) as [(price, touches)] known at regime bar rj (inclusive)."""
        if rj in self._level_cache:
            return self._level_cache[rj]
        p = self.p
        lookback_ms = int(p["level_lookback_days"]) * 86_400_000
        t_min = self._r_time_ms[rj] - lookback_ms
        start = int(np.searchsorted(self._r_time_ms, t_min, side="left"))
        idx = np.arange(start, rj + 1)
        confirmed = self._r_confirmed[idx] <= rj
        lows = self._r_low[idx][self._r_swing_low[idx] & confirmed]
        highs = self._r_high[idx][self._r_swing_high[idx] & confirmed]
        win_low, win_high, win_close = self._r_low[idx], self._r_high[idx], self._r_close[idx]
        tol = float(p["level_tolerance_pct"]) / 100
        brk = float(p["level_break_pct"]) / 100

        supports: list[tuple[float, int]] = []
        for price, _ in ind.cluster_levels(lows.tolist(), float(p["level_tolerance_pct"])):
            touches = int(np.sum(np.abs(win_low - price) / price <= tol))
            if touches < int(p["level_min_touches"]):
                continue
            # broken if a regime close went well below it after the last touch
            touch_pos = np.nonzero(np.abs(win_low - price) / price <= tol)[0]
            after = win_close[touch_pos[-1] + 1 :] if len(touch_pos) else win_close
            if len(after) and after.min() < price * (1 - brk):
                continue
            supports.append((price, touches))
        resistances: list[tuple[float, int]] = []
        for price, _ in ind.cluster_levels(highs.tolist(), float(p["level_tolerance_pct"])):
            touches = int(np.sum(np.abs(win_high - price) / price <= tol))
            touch_pos = np.nonzero(np.abs(win_high - price) / price <= tol)[0]
            after = win_close[touch_pos[-1] + 1 :] if len(touch_pos) else win_close
            if len(after) and after.max() > price * (1 + brk):
                continue
            resistances.append((price, touches))
        out = (supports, resistances)
        self._level_cache[rj] = out
        return out

    # ---- signal ------------------------------------------------------------------------------
    def _evaluate(self, i: int) -> tuple[SignalDraft | None, str]:
        p = self.p
        if not self._e_warm[i] or np.isnan(self._e_atr[i]) or np.isnan(self._e_rsi[i]):
            return None, "warmup"
        rj = int(self.regime_idx[i])
        if rj < 0:
            return None, "no_regime_bar"
        if not self._r_ok[rj]:
            return None, f"regime_{regime_reason(self.regime.iloc[rj])}"
        ts = self.entry.index[i]
        if minutes_since_daily_open(ts) < self.regime_cfg.no_trade_minutes_after_daily_open:
            return None, "daily_open_window"
        if not self._e_bull[i]:
            return None, "not_bullish"
        if np.isnan(self._e_wick[i]) or self._e_wick[i] < float(p["wick_min_pct"]):
            return None, "wick"
        if self._e_rsi[i] >= float(p["rsi_max"]):
            return None, "rsi"

        low, close, atr = self._e_low[i], self._e_close[i], self._e_atr[i]
        supports, resistances = self.levels_at(rj)
        tol = float(p["touch_pct"]) / 100
        candidates = [(abs(low - lvl) / lvl, lvl, n) for lvl, n in supports if abs(low - lvl) / lvl <= tol and close > lvl]
        if not candidates:
            return None, "no_level_touch"
        _, level, touches = min(candidates)

        stop = min(level * (1 - float(p["stop_below_level_pct"]) / 100), low - float(p["stop_atr_buffer"]) * atr)
        entry = close
        risk = entry - stop
        if risk <= 0:
            return None, "bad_stop"
        if risk / entry * 100 > float(p["max_risk_pct"]):
            return None, "risk_too_wide"
        fee_r = (2 * self.instance.exit.fee_pct / 100 * entry) / risk
        if fee_r > float(p["max_fee_r"]):
            return None, "fees_vs_risk"
        above = [lvl for lvl, _ in resistances if lvl > entry]
        if not above:
            return None, "no_resistance"
        tp = min(above)
        r_mult = (tp - entry) / risk
        if r_mult < float(p["min_r"]):
            return None, "r_too_low"
        tp1 = entry + self.instance.exit.tp1_r * risk
        rrow = self.regime.iloc[rj]
        draft = SignalDraft(
            entry=float(entry), stop=float(stop), tp=float(tp), tp1=float(tp1),
            invalidation_level=float(level) * (1 - float(p["invalidation_pct"]) / 100),
            confidence=min(1.0, 0.5 + 0.1 * touches),
            meta={
                "level": round(float(level), 8), "touches": touches, "rsi": round(float(self._e_rsi[i]), 2),
                "atr": round(float(atr), 8), "wick_pct": round(float(self._e_wick[i]), 1),
                "next_resistance": round(float(tp), 8), "projected_r": round(float(r_mult), 3),
                "fee_r": round(float(fee_r), 3), "risk_pct": round(float(risk / entry * 100), 3),
                "regime_ema_fast": round(float(rrow["ema_fast"]), 2), "regime_ema_slow": round(float(rrow["ema_slow"]), 2),
                "regime_atr_pct": round(float(rrow["atr_pct"]), 3),
            },
        )
        return draft, "signal"

    def signal(self, i: int) -> SignalDraft | None:
        return self._evaluate(i)[0]

    def skip_reason(self, i: int) -> str | None:
        draft, reason = self._evaluate(i)
        return None if draft else reason
