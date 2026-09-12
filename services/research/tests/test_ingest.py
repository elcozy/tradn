from datetime import datetime, timezone

import pandas as pd

from research import ingest as ing
from research.config import TIMEFRAME_MS


class FakeExchange:
    """Serves synthetic 15m candles from t0 in pages of `page` rows, like ccxt."""

    rateLimit = 0

    def __init__(self, t0_ms: int, n: int, now_ms: int, page: int = 1000):
        self.t0, self.n, self.now, self.page = t0_ms, n, now_ms, page
        self.calls: list[int] = []

    def milliseconds(self) -> int:
        return self.now

    def fetch_ohlcv(self, symbol, timeframe, since, limit):
        self.calls.append(since)
        tf = TIMEFRAME_MS[timeframe]
        rows = []
        t = since - (since % tf)
        while len(rows) < min(limit, self.page) and t < self.t0 + self.n * tf:
            if t >= self.t0:
                rows.append([t, 100.0, 101.0, 99.0, 100.5, 10.0])
            t += tf
        return rows


def test_to_ccxt_symbol():
    assert ing.to_ccxt_symbol("BTCUSDT") == "BTC/USDT"
    assert ing.to_ccxt_symbol("ETHBTC") == "ETH/BTC"


def test_batch_to_frame_drops_forming_candle():
    tf = TIMEFRAME_MS["15m"]
    batch = [[i * tf, 1, 1, 1, 1, 1] for i in range(5)]
    df = ing.batch_to_frame(batch, cutoff_ms=3 * tf)
    assert len(df) == 4
    assert df["open_time"].dt.tz is not None


def test_ingest_paginates_and_skips_open_candle(monkeypatch):
    tf = TIMEFRAME_MS["15m"]
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % tf)
    n = 2500  # 2.5 pages
    now = t0 + n * tf + tf // 2  # halfway through candle n (which is forming)
    ex = FakeExchange(t0, n + 1, now, page=1000)  # exchange also serves the forming candle

    written: list[pd.DataFrame] = []
    monkeypatch.setattr(ing.db, "last_candle_time", lambda s, t: None)
    monkeypatch.setattr(ing.db, "upsert_candles", lambda df, s, t: written.append(df) or len(df))

    total = ing.ingest("BTCUSDT", "15m", since=datetime.fromtimestamp(t0 / 1000, tz=timezone.utc), exchange=ex, sleep=False)

    assert total == n  # forming candle excluded
    assert len(ex.calls) == 3
    all_rows = pd.concat(written)
    assert all_rows["open_time"].is_monotonic_increasing
    assert all_rows["open_time"].iloc[-1] == pd.Timestamp(t0 + (n - 1) * tf, unit="ms", tz="UTC")


def test_ingest_resumes_from_last_candle(monkeypatch):
    tf = TIMEFRAME_MS["15m"]
    t0 = 1_700_000_000_000 - (1_700_000_000_000 % tf)
    n = 100
    now = t0 + n * tf + 1000
    ex = FakeExchange(t0, n, now)
    last = datetime.fromtimestamp((t0 + 90 * tf) / 1000, tz=timezone.utc)
    monkeypatch.setattr(ing.db, "last_candle_time", lambda s, t: last)
    monkeypatch.setattr(ing.db, "upsert_candles", lambda df, s, t: len(df))

    total = ing.ingest("BTCUSDT", "15m", exchange=ex, sleep=False)
    assert ex.calls[0] == t0 + 90 * tf  # re-fetches the last stored candle
    assert total == 10  # candles 90..99 (candle 100 is forming: now is 1s into it)
