/**
 * Engine entrypoint (shadow mode and up).
 * - streams live klines, persists closed candles, gap-fills over REST on every (re)connect
 * - consumes signals, risk-checks them, opens positions through the mode's adapter
 * - steps the exit policy on every closed candle, journals outcomes, emits events
 * - consumes commands (pause / resume / news / close / kill), heartbeats, alerts on silence
 * - paper and up: keeps the wallet and writes equity snapshots hourly and on every close
 */
import { Redis } from "ioredis";
import { LIVE_CANDLE_CHANNEL, type Timeframe } from "@trading/contracts";
import { applyCommand, CommandConsumer } from "./commands/consumer.js";
import { configTimeframes, enabledStrategies, loadAppConfig, loadEnv, type AppConfig, type Env } from "./config.js";
import { connectDb, upsertCandle, type Sql } from "./db.js";
import { EngineEventType, RedisEventPublisher } from "./events.js";
import type { ExchangeAdapter } from "./execution/adapter.js";
import { BinanceSpotAdapter } from "./execution/binance/adapter.js";
import { PgOrderStore } from "./execution/binance/orders.js";
import { Reconciler } from "./execution/binance/reconcile.js";
import { ccxtBinanceRest, type BinanceRest } from "./execution/binance/rest.js";
import { USER_WS, USER_WS_TESTNET, UserDataStream } from "./execution/binance/userStream.js";
import { ccxtFiltersSource, loadFilters } from "./execution/exchangeInfo.js";
import { PaperAdapter } from "./execution/paper.js";
import { ShadowAdapter } from "./execution/shadow.js";
import { ExchangeWallet, PaperWallet, PgWalletStore, type Wallet } from "./execution/wallet.js";
import { log } from "./log.js";
import { BinanceKlineStream } from "./marketdata/binanceWs.js";
import { ccxtFetcher, fillGap, type KlineFetcher } from "./marketdata/gapFill.js";
import { PositionManager } from "./positions/manager.js";
import { PgPositionStore } from "./positions/store.js";
import { SignalConsumer } from "./signals/consumer.js";
import { PgStateStore } from "./state.js";

const HEARTBEAT_MS = 60 * 60 * 1000;
const RECONCILE_MS = 5 * 60 * 1000;
const ORDER_POLL_MS = 60 * 1000;

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

/** Exchange REST client for testnet (testnet keys, sandbox endpoints) or live (real keys). */
async function makeRest(cfg: AppConfig, env: Env): Promise<BinanceRest | null> {
  if (cfg.mode !== "testnet" && cfg.mode !== "live") return null;
  const key = cfg.mode === "testnet" ? env.BINANCE_TESTNET_API_KEY : env.BINANCE_API_KEY;
  const secret = cfg.mode === "testnet" ? env.BINANCE_TESTNET_API_SECRET : env.BINANCE_API_SECRET;
  if (!key || !secret) throw new Error(`${cfg.mode} mode needs ${cfg.mode === "testnet" ? "BINANCE_TESTNET_API_KEY/SECRET" : "BINANCE_API_KEY/SECRET"} in .env`);
  return ccxtBinanceRest(key, secret, cfg.mode === "testnet");
}

/** The wallet exists from paper mode up: simulated in paper, the exchange's quote balance from testnet on.
 * Shadow sizes against the configured balance and moves no cash. */
async function makeWallet(cfg: AppConfig, sql: Sql, rest: BinanceRest | null): Promise<Wallet | null> {
  if (cfg.mode === "shadow") return null;
  const store = new PgWalletStore(sql, cfg.mode);
  const wallet = rest ? new ExchangeWallet(store, () => rest.balances()) : new PaperWallet(store, cfg.paper.starting_balance);
  await wallet.init();
  return wallet;
}

interface ExchangeSide {
  adapter: BinanceSpotAdapter;
  stream: UserDataStream;
  reconciler: Reconciler;
}

function makeAdapter(cfg: AppConfig, wallet: Wallet | null, exchange: Pick<ExchangeSide, "adapter"> | null): ExchangeAdapter {
  switch (cfg.mode) {
    case "shadow":
      return new ShadowAdapter();
    case "paper":
      return new PaperAdapter(cfg.paper, wallet as PaperWallet);
    default:
      return exchange!.adapter;
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
  const rest = await makeRest(cfg, env);
  const wallet = await makeWallet(cfg, sql, rest);
  const filters = await loadFilters(ccxtFiltersSource(cfg.mode === "testnet"), cfg.symbols);

  // testnet / live: real orders, user data stream, reconciliation
  let exchange: ExchangeSide | null = null;
  let manager: PositionManager;
  if (rest) {
    const orders = new PgOrderStore(sql, cfg.mode);
    const adapter = new BinanceSpotAdapter({
      mode: cfg.mode as "testnet" | "live", rest, orders, filters, events,
      onForcedClose: async (fc) => void (await manager.forceClose(fc)),
    });
    manager = new PositionManager(cfg, store, events, adapter, () => new Date(), { wallet, filters });
    const stream = new UserDataStream(rest, { wsBase: cfg.mode === "testnet" ? USER_WS_TESTNET : USER_WS });
    stream.on("report", (r) => void adapter.applyExecutionReport(r).catch((err) => log.error({ err }, "execution report failed")));
    const reconciler = new Reconciler({ rest, orders, adapter, manager, events, risk: store, state });
    exchange = { adapter, stream, reconciler };
  } else {
    manager = new PositionManager(cfg, store, events, makeAdapter(cfg, wallet, null), () => new Date(), { wallet, filters });
  }
  await manager.restore();
  if (wallet) log.info({ cash: wallet.cash, filters: filters.size }, "wallet ready");
  const timers: NodeJS.Timeout[] = [];
  if (exchange) {
    await exchange.stream.start();
    const first = await exchange.reconciler.run();
    log.info(first, "start-up reconciliation");
    timers.push(setInterval(() => void exchange!.reconciler.run().catch((err) => log.error({ err }, "reconcile failed")), RECONCILE_MS));
    timers.push(setInterval(() => void exchange!.adapter.refreshOpenOrders().catch((err) => log.error({ err }, "order poll failed")), ORDER_POLL_MS));
  }

  const fetcher = await ccxtFetcher();
  const stream = new BinanceKlineStream(cfg.symbols, timeframes);
  let filling: Promise<void> = Promise.resolve();

  stream.on("connected", ({ reconnect }) => {
    log.info({ reconnect }, "kline stream connected, filling gaps");
    filling = fillAllGaps(sql, fetcher, cfg.symbols, timeframes);
  });
  stream.on("candle", (c) => {
    // forming candle for the dashboard's live chart; closed candles are persisted separately below
    void redis.publish(LIVE_CANDLE_CHANNEL, JSON.stringify({ symbol: c.symbol, tf: c.timeframe, candle: {
      time: Math.floor(c.openTime.getTime() / 1000), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, closed: c.closed,
    } })).catch(() => {});
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

  // One consumer group per mode, so a paper engine beside the shadow soak sees every signal and command too.
  const group = `engine:${cfg.mode}`;
  const signals = new SignalConsumer(blocking, async (sig) => {
    const f = await state.load();
    await manager.handleSignal(sig, { paused: f.paused, newsBlock: f.news_block, entriesEnabled: f.entries_enabled });
  }, group);
  void signals.run();

  const commands = new CommandConsumer(blocking2, (cmd) => applyCommand(cmd, state, manager, events), group);
  void commands.run();

  const heartbeat = setInterval(async () => {
    await state.heartbeat();
    await manager.snapshotEquity();
    await events.emit({
      type: EngineEventType.Heartbeat,
      detail: { open_positions: manager.openPositions.length, reconnects: stream.reconnects, paused: (await state.load()).paused, cash: wallet?.cash },
    });
  }, HEARTBEAT_MS);
  await state.heartbeat();
  await manager.snapshotEquity();
  log.info(
    { paused: flags.paused, news_block: flags.news_block, entries_enabled: flags.entries_enabled, open: manager.openPositions.length },
    "engine ready",
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    clearInterval(heartbeat);
    for (const t of timers) clearInterval(t);
    if (exchange) await exchange.stream.stop(); // exchange-side stops stay in place: that is the point
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
