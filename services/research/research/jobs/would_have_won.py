"""Nightly "would-have-won" job: for every signal the risk manager REJECTED, replay the shared exit
policy on the candles that followed and record how the trade would have ended.

`replay` is pure (signal row + candles in, result dict out) and mirrors backtest/engine.py: fill at the
open of the first entry candle after the signal's candle (+ slippage), then `exit_policy.step` per
closed bar with ATR(14, Wilder) from the entry candles, and regime invalidation when a new regime bar
closes below the signal's invalidation level. `run` is the database wrapper that upserts into
`would_have_won` (infra/migrations/002_paper_and_m8.sql).
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
from sqlalchemy import text

from .. import db
from .. import indicators as ind
from ..backtest.engine import close_reason_of, outcome_of
from ..config import TIMEFRAME_MS, AppConfig, ExitParams, load_config
from ..exit_policy import Bar, Position, close_manual, open_position, realized_r, step

ATR_LEN = 14
ENTRY_WARMUP_BARS = 100  # candles loaded ahead of the signal so ATR(14) is warm at the fill


def _tf_ms(index: pd.DatetimeIndex, fallback: str | None = None) -> int:
    """Bar length in ms from the index spacing (smallest positive gap), else from a timeframe name."""
    if len(index) > 1:
        gaps = np.diff(index.asi8 // 1_000_000)
        gaps = gaps[gaps > 0]
        if len(gaps):
            return int(gaps.min())
    if fallback:
        return TIMEFRAME_MS[fallback]
    raise ValueError("cannot infer the timeframe of a frame with fewer than two bars")


def _utc(ts) -> pd.Timestamp:
    t = pd.Timestamp(ts)
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def _result(outcome: str, pos: Position | None = None, exit_params: ExitParams | None = None, closed_at=None) -> dict:
    if pos is None or pos.state != "closed":
        return {"outcome": outcome, "realized_r": None, "exit_price": None, "close_reason": outcome,
                "bars_held": pos.bars if pos else 0, "closed_at": None}
    assert exit_params is not None
    r, _ = realized_r(pos, exit_params.fee_pct)
    return {"outcome": outcome_of(r), "realized_r": float(r), "exit_price": float(pos.events[-1]["price"]),
            "close_reason": close_reason_of(pos), "bars_held": pos.bars, "closed_at": closed_at}


def replay(
    signal_row: dict,
    entry_candles: pd.DataFrame,
    regime_candles: pd.DataFrame | None,
    exit_params: ExitParams,
    slippage_pct: float,
    invalidation_level: float | None,
    max_bars: int = 500,
) -> dict:
    """Replay one signal. Returns {outcome, realized_r, exit_price, close_reason, bars_held, closed_at};
    outcome is win | loss | breakeven | open (candles ran out) | gap_at_fill (fill beyond stop/tp)."""
    ts = _utc(signal_row["ts"])  # the signal candle's CLOSE time == open time of the fill candle
    e = entry_candles.sort_index()
    fill_i = int(e.index.searchsorted(ts, side="left"))
    if fill_i >= len(e):
        return _result("open")
    stop, tp = float(signal_row["stop_price"]), float(signal_row["tp_price"])
    tp1 = float(signal_row["tp1_price"]) if signal_row.get("tp1_price") is not None else None
    fill = float(e["open"].iloc[fill_i]) * (1 + slippage_pct / 100)
    if fill <= stop or fill >= tp:
        return _result("gap_at_fill")

    opens, highs, lows, closes = (e[c].to_numpy() for c in ("open", "high", "low", "close"))
    atrs = ind.atr(e, ATR_LEN).to_numpy()
    regime_idx = regime_close = None
    if invalidation_level is not None and regime_candles is not None and len(regime_candles):
        r = regime_candles.sort_index()
        e_close = e.index.asi8 // 1_000_000 + _tf_ms(e.index, signal_row.get("timeframe"))
        r_close = r.index.asi8 // 1_000_000 + _tf_ms(r.index)
        regime_idx = np.searchsorted(r_close, e_close, side="right") - 1
        regime_close = r["close"].to_numpy()

    pos = open_position(fill, 1.0, stop, tp, exit_params, tp1=tp1)
    for j in range(fill_i, min(len(e), fill_i + max_bars)):
        if regime_idx is not None:  # same rule as backtest/engine.py: act at the open after the regime bar closed
            new_regime_bar = j > 1 and regime_idx[j - 1] != regime_idx[j - 2] and regime_idx[j - 1] >= 0
            if new_regime_bar and float(regime_close[regime_idx[j - 1]]) < invalidation_level:
                close_manual(pos, float(opens[j]), "regime")
                return _result("closed", pos, exit_params, e.index[j])
        step(pos, Bar(high=float(highs[j]), low=float(lows[j]), close=float(closes[j]), atr=float(atrs[j])), exit_params)
        if pos.state == "closed":
            return _result("closed", pos, exit_params, e.index[j])
    return _result("open", pos)


# ---- database wrapper ----------------------------------------------------------------------------

UPSERT = text(
    "INSERT INTO would_have_won (signal_id, outcome, realized_r, exit_price, close_reason, bars_held, closed_at, computed_at) "
    "VALUES (:signal_id, :outcome, :realized_r, :exit_price, :close_reason, :bars_held, :closed_at, now()) "
    "ON CONFLICT (signal_id) DO UPDATE SET outcome=EXCLUDED.outcome, realized_r=EXCLUDED.realized_r, "
    "exit_price=EXCLUDED.exit_price, close_reason=EXCLUDED.close_reason, bars_held=EXCLUDED.bars_held, "
    "closed_at=EXCLUDED.closed_at, computed_at=now()"
)


def pending_signals(since: datetime | None) -> list[dict]:
    """Rejected signals with no would_have_won row yet, or whose row is still 'open'."""
    clauses = ["s.outcome = 'rejected'", "(w.signal_id IS NULL OR w.outcome = 'open')"]
    params: dict = {}
    if since is not None:
        clauses.append("s.ts >= :since")
        params["since"] = since
    sql = (
        "SELECT s.id, s.ts, s.strategy_id, s.strategy_type, s.symbol, s.timeframe, s.entry_price, s.stop_price, "
        "s.tp1_price, s.tp_price, s.meta FROM signals s LEFT JOIN would_have_won w ON w.signal_id = s.id WHERE "
        + " AND ".join(clauses) + " ORDER BY s.ts"
    )
    with db.engine().connect() as conn:
        rows = [dict(r) for r in conn.execute(text(sql), params).mappings()]
    for row in rows:
        if isinstance(row.get("meta"), str):
            row["meta"] = json.loads(row["meta"])
    return rows


def run(since: datetime | None = None, cfg: AppConfig | None = None, max_bars: int = 500) -> int:
    """Replay every pending rejected signal and upsert the result. Returns the number of rows written."""
    if cfg is None:
        from ..settings import settings

        cfg = load_config(settings.strategy_config_path)
    instances = {s.id: s for s in cfg.strategies}
    written = 0
    for row in pending_signals(since):
        inst = instances.get(row["strategy_id"])
        exit_params = inst.exit if inst else ExitParams()  # instance gone from config: policy defaults
        entry_tf = row["timeframe"]
        ts = _utc(row["ts"])
        tf_ms = TIMEFRAME_MS[entry_tf]
        entry = db.load_candles(
            row["symbol"], entry_tf, since=ts - timedelta(milliseconds=tf_ms * ENTRY_WARMUP_BARS),
            until=ts + timedelta(milliseconds=tf_ms * (max_bars + 1)),
        )
        level = (row.get("meta") or {}).get("invalidation_level")
        regime = None
        if inst is not None and level is not None:
            regime = db.load_candles(row["symbol"], inst.regime_tf, since=ts - timedelta(milliseconds=tf_ms * ENTRY_WARMUP_BARS))
        res = replay(row, entry, regime, exit_params, cfg.paper.slippage_pct, level, max_bars=max_bars)
        closed_at = res["closed_at"].to_pydatetime() if res["closed_at"] is not None else None
        with db.engine().begin() as conn:
            conn.execute(UPSERT, {"signal_id": row["id"], **{k: v for k, v in res.items() if k != "closed_at"}, "closed_at": closed_at})
        written += 1
    return written
