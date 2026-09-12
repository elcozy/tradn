/**
 * After a (re)connect, fetch any candles missed while offline over REST and persist them,
 * so the journal never has a hole. Only closed candles are written.
 */
import { TIMEFRAME_MS, type Timeframe } from "@trading/contracts";
import { type Candle, type Sql, lastCandleTime, upsertCandle } from "../db.js";
import { log } from "../log.js";

/** [openTimeMs, open, high, low, close, volume] as ccxt returns it. */
export type OhlcvRow = [number, number, number, number, number, number];

export interface KlineFetcher {
  fetchOHLCV(symbol: string, timeframe: string, sinceMs: number, limit: number): Promise<OhlcvRow[]>;
}

export function toCcxtSymbol(symbol: string): string {
  for (const quote of ["USDT", "USDC", "FDUSD", "BTC", "ETH", "BNB"]) {
    if (symbol.endsWith(quote) && symbol.length > quote.length) return `${symbol.slice(0, -quote.length)}/${quote}`;
  }
  throw new Error(`cannot split symbol ${symbol}`);
}

export function lastClosedOpenMs(nowMs: number, tfMs: number): number {
  return Math.floor(nowMs / tfMs) * tfMs - tfMs;
}

export interface GapFillResult {
  fetched: number;
  fromMs: number | null;
  toMs: number;
}

/**
 * Fetches candles from (last stored + 1 tf) up to the most recent closed candle.
 * With no stored candles, fetches `bootstrapBars` closed candles.
 */
export async function fillGap(
  sql: Sql,
  fetcher: KlineFetcher,
  symbol: string,
  timeframe: Timeframe,
  opts: { nowMs?: number; bootstrapBars?: number; pageSize?: number } = {},
): Promise<GapFillResult> {
  const tfMs = TIMEFRAME_MS[timeframe];
  const nowMs = opts.nowMs ?? Date.now();
  const bootstrapBars = opts.bootstrapBars ?? 500;
  const pageSize = opts.pageSize ?? 1000;
  const toMs = lastClosedOpenMs(nowMs, tfMs);

  const last = await lastCandleTime(sql, symbol, timeframe);
  let since = last ? last.getTime() + tfMs : toMs - (bootstrapBars - 1) * tfMs;
  const fromMs = since <= toMs ? since : null;
  let fetched = 0;
  const market = toCcxtSymbol(symbol);

  while (since <= toMs) {
    const rows = await fetcher.fetchOHLCV(market, timeframe, since, pageSize);
    if (rows.length === 0) break;
    for (const r of rows) {
      if (r[0] > toMs) continue; // still forming
      const c: Candle = {
        symbol,
        timeframe,
        openTime: new Date(r[0]),
        open: r[1],
        high: r[2],
        low: r[3],
        close: r[4],
        volume: r[5],
        closed: true,
      };
      await upsertCandle(sql, c);
      fetched += 1;
    }
    const newest = rows[rows.length - 1]![0];
    if (newest < since) break;
    since = newest + tfMs;
  }
  if (fetched > 0) log.info({ symbol, timeframe, fetched, fromMs, toMs }, "gap filled");
  return { fetched, fromMs, toMs };
}

/** ccxt-backed fetcher for production. */
export async function ccxtFetcher(): Promise<KlineFetcher> {
  const ccxt = await import("ccxt");
  const ex = new ccxt.binance({ enableRateLimit: true });
  return {
    async fetchOHLCV(symbol, timeframe, sinceMs, limit) {
      const rows = (await ex.fetchOHLCV(symbol, timeframe, sinceMs, limit)) as (number | undefined)[][];
      return rows.map((r) => [r[0]!, r[1]!, r[2]!, r[3]!, r[4]!, r[5]!] as OhlcvRow);
    },
  };
}
