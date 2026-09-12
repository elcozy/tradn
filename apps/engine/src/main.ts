/**
 * Engine entrypoint (shadow mode and up).
 * - streams live klines, persists closed candles, gap-fills over REST on every (re)connect
 * - consumes signals, risk-checks them, opens positions through the mode's adapter
 * - steps the exit policy on every closed candle, journals outcomes, emits events
 * - consumes commands (pause / resume / news / close / kill), heartbeats, alerts on silence
 */
import { Redis } from "ioredis";
import type { Timeframe } from "@trading/contracts";
import { applyCommand, CommandConsumer } from "./commands/consumer.js";
import { configTimeframes, enabledStrategies, loadAppConfig, loadEnv } from "./config.js";
import { connectDb, upsertCandle, type Sql } from "./db.js";
import { EngineEventType, RedisEventPublisher } from "./events.js";
import type { ExchangeAdapter } from "./execution/adapter.js";
import { ShadowAdapter } from "./execution/shadow.js";
import { log } from "./log.js";
import { BinanceKlineStream } from "./marketdata/binanceWs.js";
import { ccxtFetcher, fillGap, type KlineFetcher } from "./marketdata/gapFill.js";
import { PositionManager } from "./positions/manager.js";
import { PgPositionStore } from "./positions/store.js";
import { SignalConsumer } from "./signals/consumer.js";
import { PgStateStore } from "./state.js";

const HEARTBEAT_MS = 60 * 60 * 1000;

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

function makeAdapter(mode: string): ExchangeAdapter {
  if (mode === "shadow") return new ShadowAdapter();
  throw new Error(`mode ${mode} is not implemented yet (M5 paper, M6 testnet, M7 live)`);
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
  const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  const blocking = new Redis(env.REDIS_URL, { lazyConnect: true }); // XREADGROUP BLOCK needs its own connection
  await blocking.connect();
  const blocking2 = new Redis(env.REDIS_URL, { lazyConnect: true });
  await blocking2.connect();
  log.info("postgres + redis connected");

  const state = new PgStateStore(sql, cfg.mode);
  const flags = await state.load();
  const events = new RedisEventPublisher(redis, cfg.mode);
  const store = new PgPositionStore(sql, cfg.mode);
  const manager = new PositionManager(cfg, store, events, makeAdapter(cfg.mode));
  await manager.restore();

  const fetcher = await ccxtFetcher();
  const stream = new BinanceKlineStream(cfg.symbols, timeframes);
  let filling: Promise<void> = Promise.resolve();

  stream.on("connected", ({ reconnect }) => {
    log.info({ reconnect }, "kline stream connected, filling gaps");
    filling = fillAllGaps(sql, fetcher, cfg.symbols, timeframes);
  });
  stream.on("silence", () => void events.emit({ type: EngineEventType.Alert, reason: "no candle for 3 minutes, reconnecting" }));
  stream.on("candleClosed", async (c) => {
    try {
      await filling;
      await upsertCandle(sql, c);
      await state.lastCandle(c.openTime);
      log.info({ symbol: c.symbol, tf: c.timeframe, t: c.openTime.toISOString(), close: c.close }, "candle closed");
      await manager.onCandleClosed(c);
    } catch (err) {
      log.error({ err }, "candle handling failed");
    }
  });
  stream.start();

  const signals = new SignalConsumer(blocking, async (sig) => {
    const f = await state.load();
    await manager.handleSignal(sig, { paused: f.paused, newsBlock: f.news_block });
  });
  void signals.run();

  const commands = new CommandConsumer(blocking2, (cmd) => applyCommand(cmd, state, manager, events));
  void commands.run();

  const heartbeat = setInterval(async () => {
    await state.heartbeat();
    await events.emit({
      type: EngineEventType.Heartbeat,
      detail: { open_positions: manager.openPositions.length, reconnects: stream.reconnects, paused: (await state.load()).paused },
    });
  }, HEARTBEAT_MS);
  await state.heartbeat();
  log.info({ paused: flags.paused, news_block: flags.news_block, open: manager.openPositions.length }, "engine ready");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    stream.stop();
    signals.stop();
    commands.stop();
    await Promise.allSettled([redis.quit(), blocking.disconnect(), blocking2.disconnect()]);
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
