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


def ingest(
    symbol: str,
    timeframe: str,
    since: datetime | None = None,
    exchange: Exchange | None = None,
    default_lookback: timedelta = timedelta(days=365),
    sleep: bool = True,
) -> int:
    """Fetch klines from `since` (or resume after the last stored candle) up to the last closed one."""
    ex = exchange or make_exchange()
    market = to_ccxt_symbol(symbol)
    tf_ms = TIMEFRAME_MS[timeframe]

    last = db.last_candle_time(symbol, timeframe)
    if last is not None:
        start_ms = int(last.timestamp() * 1000)  # re-fetch the last candle in case it was partial
    elif since is not None:
        start_ms = int(since.replace(tzinfo=since.tzinfo or timezone.utc).timestamp() * 1000)
    else:
        start_ms = int((datetime.now(timezone.utc) - default_lookback).timestamp() * 1000)

    now_ms = ex.milliseconds()
    last_closed_open_ms = (now_ms // tf_ms) * tf_ms - tf_ms  # open time of the most recent CLOSED candle
    total = 0
    console.log(f"[bold]{symbol} {timeframe}[/] from {pd.Timestamp(start_ms, unit='ms', tz='UTC')}")
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
