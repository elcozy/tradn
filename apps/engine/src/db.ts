import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function connectDb(databaseUrl: string): Sql {
  // numeric -> number: prices/qty are read as JS numbers here; order sizing later uses decimal.js explicitly.
  return postgres(databaseUrl, { max: 5, onnotice: () => {}, transform: { undefined: null } });
}

export interface Candle {
  symbol: string;
  timeframe: string;
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

/** Idempotent upsert; identical conflict rule to research/db.py. Only closed candles are ever written. */
export async function upsertCandle(sql: Sql, c: Candle): Promise<void> {
  if (!c.closed) throw new Error("refusing to persist an open candle");
  await sql`
    INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume, closed)
    VALUES (${c.symbol}, ${c.timeframe}, ${c.openTime}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}, true)
    ON CONFLICT (symbol, timeframe, open_time) DO UPDATE SET
      open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
      close = EXCLUDED.close, volume = EXCLUDED.volume, closed = true
  `;
}

export async function lastCandleTime(sql: Sql, symbol: string, timeframe: string): Promise<Date | null> {
  const rows = await sql<{ t: Date | null }[]>`
    SELECT max(open_time) AS t FROM candles WHERE symbol = ${symbol} AND timeframe = ${timeframe} AND closed`;
  return rows[0]?.t ?? null;
}

export async function loadRecentCandles(sql: Sql, symbol: string, timeframe: string, limit: number): Promise<Candle[]> {
  const rows = await sql<
    { open_time: Date; open: string; high: string; low: string; close: string; volume: string }[]
  >`
    SELECT open_time, open, high, low, close, volume FROM candles
    WHERE symbol = ${symbol} AND timeframe = ${timeframe} AND closed
    ORDER BY open_time DESC LIMIT ${limit}`;
  return rows
    .map((r) => ({
      symbol,
      timeframe,
      openTime: r.open_time,
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
      closed: true,
    }))
    .reverse();
}
