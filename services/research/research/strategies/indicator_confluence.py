"""S2 — indicator confluence on the entry timeframe (PLAN.md "S2 — Indicator confluence").

Entry (on a closed entry bar): regime OK and, within the current bar or the previous `lookback_bars`
bars, RSI crossed back UP through `rsi_oversold` AND the close touched or went below the lower
Bollinger band; plus the MACD histogram is rising on the current bar (hist[i] > hist[i-1]).
Stop = entry - stop_atr_k x ATR, target = entry + r_mult x risk, TP1 at +1R. The time stop
(PLAN: 24 bars) is the exit policy's `max_bars`, set per instance in config. No invalidation level.
"""

from __future__ import annotations

from typing import ClassVar

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..data import align_regime, minutes_since_daily_open
from ..regime import regime_features, regime_reason
from .base import SearchSpace, SignalDraft, Strategy

DEFAULTS = {
    "rsi_len": 14, "rsi_oversold": 30, "lookback_bars": 3,
    "bb_len": 20, "bb_k": 2.0,
    "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
    "atr_len": 14, "stop_atr_k": 1.5, "r_mult": 2.0,
    "max_risk_pct": 1.5,        # skip if (entry - stop) / entry exceeds this
    "max_fee_r": 0.25,          # skip if round-trip fees would cost more than this many R
}


class IndicatorConfluence(Strategy):
    type = "indicator_confluence"
    SEARCH_SPACE: ClassVar[SearchSpace] = {
        "rsi_oversold": ("float", 25, 40), "lookback_bars": ("int", 1, 6), "bb_k": ("float", 1.5, 2.5),
        "stop_atr_k": ("float", 1.0, 2.5), "r_mult": ("float", 1.5, 3.0), "max_fee_r": ("float", 0.2, 1.0),
    }
    EXIT_SEARCH_SPACE: ClassVar[SearchSpace] = {"trail_atr_k": ("float", 1.0, 4.0), "max_bars": ("int", 12, 48)}
    WALK_FORWARD_GRID: ClassVar[dict[str, list]] = {"rsi_oversold": [30, 35], "stop_atr_k": [1.5, 2.0], "r_mult": [2.0, 3.0]}
    WALK_FORWARD_EXIT_GRID: ClassVar[dict[str, list]] = {"trail_atr_k": [2.0, 3.0]}

    def __init__(self, instance, regime_cfg):
        super().__init__(instance, regime_cfg)
        self.p = {**DEFAULTS, **self.params}

    # ---- preparation -------------------------------------------------------------------------
    def prepare(self, entry_df: pd.DataFrame, regime_df: pd.DataFrame, range_df: pd.DataFrame | None = None) -> None:
        p = self.p
        look = int(p["lookback_bars"])
        e = entry_df.copy()
        e["rsi"] = ind.rsi(e["close"], int(p["rsi_len"]))
        e["atr"] = ind.atr(e, int(p["atr_len"]))
        bb = ind.bollinger(e["close"], int(p["bb_len"]), float(p["bb_k"]))
        e["bb_lower"], e["bb_mid"] = bb["bb_lower"], bb["bb_mid"]
        e["macd_hist"] = ind.macd(e["close"], int(p["macd_fast"]), int(p["macd_slow"]), int(p["macd_signal"]))["macd_hist"]
        os_ = float(p["rsi_oversold"])
        # events on each bar; then "happened within the last look+1 bars" via a backward-looking window
        rsi_cross_up = (e["rsi"].shift(1) < os_) & (e["rsi"] >= os_)
        bb_touch = e["close"] <= e["bb_lower"]
        e["rsi_cross_recent"] = rsi_cross_up.astype(float).rolling(look + 1, min_periods=1).max() > 0
        e["bb_touch_recent"] = bb_touch.astype(float).rolling(look + 1, min_periods=1).max() > 0
        e["macd_rising"] = e["macd_hist"] > e["macd_hist"].shift(1)
        warm_bars = max(int(p["rsi_len"]), int(p["atr_len"]), int(p["bb_len"]), int(p["macd_slow"]) + int(p["macd_signal"]))
        e["warm"] = pd.Series(range(len(e)), index=e.index) >= warm_bars
        self.entry = e

        r = regime_features(regime_df, self.regime_cfg)
        self.regime = r
        self.regime_idx = align_regime(e.index, r.index, self.instance.entry_tf, self.instance.regime_tf)

        self._e_close, self._e_rsi, self._e_atr = e["close"].to_numpy(), e["rsi"].to_numpy(), e["atr"].to_numpy()
        self._e_bb_lower, self._e_hist = e["bb_lower"].to_numpy(), e["macd_hist"].to_numpy()
        self._e_cross, self._e_touch = e["rsi_cross_recent"].to_numpy(), e["bb_touch_recent"].to_numpy()
        self._e_rising, self._e_warm = e["macd_rising"].to_numpy(), e["warm"].to_numpy()
        self._r_ok = r["regime_ok"].to_numpy()

    # ---- signal ------------------------------------------------------------------------------
    def _evaluate(self, i: int) -> tuple[SignalDraft | None, str]:
        p = self.p
        if not self._e_warm[i] or np.isnan(self._e_atr[i]) or np.isnan(self._e_rsi[i]) or np.isnan(self._e_bb_lower[i]):
            return None, "warmup"
        rj = int(self.regime_idx[i])
        if rj < 0:
            return None, "no_regime_bar"
        if not self._r_ok[rj]:
            return None, f"regime_{regime_reason(self.regime.iloc[rj])}"
        ts = self.entry.index[i]
        if minutes_since_daily_open(ts) < self.regime_cfg.no_trade_minutes_after_daily_open:
            return None, "daily_open_window"
        if not self._e_cross[i]:
            return None, "no_rsi_cross"
        if not self._e_touch[i]:
            return None, "no_bb_touch"
        if not self._e_rising[i]:
            return None, "macd_not_rising"

        entry, atr = float(self._e_close[i]), float(self._e_atr[i])
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
        tp = entry + r_mult * risk
        tp1 = entry + self.instance.exit.tp1_r * risk
        rrow = self.regime.iloc[rj]
        draft = SignalDraft(
            entry=entry, stop=float(stop), tp=float(tp), tp1=float(tp1), invalidation_level=None,
            confidence=0.6,
            meta={
                "rsi": round(float(self._e_rsi[i]), 2), "bb_lower": round(float(self._e_bb_lower[i]), 8),
                "macd_hist": round(float(self._e_hist[i]), 8), "atr": round(float(atr), 8),
                "projected_r": round(r_mult, 3), "fee_r": round(float(fee_r), 3),
                "risk_pct": round(float(risk / entry * 100), 3),
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
