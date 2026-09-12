"""Live signal runner (shadow mode and up).

Polls the candles table (the engine keeps it fresh) and, whenever a new closed entry-timeframe candle
appears for a strategy instance, evaluates that instance on it. A signal is written to the journal and
published to Redis; a non-signal is logged with its skip reason so silence is distinguishable from a crash.
No exchange connection here.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pandas as pd
from rich.console import Console

from .. import db
from ..config import TIMEFRAME_MS, AppConfig, StrategyInstance
from ..contracts import Signal
from ..journal import write_signal
from ..strategies.base import SignalDraft, make_strategy
from .publisher import publish_signal

console = Console()

ENTRY_BARS = 600  # enough for RSI/ATR warmup and level touches


@dataclass
class Evaluation:
    instance_id: str
    candle_time: pd.Timestamp
    signal: Signal | None
    reason: str


def signal_id(inst: StrategyInstance, candle_time: pd.Timestamp) -> str:
    return f"{inst.id}:{inst.symbol}:{inst.entry_tf}:{candle_time.strftime('%Y-%m-%dT%H:%M:%SZ')}"


def build_signal(inst: StrategyInstance, candle_time: pd.Timestamp, d: SignalDraft) -> Signal:
    closed_at = candle_time + pd.Timedelta(milliseconds=TIMEFRAME_MS[inst.entry_tf])
    return Signal.model_validate(
        {
            "v": 1,
            "id": signal_id(inst, candle_time),
            "ts": closed_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "strategy_id": inst.id,
            "strategy_type": inst.type,
            "symbol": inst.symbol,
            "timeframe": inst.entry_tf,
            "side": "long",
            "entry": {"type": "market", "price": d.entry},
            "stop_price": d.stop,
            "tp1_price": d.tp1,
            "tp_price": d.tp,
            "confidence": d.confidence,
            "exit": inst.exit.model_dump(),
            "meta": {**d.meta, "invalidation_level": d.invalidation_level},
        }
    )


def evaluate_instance(cfg: AppConfig, inst: StrategyInstance, entry_df: pd.DataFrame, regime_df: pd.DataFrame) -> Evaluation:
    """Evaluate the LAST bar of entry_df (which must be closed)."""
    strat = make_strategy(inst, cfg.regime)
    strat.prepare(entry_df, regime_df)
    i = len(entry_df) - 1
    candle_time = entry_df.index[i]
    draft, reason = strat._evaluate(i) if hasattr(strat, "_evaluate") else (strat.signal(i), "signal")
    sig = build_signal(inst, candle_time, draft) if draft else None
    return Evaluation(inst.id, candle_time, sig, reason if sig is None else "signal")


def load_for(inst: StrategyInstance, cfg: AppConfig, until: datetime | None = None):
    regime_bars = cfg.regime.ema_slow + 24 * inst.params.get("level_lookback_days", 30) + 50
    entry_df = db.load_candles(inst.symbol, inst.entry_tf, until=until, limit=ENTRY_BARS)
    regime_df = db.load_candles(inst.symbol, inst.regime_tf, until=until, limit=regime_bars)
    return entry_df, regime_df


def run_once(cfg: AppConfig, seen: dict[str, pd.Timestamp], publish=publish_signal, write=write_signal) -> list[Evaluation]:
    """Evaluate every enabled instance whose latest closed candle has not been evaluated yet."""
    out: list[Evaluation] = []
    for inst in cfg.enabled_strategies:
        entry_df, regime_df = load_for(inst, cfg)
        if entry_df.empty or regime_df.empty:
            console.log(f"[yellow]{inst.id}: no candles yet[/]")
            continue
        latest = entry_df.index[-1]
        if seen.get(inst.id) == latest:
            continue
        ev = evaluate_instance(cfg, inst, entry_df, regime_df)
        seen[inst.id] = latest
        if ev.signal is not None:
            fresh = write(ev.signal)
            if fresh:
                publish(ev.signal)
            console.log(f"[green bold]{inst.id} SIGNAL[/] {latest} entry {ev.signal.entry.price} stop {ev.signal.stop_price} "
                        f"tp {ev.signal.tp_price} {'(published)' if fresh else '(duplicate, not republished)'}")
        else:
            console.log(f"{inst.id} {latest} no signal ({ev.reason})")
        out.append(ev)
    return out


def next_close_wait(cfg: AppConfig, now: datetime) -> float:
    """Seconds until the next entry-timeframe candle close (fastest entry tf), plus a small grace."""
    tf_ms = min(TIMEFRAME_MS[s.entry_tf] for s in cfg.enabled_strategies)
    now_ms = int(now.timestamp() * 1000)
    next_ms = (now_ms // tf_ms + 1) * tf_ms
    return max(1.0, (next_ms - now_ms) / 1000 + 5.0)


def run_live(cfg: AppConfig, once: bool = False, poll_seconds: float = 10.0) -> None:
    seen: dict[str, pd.Timestamp] = {}
    console.log(f"signal runner: mode={cfg.mode} instances={[s.id for s in cfg.enabled_strategies]}")
    while True:
        try:
            run_once(cfg, seen)
        except Exception as e:  # keep running; the engine's watchdog notices prolonged silence
            console.log(f"[red]runner error: {e!r}[/]")
        if once:
            return
        # sleep until just after the next close, then poll briefly for the engine to persist the candle
        wait = next_close_wait(cfg, datetime.now(timezone.utc))
        time.sleep(wait)
        deadline = datetime.now(timezone.utc) + timedelta(seconds=90)
        while datetime.now(timezone.utc) < deadline:
            evs = run_once(cfg, seen)
            if evs:
                break
            time.sleep(poll_seconds)
