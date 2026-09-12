/** Pure formatting of engine events and summaries into Telegram messages (HTML parse mode). */
import type { EngineEvent } from "@trading/contracts";

export enum TelegramCommand {
  Status = "status",
  Pause = "pause",
  Resume = "resume",
  News = "news",
  Close = "close",
  Kill = "kill",
  Help = "help",
}

const money = (x: number | undefined) => (x === undefined ? "?" : x >= 1000 ? x.toFixed(1) : x.toPrecision(5));
const r = (x: number | undefined) => (x === undefined ? "?" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`);
const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function formatEvent(ev: EngineEvent): string | null {
  const tag = `<b>[${ev.mode}]</b>`;
  const sym = ev.symbol ? `${ev.symbol} ${ev.timeframe ?? ""}`.trim() : "";
  const d = (ev.detail ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "position_opened":
      return [
        `${tag} 🟢 <b>BUY signal</b> ${sym} (${esc(ev.strategy_id)})`,
        `entry ${money(ev.entry_price)}  stop ${money(ev.sl_price)}  tp1 ${money(ev.tp1_price)}  tp ${money(ev.tp_price)}`,
        `projected ${typeof d["projected_r"] === "number" ? r(d["projected_r"] as number) : "?"}${ev.reason ? `  ·  ${esc(ev.reason)}` : ""}`,
      ].join("\n");
    case "tp_partial":
      return `${tag} 🎯 TP1 hit ${sym} @ ${money(ev.price)} (sold ${ev.qty?.toPrecision(4)})`;
    case "sl_moved":
      return `${tag} 🔒 stop → ${money(ev.sl_price)} ${sym} (${esc(ev.reason)})`;
    case "tp_moved":
      return `${tag} 📈 target → ${money(ev.tp_price)} ${sym} (${esc(ev.reason)})`;
    case "position_closed": {
      const icon = (ev.r_multiple ?? 0) > 0.05 ? "✅" : (ev.r_multiple ?? 0) < -0.05 ? "❌" : "➖";
      return [
        `${tag} ${icon} <b>closed</b> ${sym} @ ${money(ev.price)} — ${esc(ev.reason)}`,
        `${r(ev.r_multiple)}  pnl ${ev.pnl?.toFixed(2)}  bars ${esc(d["bars_held"])}  mfe ${typeof d["mfe_r"] === "number" ? (d["mfe_r"] as number).toFixed(2) : "?"}R  mae ${typeof d["mae_r"] === "number" ? (d["mae_r"] as number).toFixed(2) : "?"}R`,
      ].join("\n");
    }
    case "signal_rejected":
      return `${tag} ⛔ signal rejected ${sym} (${esc(ev.strategy_id)}): ${esc(ev.reason)}${d["detail"] ? ` — ${esc(d["detail"])}` : ""}`;
    case "paused":
      return `${tag} ⏸ paused (${esc(ev.reason)})`;
    case "resumed":
      return `${tag} ▶️ resumed (${esc(ev.reason)})`;
    case "kill_switch":
      return `${tag} 🛑 <b>KILL</b>: closed ${esc(d["closed"])} position(s), engine paused`;
    case "alert":
      return `${tag} ⚠️ ${esc(ev.reason)}`;
    case "reconcile_mismatch":
      return `${tag} ⚠️ reconcile mismatch: ${esc(ev.reason)}`;
    case "risk_limit_hit":
      return `${tag} 🚧 risk limit: ${esc(ev.reason)}`;
    case "order_rejected":
      return `${tag} 🚨 <b>order problem</b> ${sym}: ${esc(ev.reason)}${ev.price ? ` @ ${money(ev.price)}` : ""}`;
    case "heartbeat":
      return null; // silent on Telegram
    default:
      return `${tag} ${esc(ev.type)} ${esc(ev.reason ?? "")}`;
  }
}

export interface StatusSnapshot {
  mode: string;
  paused: boolean;
  newsBlock: boolean;
  lastCandleAt: Date | null;
  lastHeartbeat: Date | null;
  open: { symbol: string; entry: number; sl: number; tp: number; state: string; bars: number }[];
  today: { trades: number; r: number };
}

export function formatStatus(s: StatusSnapshot, now = new Date()): string {
  const age = (d: Date | null) => (d ? `${Math.round((now.getTime() - d.getTime()) / 60000)} min ago` : "never");
  const lines = [
    `<b>[${s.mode}]</b> ${s.paused ? "⏸ paused" : "▶️ running"}${s.newsBlock ? " · 📰 news block" : ""}`,
    `last candle ${age(s.lastCandleAt)} · heartbeat ${age(s.lastHeartbeat)}`,
    `today: ${s.today.trades} closed, ${r(s.today.r)}`,
  ];
  if (s.open.length === 0) lines.push("no open positions");
  for (const p of s.open) lines.push(`• ${p.symbol} ${p.state} entry ${money(p.entry)} sl ${money(p.sl)} tp ${money(p.tp)} (${p.bars} bars)`);
  return lines.join("\n");
}

export interface DailySummary {
  mode: string;
  day: string;
  signals: number;
  rejected: number;
  closed: number;
  wins: number;
  losses: number;
  r: number;
  pnl: number;
  expectancy30d: number | null;
}

export function formatDaily(d: DailySummary): string {
  return [
    `<b>[${d.mode}] daily ${d.day}</b>`,
    `signals ${d.signals} (rejected ${d.rejected}) · closed ${d.closed}: ${d.wins}W ${d.losses}L · ${r(d.r)} · pnl ${d.pnl.toFixed(2)}`,
    `30-day expectancy ${d.expectancy30d === null ? "n/a" : r(d.expectancy30d)}`,
  ].join("\n");
}

export function parseCommand(text: string): { cmd: TelegramCommand; args: string[] } | null {
  const m = /^\/(\w+)(?:@\w+)?\s*(.*)$/.exec(text.trim());
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  if (!(Object.values(TelegramCommand) as string[]).includes(name)) return null;
  return { cmd: name as TelegramCommand, args: m[2]!.split(/\s+/).filter(Boolean) };
}

export const HELP = [
  "/status — engine state, open positions, today",
  "/pause · /resume — stop / allow new entries",
  "/news on|off — manual no-trade block",
  "/close SYMBOL|all — close position(s) at market",
  "/kill — close everything and pause",
].join("\n");
