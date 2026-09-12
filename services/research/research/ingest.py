"""Historical kline ingest from Binance into the candles hypertable. Resumable and idempotent.

Public endpoints only (no keys). Never writes the still-forming candle.
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Protocol

import pandas as pd
from rich.console import Console

from . import db
from .config import TIMEFRAME_MS

console = Console()
COLUMNS = ["open_time", "open", "high", "low", "close", "volume"]


class Exchange(Protocol):
    """The slice of ccxt.binance we use, so tests can pass a fake."""

    rateLimit: int

    def fetch_ohlcv(self, symbol: str, timeframe: str, since: int | None, limit: int) -> list[list]: ...
    def milliseconds(self) -> int: ...


def make_exchange(futures: bool = False):
    import ccxt

    ex = ccxt.binance({"enableRateLimit": True, "options": {"defaultType": "future" if futures else "spot"}})
    return ex


def to_ccxt_symbol(symbol: str) -> str:
    """BTCUSDT -> BTC/USDT for the common quote assets."""
    for quote in ("USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"):
        if symbol.endswith(quote) and len(symbol) > len(quote):
            return f"{symbol[:-len(quote)]}/{quote}"
    raise ValueError(f"cannot split symbol {symbol}")


def batch_to_frame(batch: list[list], cutoff_ms: int) -> pd.DataFrame:
    """ccxt rows -> DataFrame of CLOSED candles (open_time <= cutoff_ms), tz-aware UTC."""
    df = pd.DataFrame(batch, columns=COLUMNS)
    df = df[df["open_time"] <= cutoff_ms].copy()
    df["open_time"] = pd.to_datetime(df["open_time"], unit="ms", utc=True)
    return df


def _to_ms(dt: datetime) -> int:
    return int(dt.replace(tzinfo=dt.tzinfo or timezone.utc).timestamp() * 1000)


def ingest(
    symbol: str,
    timeframe: str,
    since: datetime | None = None,
    exchange: Exchange | None = None,
    default_lookback: timedelta = timedelta(days=365),
    sleep: bool = True,
) -> int:
    """Fetch klines up to the last closed candle.

    Fills two gaps so a partially-populated table (e.g. the engine's 500-bar bootstrap) is completed:
      * backwards, from `since` up to the earliest stored candle
      * forwards, from the last stored candle to now
    """
    ex = exchange or make_exchange()
    tf_ms = TIMEFRAME_MS[timeframe]
    total = 0

    first = db.first_candle_time(symbol, timeframe)
    want_from_ms = _to_ms(since) if since is not None else int((datetime.now(timezone.utc) - default_lookback).timestamp() * 1000)
    if first is not None and want_from_ms < int(first.timestamp() * 1000) - tf_ms:
        total += _fetch_range(ex, symbol, timeframe, want_from_ms, int(first.timestamp() * 1000) - tf_ms, sleep)

    last = db.last_candle_time(symbol, timeframe)
    # re-fetch the last stored candle in case it was partial; with no data at all, start at want_from_ms
    start_ms = int(last.timestamp() * 1000) if last is not None else want_from_ms
    now_ms = ex.milliseconds()
    last_closed_open_ms = (now_ms // tf_ms) * tf_ms - tf_ms  # open time of the most recent CLOSED candle
    return total + _fetch_range(ex, symbol, timeframe, start_ms, last_closed_open_ms, sleep)


def _fetch_range(ex: Exchange, symbol: str, timeframe: str, start_ms: int, end_ms: int, sleep: bool) -> int:
    """Page through [start_ms, end_ms] (candle open times, inclusive) and upsert. Returns rows written."""
    market = to_ccxt_symbol(symbol)
    tf_ms = TIMEFRAME_MS[timeframe]
    total = 0
    if start_ms > end_ms:
        return 0
    console.log(f"[bold]{symbol} {timeframe}[/] {pd.Timestamp(start_ms, unit='ms', tz='UTC')} → {pd.Timestamp(end_ms, unit='ms', tz='UTC')}")
    last_closed_open_ms = end_ms
    while start_ms <= last_closed_open_ms:
        batch = ex.fetch_ohlcv(market, timeframe, since=start_ms, limit=1000)
        if not batch:
            break
        df = batch_to_frame(batch, last_closed_open_ms)
        total += db.upsert_candles(df, symbol, timeframe)
        newest_ms = int(batch[-1][0])
        if newest_ms < start_ms:
            break
        start_ms = newest_ms + tf_ms
        if not df.empty:
            console.log(f"  … {df['open_time'].iloc[-1]}  (+{len(df)}, total {total})")
        if sleep:
            time.sleep(ex.rateLimit / 1000)
    return total
