/**
 * Engine entrypoint.
 * M1: stream live klines, persist closed candles, gap-fill over REST on every (re)connect.
 * M3 adds the signal consumer, shadow positions, events and commands.
 */
import { Redis } from "ioredis";
import { configTimeframes, enabledStrategies, loadAppConfig, loadEnv } from "./config.js";
import { connectDb, upsertCandle, type Sql } from "./db.js";
import { log } from "./log.js";
import { BinanceKlineStream } from "./marketdata/binanceWs.js";
import { ccxtFetcher, fillGap, type KlineFetcher } from "./marketdata/gapFill.js";
import type { Timeframe } from "@trading/contracts";

async function fillAllGaps(sql: Sql, fetcher: KlineFetcher, symbols: string[], timeframes: Timeframe[]) {
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      try {
        await fillGap(sql, fetcher, symbol, tf);
      } catch (err) {
        log.error({ err, symbol, tf }, "gap fill failed");
      }
    }
  }
}

export async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadAppConfig(env);
  const timeframes = configTimeframes(cfg);
  log.info(
    { mode: cfg.mode, symbols: cfg.symbols, timeframes, strategies: enabledStrategies(cfg).map((s) => s.id) },
    "engine starting",
  );

  const sql = connectDb(env.DATABASE_URL);
  await sql`SELECT 1`;
  log.info("postgres connected");

  const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.ping();
  log.info("redis connected");

  await sql`INSERT INTO engine_state (mode) VALUES (${cfg.mode}) ON CONFLICT (mode) DO NOTHING`;

  const fetcher = await ccxtFetcher();
  const stream = new BinanceKlineStream(cfg.symbols, timeframes);
  let filling: Promise<void> = Promise.resolve();

  stream.on("connected", ({ reconnect }) => {
    log.info({ reconnect }, "kline stream connected, filling gaps");
    filling = fillAllGaps(sql, fetcher, cfg.symbols, timeframes);
  });
  stream.on("candleClosed", async (c) => {
    try {
      await filling; // never write a live candle before the gap behind it is filled
      await upsertCandle(sql, c);
      await sql`UPDATE engine_state SET last_candle_at = ${c.openTime}, updated_at = now() WHERE mode = ${cfg.mode}`;
      log.info({ symbol: c.symbol, tf: c.timeframe, t: c.openTime.toISOString(), close: c.close }, "candle closed");
    } catch (err) {
      log.error({ err }, "failed to persist candle");
    }
  });
  stream.start();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    stream.stop();
    await redis.quit();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (process.env.ENGINE_ONCE === "1") {
    await new Promise((r) => setTimeout(r, Number(process.env.ENGINE_ONCE_MS ?? 15_000)));
    await filling;
    await shutdown("once");
  }
}

main().catch((err) => {
  log.fatal({ err }, "engine crashed");
  process.exit(1);
});
