import { config as loadDotenv } from "dotenv";
import { Redis } from "ioredis";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import postgres from "postgres";
import { parse as parseYaml } from "yaml";
import { buildServer, type RedisLike } from "./server.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const cfg = parseYaml(readFileSync(resolve(REPO_ROOT, process.env.STRATEGY_CONFIG ?? "config/strategies.yaml"), "utf8"));
const timeframes = [...new Set<string>([...cfg.strategies.flatMap((s: any) => [s.entry_tf, s.regime_tf, s.range_tf].filter(Boolean)), ...(cfg.chart_timeframes ?? [])])];
const sql = postgres(process.env.DATABASE_URL ?? "postgres://trading:trading@localhost:5435/trading", { max: 5, onnotice: () => {} });
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6375");
const subscriber = new Redis(process.env.REDIS_URL ?? "redis://localhost:6375");

const app = await buildServer({
  sql,
  redis: redis as unknown as RedisLike,
  subscriber,
  mode: cfg.mode ?? "shadow",
  config: { symbols: cfg.symbols, timeframes, strategies: cfg.strategies },
  staticDir: resolve(REPO_ROOT, "apps/dashboard/dist"),
});
const port = Number(process.env.DASHBOARD_PORT ?? 8787);
await app.listen({ port, host: "127.0.0.1" });
log.info({ port }, "dashboard api listening on http://127.0.0.1:" + port);
