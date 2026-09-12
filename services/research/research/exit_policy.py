"""Shared exit policy: SL/TP with breakeven, partial TP1, ATR trailing stop and TP ratchet.

THE reference implementation. apps/engine/src/positions/exitPolicy.ts is a line-for-line port and
both must produce identical event streams on tests/fixtures/exit_policy_case_*.json.

Evaluated once per CLOSED candle. Intrabar hits use the bar's high/low with worst-case ordering:
the stop is checked before any take-profit when both are touched in the same bar.
Long-only until futures (M9).
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .config import ExitParams


@dataclass
class Bar:
    high: float
    low: float
    close: float
    atr: float


@dataclass
class Position:
    entry: float
    qty: float
    sl_initial: float
    sl: float
    tp: float
    tp1: float | None
    remaining_qty: float
    highest_high: float
    lowest_low: float
    tp1_done: bool = False
    state: str = "open"  # open | breakeven | trailing | closed
    bars: int = 0
    events: list[dict] = field(default_factory=list)

    @property
    def risk(self) -> float:
        return self.entry - self.sl_initial

    @property
    def mfe_r(self) -> float:
        return (self.highest_high - self.entry) / self.risk

    @property
    def mae_r(self) -> float:
        return (self.entry - self.lowest_low) / self.risk

    def to_dict(self) -> dict:
        return asdict(self)


def open_position(entry: float, qty: float, sl: float, tp: float, params: ExitParams, tp1: float | None = None) -> Position:
    r = entry - sl
    if r <= 0:
        raise ValueError("stop must be below entry for a long")
    if tp <= entry:
        raise ValueError("take-profit must be above entry for a long")
    return Position(
        entry=entry, qty=qty, sl_initial=sl, sl=sl, tp=tp,
        tp1=tp1 if tp1 is not None else entry + params.tp1_r * r,
        remaining_qty=qty, highest_high=entry, lowest_low=entry,
    )


def _round(x: float) -> float:
    return round(x, 8)


def step(pos: Position, bar: Bar, params: ExitParams) -> list[dict]:
    """Advance one closed bar. Mutates pos; returns this bar's events (also appended to pos.events)."""
    if pos.state == "closed":
        return []
    events: list[dict] = []
    pos.bars += 1
    r = pos.risk
    pos.highest_high = max(pos.highest_high, bar.high)
    pos.lowest_low = min(pos.lowest_low, bar.low)

    def emit(kind: str, **kw) -> None:
        if "price" in kw:
            kw["price"] = _round(kw["price"])
        if "qty" in kw:
            kw["qty"] = _round(kw["qty"])
        ev = {"bar": pos.bars, "type": kind, **kw}
        events.append(ev)
        pos.events.append(ev)

    def close(reason: str, price: float) -> list[dict]:
        emit("closed", reason=reason, price=price, qty=pos.remaining_qty)
        pos.remaining_qty = 0.0
        pos.state = "closed"
        return events

    # 1) Hard stop first (worst case).
    if bar.low <= pos.sl:
        return close("stop", pos.sl)

    # 2) Partial take-profit.
    if not pos.tp1_done and pos.tp1 is not None and bar.high >= pos.tp1:
        sell = _round(pos.qty * params.tp1_fraction)
        pos.remaining_qty = _round(pos.remaining_qty - sell)
        pos.tp1_done = True
        emit("tp_partial", price=pos.tp1, qty=sell)
        if pos.remaining_qty <= 0:
            return close("take_profit", pos.tp1)

    # 3) Final take-profit.
    if bar.high >= pos.tp:
        return close("take_profit", pos.tp)

    # 4) Time stop.
    if params.max_bars is not None and pos.bars >= params.max_bars:
        return close("time", bar.close)

    # 5) Breakeven once the close reaches +breakeven_r.
    if pos.state == "open" and bar.close >= pos.entry + params.breakeven_r * r:
        be = pos.entry * (1 + 2 * params.fee_pct / 100)
        if be > pos.sl:
            pos.sl = be
            emit("sl_moved", price=pos.sl, reason="breakeven")
        pos.state = "breakeven"

    # 6) Trailing after TP1 (or after breakeven when there is no TP1).
    if pos.tp1_done or (pos.tp1 is None and pos.state == "breakeven"):
        pos.state = "trailing"
    if pos.state == "trailing":
        new_sl = pos.highest_high - params.trail_atr_k * bar.atr
        if new_sl > pos.sl:
            pos.sl = new_sl
            emit("sl_moved", price=pos.sl, reason="trailing")
        new_tp = pos.highest_high + params.tp_ratchet_atr * bar.atr
        if new_tp > pos.tp:
            pos.tp = new_tp
            emit("tp_moved", price=pos.tp, reason="ratchet")
    return events


def close_manual(pos: Position, price: float, reason: str) -> list[dict]:
    """Close outside the bar loop (regime invalidation, manual, kill)."""
    if pos.state == "closed":
        return []
    ev = {"bar": pos.bars, "type": "closed", "reason": reason, "price": _round(price), "qty": _round(pos.remaining_qty)}
    pos.events.append(ev)
    pos.remaining_qty = 0.0
    pos.state = "closed"
    return [ev]


def realized_r(pos: Position, fee_pct: float) -> tuple[float, float]:
    """(realized_r, fees_in_r) from the event list. Fees are charged on entry and every exit fill."""
    r = pos.risk
    pnl = 0.0
    fees = pos.entry * pos.qty * fee_pct / 100
    for ev in pos.events:
        if ev["type"] in ("tp_partial", "closed"):
            pnl += (ev["price"] - pos.entry) * ev["qty"]
            fees += ev["price"] * ev["qty"] * fee_pct / 100
    per_r = r * pos.qty
    return (pnl - fees) / per_r, fees / per_r
