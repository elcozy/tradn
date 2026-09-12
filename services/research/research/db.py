from __future__ import annotations

from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import Engine, create_engine, text

from .settings import MIGRATIONS_DIR, settings

_engine: Engine | None = None


def engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = create_engine(settings.sqlalchemy_url, pool_pre_ping=True)
    return _engine


def migrate() -> list[str]:
    """Apply infra/migrations/*.sql in filename order; track them in schema_migrations."""
    applied: list[str] = []
    with engine().begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
            )
        )
        done = {r[0] for r in conn.execute(text("SELECT name FROM schema_migrations"))}
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if path.name in done:
            continue
        with engine().begin() as conn:
            conn.execute(text(path.read_text()))
            conn.execute(text("INSERT INTO schema_migrations (name) VALUES (:n)"), {"n": path.name})
        applied.append(path.name)
    return applied


CANDLE_UPSERT = text(
    "INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume, closed) "
    "VALUES (:symbol, :timeframe, :open_time, :open, :high, :low, :close, :volume, true) "
    "ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET "
    "open=EXCLUDED.open, high=EXCLUDED.high, low=EXCLUDED.low, close=EXCLUDED.close, "
    "volume=EXCLUDED.volume, closed=true"
)


def upsert_candles(df: pd.DataFrame, symbol: str, timeframe: str) -> int:
    """df columns: open_time (tz-aware UTC), open, high, low, close, volume. Idempotent."""
    if df.empty:
        return 0
    rows = [
        {
            "symbol": symbol,
            "timeframe": timeframe,
            "open_time": r.open_time.to_pydatetime(),
            "open": float(r.open),
            "high": float(r.high),
            "low": float(r.low),
            "close": float(r.close),
            "volume": float(r.volume),
        }
        for r in df.itertuples(index=False)
    ]
    with engine().begin() as conn:
        conn.execute(CANDLE_UPSERT, rows)
    return len(rows)


def first_candle_time(symbol: str, timeframe: str) -> datetime | None:
    with engine().connect() as conn:
        row = conn.execute(
            text("SELECT min(open_time) FROM candles WHERE symbol=:s AND timeframe=:t AND closed"),
            {"s": symbol, "t": timeframe},
        ).scalar()
    return row.astimezone(timezone.utc) if row else None


def last_candle_time(symbol: str, timeframe: str) -> datetime | None:
    with engine().connect() as conn:
        row = conn.execute(
            text("SELECT max(open_time) FROM candles WHERE symbol=:s AND timeframe=:t AND closed"),
            {"s": symbol, "t": timeframe},
        ).scalar()
    return row.astimezone(timezone.utc) if row else None


def load_candles(
    symbol: str,
    timeframe: str,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int | None = None,
) -> pd.DataFrame:
    """DataFrame indexed by open_time (UTC) with float open/high/low/close/volume, ascending."""
    clauses = ["symbol=:s", "timeframe=:t", "closed"]
    params: dict = {"s": symbol, "t": timeframe}
    if since is not None:
        clauses.append("open_time >= :since")
        params["since"] = since
    if until is not None:
        clauses.append("open_time < :until")
        params["until"] = until
    order = "DESC" if limit else "ASC"
    sql = (
        "SELECT open_time, open, high, low, close, volume FROM candles WHERE "
        + " AND ".join(clauses)
        + f" ORDER BY open_time {order}"
        + (f" LIMIT {int(limit)}" if limit else "")
    )
    with engine().connect() as conn:
        df = pd.read_sql(text(sql), conn, params=params)
    if df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"]).astype("float64")
    df = df.astype({c: "float64" for c in ["open", "high", "low", "close", "volume"]})
    df["open_time"] = pd.to_datetime(df["open_time"], utc=True)
    return df.set_index("open_time").sort_index()
