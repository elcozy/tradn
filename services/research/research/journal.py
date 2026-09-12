"""Signal journal writes (the projection half; the engine writes the outcome half)."""

from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import text

from . import db
from .contracts import Signal

INSERT = text(
    "INSERT INTO signals (id, ts, strategy_id, strategy_type, symbol, timeframe, side, entry_type, entry_price, "
    "stop_price, tp1_price, tp_price, confidence, meta) "
    "VALUES (:id, :ts, :strategy_id, :strategy_type, :symbol, :timeframe, :side, :entry_type, :entry_price, "
    ":stop_price, :tp1_price, :tp_price, :confidence, :meta) "
    "ON CONFLICT (id) DO NOTHING"
)


def signal_row(sig: Signal) -> dict:
    return {
        "id": sig.id, "ts": datetime.fromisoformat(sig.ts.replace("Z", "+00:00")) if isinstance(sig.ts, str) else sig.ts,
        "strategy_id": sig.strategy_id, "strategy_type": sig.strategy_type, "symbol": sig.symbol,
        "timeframe": sig.timeframe.value if hasattr(sig.timeframe, "value") else sig.timeframe,
        "side": sig.side.value if hasattr(sig.side, "value") else sig.side,
        "entry_type": sig.entry.type.value if hasattr(sig.entry.type, "value") else sig.entry.type,
        "entry_price": sig.entry.price, "stop_price": sig.stop_price, "tp1_price": sig.tp1_price, "tp_price": sig.tp_price,
        "confidence": sig.confidence, "meta": json.dumps(sig.meta or {}),
    }


def write_signal(sig: Signal) -> bool:
    """Insert the projection row. Returns False if the id already existed (replay)."""
    with db.engine().begin() as conn:
        res = conn.execute(INSERT, signal_row(sig))
    return res.rowcount == 1
