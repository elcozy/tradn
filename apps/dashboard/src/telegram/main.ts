/**
 * Telegram bot: relays engine.events to your chat, accepts commands and publishes them to
 * engine.commands, sends a daily summary at 00:00 UTC. Runs as its own process.
 */
import { EngineCommandSchema, EngineEventSchema, STREAMS } from "@trading/contracts";
import { config as loadDotenv } from "dotenv";
import { Bot } from "grammy";
import { Redis } from "ioredis";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import postgres from "postgres";
import { HELP, TelegramCommand, formatDaily, formatEvent, formatStatus, parseCommand } from "./format.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
loadDotenv({ path: resolve(REPO_ROOT, ".env") });
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
if (!token || !chatId) {
  log.error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID missing in .env");
  process.exit(1);
}
const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6375";
const dbUrl = process.env.DATABASE_URL ?? "postgres://trading:trading@localhost:5435/trading";
const mode = process.env.MODE ?? "shadow";

const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
const redis = new Redis(redisUrl);
const reader = new Redis(redisUrl);
const bot = new Bot(token);

const send = (text: string) => bot.api.sendMessage(chatId, text, { parse_mode: "HTML" }).catch((err) => log.error({ err }, "send failed"));

async function publish(type: string, extra: Record<string, unknown> = {}) {
  const cmd = EngineCommandSchema.parse({ v: 1, ts: new Date().toISOString(), source: "telegram", type, ...extra });
  await redis.xadd(STREAMS.engineCommands, "*", "json", JSON.stringify(cmd));
}

async function status(): Promise<string> {
  const st = (await sql`SELECT paused, news_block, last_candle_at, last_heartbeat FROM engine_state WHERE mode = ${mode}`)[0];
  const open = await sql`SELECT symbol, entry_price, sl_price, tp_price, state, bars_held FROM positions WHERE mode = ${mode} AND state <> 'closed'`;
  const today = (await sql`SELECT count(*)::int AS trades, coalesce(sum(realized_r), 0)::float AS r FROM signals
      WHERE mode = ${mode} AND closed_at >= date_trunc('day', now())`)[0];
  return formatStatus({
    mode,
    paused: st?.paused ?? false,
    newsBlock: st?.news_block ?? false,
    lastCandleAt: st?.last_candle_at ?? null,
    lastHeartbeat: st?.last_heartbeat ?? null,
    open: open.map((p) => ({ symbol: p.symbol, entry: Number(p.entry_price), sl: Number(p.sl_price), tp: Number(p.tp_price), state: p.state, bars: p.bars_held })),
    today: { trades: today?.trades ?? 0, r: today?.r ?? 0 },
  });
}

async function daily(): Promise<string> {
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const s = (await sql`SELECT
      count(*) FILTER (WHERE ts::date = ${day}::date)::int AS signals,
      count(*) FILTER (WHERE ts::date = ${day}::date AND outcome = 'rejected')::int AS rejected,
      count(*) FILTER (WHERE closed_at::date = ${day}::date)::int AS closed,
      count(*) FILTER (WHERE closed_at::date = ${day}::date AND outcome = 'win')::int AS wins,
      count(*) FILTER (WHERE closed_at::date = ${day}::date AND outcome = 'loss')::int AS losses,
      coalesce(sum(realized_r) FILTER (WHERE closed_at::date = ${day}::date), 0)::float AS r,
      coalesce(sum(realized_pnl) FILTER (WHERE closed_at::date = ${day}::date), 0)::float AS pnl,
      avg(realized_r) FILTER (WHERE closed_at >= now() - interval '30 days')::float AS exp30
    FROM signals WHERE mode = ${mode}`)[0]!;
  return formatDaily({ mode, day, signals: s.signals, rejected: s.rejected, closed: s.closed, wins: s.wins, losses: s.losses, r: s.r, pnl: s.pnl, expectancy30d: s.exp30 });
}

bot.on("message:text", async (ctx) => {
  if (String(ctx.chat.id) !== chatId) return; // only your chat may command the engine
  const parsed = parseCommand(ctx.message.text);
  if (!parsed) return;
  try {
    switch (parsed.cmd) {
      case TelegramCommand.Help:
        return void (await ctx.reply(HELP));
      case TelegramCommand.Status:
        return void (await ctx.reply(await status(), { parse_mode: "HTML" }));
      case TelegramCommand.Pause:
        await publish("pause", { reason: "telegram" });
        return void (await ctx.reply("pause requested"));
      case TelegramCommand.Resume:
        await publish("resume", { reason: "telegram" });
        return void (await ctx.reply("resume requested"));
      case TelegramCommand.News:
        await publish(parsed.args[0] === "off" ? "news_off" : "news_on");
        return void (await ctx.reply(`news block ${parsed.args[0] === "off" ? "off" : "on"} requested`));
      case TelegramCommand.Close: {
        const target = (parsed.args[0] ?? "all").toUpperCase();
        if (target === "ALL") await publish("close_all", { reason: "telegram" });
        else {
          const rows = await sql`SELECT id FROM positions WHERE mode = ${mode} AND symbol = ${target} AND state <> 'closed'`;
          if (rows.length === 0) return void (await ctx.reply(`no open position for ${target}`));
          await publish("close_position", { position_id: rows[0]!.id, symbol: target, reason: "telegram" });
        }
        return void (await ctx.reply(`close ${target} requested`));
      }
      case TelegramCommand.Kill:
        await publish("kill", { reason: "telegram" });
        return void (await ctx.reply("kill requested"));
    }
  } catch (err) {
    log.error({ err }, "command failed");
    await ctx.reply(`error: ${String(err)}`);
  }
});

async function relayEvents() {
  const group = "telegram";
  try {
    await reader.xgroup("CREATE", STREAMS.engineEvents, group, "$", "MKSTREAM");
  } catch (err) {
    if (!String(err).includes("BUSYGROUP")) throw err;
  }
  for (;;) {
    try {
      const res = (await reader.xreadgroup("GROUP", group, "bot", "COUNT", "20", "BLOCK", "5000", "STREAMS", STREAMS.engineEvents, ">")) as
        | [string, [string, string[]][]][]
        | null;
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [id, fields] of entries) {
          const i = fields.indexOf("json");
          const parsed = i >= 0 ? EngineEventSchema.safeParse(JSON.parse(fields[i + 1]!)) : null;
          if (parsed?.success) {
            const text = formatEvent(parsed.data);
            if (text) await send(text);
          }
          await reader.xack(STREAMS.engineEvents, group, id);
        }
      }
    } catch (err) {
      log.error({ err }, "event relay error");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function scheduleDaily() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 1, 0));
  setTimeout(async () => {
    try {
      await send(await daily());
    } catch (err) {
      log.error({ err }, "daily summary failed");
    }
    scheduleDaily();
  }, next.getTime() - now.getTime());
}

await bot.api.setMyCommands([
  { command: "status", description: "engine state, open positions, today" },
  { command: "pause", description: "stop taking new signals" },
  { command: "resume", description: "allow new signals" },
  { command: "news", description: "news on|off manual block" },
  { command: "close", description: "close SYMBOL or all" },
  { command: "kill", description: "close everything and pause" },
  { command: "help", description: "list commands" },
]);
void relayEvents();
scheduleDaily();
await send(`🤖 telegram bot online (${mode})`);
log.info("telegram bot started");
bot.start();
