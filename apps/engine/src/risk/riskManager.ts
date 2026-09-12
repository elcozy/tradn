/** Pre-trade checks and position sizing. Pure: all inputs are passed in, so it is trivially testable. */
import { TIMEFRAME_MS, type Signal, type Timeframe } from "@trading/contracts";
import type { AppConfig } from "../config.js";

export enum RejectReason {
  Paused = "paused",
  NewsBlock = "news_block",
  MaxOpen = "max_open",
  MaxPerSymbol = "max_per_symbol",
  Duplicate = "duplicate",
  Cooldown = "cooldown",
  DailyLoss = "daily_loss",
  Stale = "stale",
  BadGeometry = "bad_geometry",
  UnknownStrategy = "unknown_strategy",
}

export interface RiskContext {
  now: Date;
  paused: boolean;
  newsBlock: boolean;
  openPositions: { symbol: string; signal_id: string }[];
  knownSignalIds: Set<string>;
  consecutiveLosses: number;
  lastLossAt: Date | null;
  dailyR: number; // realised R so far today (UTC)
  balance: number; // quote balance used for sizing (paper.starting_balance in shadow)
}

export type RiskDecision = { ok: true; qty: number; riskAmount: number } | { ok: false; reason: RejectReason; detail?: string };

export function checkSignal(cfg: AppConfig, sig: Signal, ctx: RiskContext): RiskDecision {
  if (!cfg.strategies.some((s) => s.id === sig.strategy_id && s.enabled)) return { ok: false, reason: RejectReason.UnknownStrategy };
  if (ctx.knownSignalIds.has(sig.id)) return { ok: false, reason: RejectReason.Duplicate };
  if (ctx.paused) return { ok: false, reason: RejectReason.Paused };
  if (ctx.newsBlock) return { ok: false, reason: RejectReason.NewsBlock };
  const ageMs = ctx.now.getTime() - new Date(sig.ts).getTime();
  const maxAge = 2 * TIMEFRAME_MS[sig.timeframe as Timeframe];
  if (ageMs > maxAge) return { ok: false, reason: RejectReason.Stale, detail: `${Math.round(ageMs / 60000)} min old` };
  const risk = sig.entry.price - sig.stop_price;
  if (risk <= 0 || sig.tp_price <= sig.entry.price) return { ok: false, reason: RejectReason.BadGeometry };
  if (ctx.openPositions.length >= cfg.risk.max_open) return { ok: false, reason: RejectReason.MaxOpen };
  if (ctx.openPositions.filter((p) => p.symbol === sig.symbol).length >= cfg.risk.max_per_symbol)
    return { ok: false, reason: RejectReason.MaxPerSymbol };
  const dailyLimitR = -(cfg.risk.daily_loss_pct / cfg.risk.per_trade_pct);
  if (ctx.dailyR <= dailyLimitR) return { ok: false, reason: RejectReason.DailyLoss, detail: `${ctx.dailyR.toFixed(2)}R today` };
  if (ctx.consecutiveLosses >= cfg.risk.consecutive_loss_cooldown && ctx.lastLossAt) {
    const until = ctx.lastLossAt.getTime() + cfg.risk.cooldown_minutes * 60_000;
    if (ctx.now.getTime() < until) return { ok: false, reason: RejectReason.Cooldown, detail: `until ${new Date(until).toISOString()}` };
  }
  const targetRisk = (ctx.balance * cfg.risk.per_trade_pct) / 100;
  let qty = targetRisk / risk;
  const notionalCap = (ctx.balance * cfg.risk.notional_cap_pct) / 100;
  // Spot, no leverage: notional cannot exceed the cap, so effective risk = min(target, cap * stop distance).
  if (qty * sig.entry.price > notionalCap) qty = notionalCap / sig.entry.price;
  return { ok: true, qty, riskAmount: qty * risk };
}
