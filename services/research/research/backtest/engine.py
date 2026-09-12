"""Event-driven backtest: strategy signal -> fill at next open (+slippage) -> exit policy each bar
-> fees on every fill -> regime invalidation -> trade record with the same columns as a closed signal."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from ..config import AppConfig, StrategyInstance
from ..exit_policy import Bar, Position, close_manual, open_position, realized_r, step
from ..strategies.base import SignalDraft, Strategy


@dataclass
class Trade:
    signal_id: str
    ts: pd.Timestamp
    symbol: str
    timeframe: str
    entry_price: float
    stop_price: float
    tp1_price: float
    tp_price: float
    actual_entry: float
    exit_price: float
    outcome: str
    realized_r: float
    realized_pnl: float
    fees: float
    mfe_r: float
    mae_r: float
    bars_held: int
    close_reason: str
    opened_at: pd.Timestamp
    closed_at: pd.Timestamp
    events: list[dict] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


@dataclass
class BacktestOutput:
    trades: list[Trade]
    bars: int
    bars_in_position: int
    skip_reasons: dict[str, int]
    start: pd.Timestamp
    end: pd.Timestamp

    def frame(self) -> pd.DataFrame:
        if not self.trades:
            return pd.DataFrame()
        return pd.DataFrame([{k: v for k, v in t.__dict__.items() if k != "events"} for t in self.trades])


def outcome_of(r: float, breakeven_band: float = 0.05) -> str:
    if r > breakeven_band:
        return "win"
    if r < -breakeven_band:
        return "loss"
    return "breakeven"


def close_reason_of(pos: Position) -> str:
    last = pos.events[-1]
    if last["type"] != "closed":
        return "open"
    if last["reason"] == "stop":
        return "trailing" if pos.sl > pos.sl_initial else "stop"
    return last["reason"]


def run(
    cfg: AppConfig,
    instance: StrategyInstance,
    strategy: Strategy,
    entry_df: pd.DataFrame,
    regime_df: pd.DataFrame,
    risk_amount: float | None = None,
) -> BacktestOutput:
    strategy.prepare(entry_df, regime_df)
    e = strategy.entry
    assert e is not None and strategy.regime is not None
    opens, highs, lows, closes = (e[c].to_numpy() for c in ("open", "high", "low", "close"))
    atrs = e["atr"].to_numpy() if "atr" in e else np.full(len(e), np.nan)
    times = e.index
    regime_idx = strategy.regime_idx
    regime_close = strategy.regime["close"].to_numpy()
    slip = cfg.paper.slippage_pct / 100
    fee_pct = instance.exit.fee_pct
    risk_amount = risk_amount if risk_amount is not None else cfg.paper.starting_balance * cfg.risk.per_trade_pct / 100

    trades: list[Trade] = []
    skips: dict[str, int] = {}
    pos: Position | None = None
    draft: SignalDraft | None = None
    opened_i = 0
    signal_ts: pd.Timestamp | None = None
    bars_in_pos = 0
    n = len(e)

    def finish(i: int, exit_price_hint: float | None = None) -> None:
        nonlocal pos, draft, bars_in_pos
        assert pos is not None and draft is not None and signal_ts is not None
        r, fees_r = realized_r(pos, fee_pct)
        last = pos.events[-1]
        risk_per_unit = pos.risk
        trades.append(
            Trade(
                signal_id=f"{instance.id}:{instance.symbol}:{instance.entry_tf}:{signal_ts.strftime('%Y-%m-%dT%H:%M:%SZ')}",
                ts=signal_ts, symbol=instance.symbol, timeframe=instance.entry_tf,
                entry_price=draft.entry, stop_price=draft.stop, tp1_price=draft.tp1, tp_price=draft.tp,
                actual_entry=pos.entry, exit_price=float(last["price"]),
                outcome=outcome_of(r), realized_r=r, realized_pnl=r * risk_amount, fees=fees_r * risk_amount,
                mfe_r=pos.mfe_r, mae_r=pos.mae_r, bars_held=pos.bars, close_reason=close_reason_of(pos),
                opened_at=times[opened_i], closed_at=times[i], events=list(pos.events),
                meta={**draft.meta, "qty": pos.qty, "risk_per_unit": risk_per_unit},
            )
        )
        pos = None
        draft = None

    for i in range(n):
        if pos is not None:
            bars_in_pos += 1
            # regime invalidation: a new regime bar became usable at the close of bar i-1
            if i > 0 and regime_idx[i] != regime_idx[i - 1] and regime_idx[i] >= 0:
                if strategy.invalidated(draft.invalidation_level, float(regime_close[regime_idx[i]])):
                    close_manual(pos, float(opens[i]), "regime")
                    finish(i)
                    continue
            step(pos, Bar(high=float(highs[i]), low=float(lows[i]), close=float(closes[i]), atr=float(atrs[i])), instance.exit)
            if pos.state == "closed":
                finish(i)
            continue

        if i == n - 1:
            break  # a signal on the last bar cannot be filled
        d, reason = strategy._evaluate(i) if hasattr(strategy, "_evaluate") else (strategy.signal(i), "signal")
        if d is None:
            skips[reason] = skips.get(reason, 0) + 1
            continue
        fill = float(opens[i + 1]) * (1 + slip)
        if fill <= d.stop or fill >= d.tp:
            skips["gap_at_fill"] = skips.get("gap_at_fill", 0) + 1
            continue
        qty = risk_amount / (fill - d.stop)
        pos = open_position(fill, qty, d.stop, d.tp, instance.exit, tp1=d.tp1)
        draft, opened_i, signal_ts = d, i + 1, times[i]

    if pos is not None:  # still open at the end: close at last close for accounting
        close_manual(pos, float(closes[-1]), "end")
        finish(n - 1)

    return BacktestOutput(trades=trades, bars=n, bars_in_position=bars_in_pos, skip_reasons=skips,
                          start=times[0], end=times[-1])
