/**
 * Engine entrypoint. M0: load config, connect to Postgres and Redis, exit cleanly.
 * Later milestones add market data (M1), shadow position management (M3), adapters (M5+).
 */
import { Redis } from "ioredis";
import { configTimeframes, enabledStrategies, loadAppConfig, loadEnv } from "./config.js";
import { connectDb } from "./db.js";
import { log } from "./log.js";

export async function main(): Promise<void> {
  const env = loadEnv();
  const cfg = loadAppConfig(env);
  log.info(
    {
      mode: cfg.mode,
      symbols: cfg.symbols,
      timeframes: configTimeframes(cfg),
      strategies: enabledStrategies(cfg).map((s) => s.id),
    },
    "engine starting",
  );

  const sql = connectDb(env.DATABASE_URL);
  await sql`SELECT 1`;
  log.info("postgres connected");

  const redis = new Redis(env.REDIS_URL, { lazyConnect: true });
  await redis.connect();
  await redis.ping();
  log.info("redis connected");

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    await redis.quit();
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  if (process.env.ENGINE_ONCE === "1") await shutdown("once");
}

main().catch((err) => {
  log.fatal({ err }, "engine crashed");
  process.exit(1);
});
