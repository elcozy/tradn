/**
 * Dashboard API: read-only views over Postgres, event/candle push over WebSocket, commands to Redis.
 * Bound to localhost. Built with buildServer() so tests can inject a test database and a fake Redis.
 */
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { EngineCommandSchema, STREAMS } from "@trading/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import type postgres from "postgres";
import { z } from "zod";

export type Sql = ReturnType<typeof postgres>;

/** The slice of ioredis the API uses, so tests can pass a fake. */
export interface RedisLike {
  xadd(...args: (string | number)[]): Promise<unknown>;
  xrevrange(key: string, end: string, start: string, ...args: (string | number)[]): Promise<[string, string[]][]>;
  xread(...args: (string | number)[]): Promise<[string, [string, string[]][]][] | null>;
}

export interface ServerDeps {
  sql: Sql;
  redis: RedisLike;
  mode: string;
  config: { symbols: string[]; timeframes: string[]; strategies: { id: string; type: string; symbol: string; entry_tf: string; regime_tf: string; enabled: boolean }[] };
  staticDir?: string;
  candlePollMs?: number;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const fieldJson = (fields: string[]) => {
  const i = fields.indexOf("json");
  return i >= 0 ? JSON.parse(fields[i + 1]!) : null;
};

export async function buildServer(deps: ServerDeps): Promise<FastifyInstance> {
  const { sql, redis, mode } = deps;
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.get("/api/health", async () => ({ ok: true }));

  app.get("/api/config", async () => ({ mode, ...deps.config }));

  app.get("/api/status", async () => {
    const st = (await sql`SELECT paused, news_block, last_candle_at, last_heartbeat, updated_at FROM engine_state WHERE mode = ${mode}`)[0] ?? null;
    const open = (await sql`SELECT count(*)::int AS n FROM positions WHERE mode = ${mode} AND state <> 'closed'`)[0]!.n;
    const today = (await sql`SELECT count(*)::int AS signals, count(*) FILTER (WHERE outcome = 'rejected')::int AS rejected,
        count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed, coalesce(sum(realized_r), 0)::float AS r, coalesce(sum(realized_pnl), 0)::float AS pnl
      FROM signals WHERE mode = ${mode} AND ts >= date_trunc('day', now())`)[0];
    return { mode, engine: st, open_positions: open, today };
  });

  const CandlesQ = z.object({
    symbol: z.string().default("BTCUSDT"),
    tf: z.string().default("15m"),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  });
  app.get("/api/candles", async (req) => {
    const q = CandlesQ.parse(req.query);
    const rows = await sql`
      SELECT open_time, open, high, low, close, volume FROM candles
      WHERE symbol = ${q.symbol} AND timeframe = ${q.tf} AND closed
        ${q.from ? sql`AND open_time >= ${q.from}` : sql``} ${q.to ? sql`AND open_time < ${q.to}` : sql``}
      ORDER BY open_time DESC LIMIT ${q.limit}`;
    return rows.reverse().map((r) => ({ time: Math.floor(new Date(r.open_time).getTime() / 1000), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) }));
  });

  const SignalsQ = z.object({
    strategy_id: z.string().optional(),
    symbol: z.string().optional(),
    outcome: z.string().optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  });
  app.get("/api/signals", async (req) => {
    const q = SignalsQ.parse(req.query);
    const where = sql`WHERE (mode = ${mode} OR mode IS NULL)
      ${q.strategy_id ? sql`AND strategy_id = ${q.strategy_id}` : sql``}
      ${q.symbol ? sql`AND symbol = ${q.symbol}` : sql``}
      ${q.outcome === "open" ? sql`AND outcome IS NULL AND position_id IS NOT NULL` : q.outcome ? sql`AND outcome = ${q.outcome}` : sql``}
      ${q.from ? sql`AND ts >= ${q.from}` : sql``} ${q.to ? sql`AND ts < ${q.to}` : sql``}`;
    const total = (await sql`SELECT count(*)::int AS n FROM signals ${where}`)[0]!.n;
    const rows = await sql`SELECT * FROM signals ${where} ORDER BY ts DESC LIMIT ${q.limit} OFFSET ${q.offset}`;
    return { total, rows: rows.map(numericRow) };
  });

  app.get<{ Params: { id: string } }>("/api/signals/:id", async (req, reply) => {
    const sig = (await sql`SELECT * FROM signals WHERE id = ${req.params.id}`)[0];
    if (!sig) return reply.code(404).send({ error: "not found" });
    const pos = (await sql`SELECT * FROM positions WHERE signal_id = ${req.params.id}`)[0] ?? null;
    return { signal: numericRow(sig), position: pos ? numericRow(pos) : null, events: pos?.meta?.events ?? [] };
  });

  app.get("/api/positions", async (req) => {
    const open = (req.query as { open?: string }).open !== "false";
    const rows = await sql`SELECT p.*, s.meta AS signal_meta FROM positions p JOIN signals s ON s.id = p.signal_id
      WHERE p.mode = ${mode} ${open ? sql`AND p.state <> 'closed'` : sql``} ORDER BY p.opened_at DESC LIMIT 200`;
    return rows.map(numericRow);
  });

  app.get("/api/scorecard", async () => (await sql`SELECT * FROM v_strategy_scorecard WHERE mode = ${mode}`).map(numericRow));
  app.get("/api/daily", async () => (await sql`SELECT * FROM v_daily_pnl WHERE mode = ${mode} ORDER BY day`).map(numericRow));

  app.get("/api/backtests", async () => (await sql`SELECT id, strategy_id, symbol, timeframe, params, from_ts, to_ts, metrics, created_at FROM backtest_runs ORDER BY created_at DESC LIMIT 50`));
  app.get<{ Params: { id: string } }>("/api/backtests/:id/trades", async (req) =>
    (await sql`SELECT * FROM backtest_trades WHERE run_id = ${req.params.id} ORDER BY ts`).map(numericRow),
  );

  app.get("/api/events", async (req) => {
    const limit = Math.min(Number((req.query as { limit?: string }).limit ?? 100), 500);
    const entries = await redis.xrevrange(STREAMS.engineEvents, "+", "-", "COUNT", limit);
    return entries.map(([id, fields]) => ({ id, ...fieldJson(fields) })).filter((e) => !e.mode || e.mode === mode);
  });

  const CommandBody = z.object({
    type: z.enum(["close_position", "close_all", "pause", "resume", "kill", "news_on", "news_off"]),
    position_id: z.string().optional(),
    symbol: z.string().optional(),
    reason: z.string().optional(),
  });
  app.post("/api/commands", async (req) => {
    const body = CommandBody.parse(req.body);
    const cmd = EngineCommandSchema.parse({ v: 1, ts: new Date().toISOString(), source: "dashboard", ...body });
    const id = await redis.xadd(STREAMS.engineCommands, "*", "json", JSON.stringify(cmd));
    return { ok: true, id };
  });

  // WebSocket: pushes {kind:"event"} for every engine event and {kind:"candle"} when a newer closed candle appears.
  app.get("/ws", { websocket: true }, (socket) => {
    let lastEventId = "$";
    let lastCandle = new Map<string, number>();
    let alive = true;
    socket.on("close", () => (alive = false));
    const pump = async () => {
      while (alive) {
        try {
          const res = await redis.xread("COUNT", 50, "BLOCK", 1000, "STREAMS", STREAMS.engineEvents, lastEventId);
          if (res) for (const [, entries] of res) for (const [id, fields] of entries) {
            lastEventId = id;
            const ev = fieldJson(fields);
            if (ev && alive) socket.send(JSON.stringify({ kind: "event", event: ev }));
          }
          if (lastEventId === "$") lastEventId = "$"; // no events yet: keep tailing
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    const poll = async () => {
      while (alive) {
        try {
          const rows = await sql`SELECT DISTINCT ON (symbol, timeframe) symbol, timeframe, open_time, open, high, low, close, volume
            FROM candles WHERE closed ORDER BY symbol, timeframe, open_time DESC`;
          for (const r of rows) {
            const key = `${r.symbol}:${r.timeframe}`;
            const t = Math.floor(new Date(r.open_time).getTime() / 1000);
            if ((lastCandle.get(key) ?? 0) < t) {
              lastCandle.set(key, t);
              if (lastCandle.size > 0 && alive)
                socket.send(JSON.stringify({ kind: "candle", symbol: r.symbol, tf: r.timeframe, candle: { time: t, open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.close), volume: num(r.volume) } }));
            }
          }
        } catch {
          /* ignore */
        }
        await new Promise((r) => setTimeout(r, deps.candlePollMs ?? 5000));
      }
    };
    void pump();
    void poll();
  });

  if (deps.staticDir && existsSync(deps.staticDir)) {
    await app.register(fastifyStatic, { root: deps.staticDir, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  }
  return app;
}

/** Postgres numeric comes back as strings; convert the known money/number columns. */
const NUMERIC = new Set([
  "entry_price", "stop_price", "tp1_price", "tp_price", "projected_r", "actual_entry", "slippage_pct", "exit_price", "realized_r",
  "realized_pnl", "fees", "mfe_r", "mae_r", "qty", "remaining_qty", "sl_price", "sl_initial", "highest_high", "lowest_low", "pnl",
  "r_multiple", "expectancy_r", "win_rate", "profit_factor", "avg_mfe_of_losers", "avg_mae_of_winners", "avg_bars_held", "total_pnl", "r",
  "trades", "wins", "losses", "balance_quote", "unrealised", "drawdown_pct",
]);
export function numericRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const k of Object.keys(out)) if (NUMERIC.has(k) && typeof out[k] === "string") out[k] = Number(out[k]);
  return out as T;
}
