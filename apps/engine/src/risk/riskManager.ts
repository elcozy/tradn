/** Pre-trade checks and position sizing. Pure: all inputs are passed in, so it is trivially testable. */
import { TIMEFRAME_MS, type Signal, type Timeframe } from "@trading/contracts";
import type { AppConfig } from "../config.js";
import { MinimumViolation, applyFilters, type SymbolFilters } from "../execution/precision.js";

export enum RejectReason {
  Paused = "paused",
  NewsBlock = "news_block",
  EntriesDisabled = "entries_disabled",
  MaxOpen = "max_open",
  MaxPerSymbol = "max_per_symbol",
  Duplicate = "duplicate",
  Cooldown = "cooldown",
  DailyLoss = "daily_loss",
  Stale = "stale",
  BadGeometry = "bad_geometry",
  UnknownStrategy = "unknown_strategy",
  BelowMinimum = "below_minimum",
  /** Next-open fill would already be beyond the stop or the target (paper, same rule as the backtester). */
  GapAtFill = "gap_at_fill",
}

export interface RiskContext {
  now: Date;
  paused: boolean;
  newsBlock: boolean;
  /** M7 live safety gate; undefined means enabled. */
  entriesEnabled?: boolean;
  openPositions: { symbol: string; signal_id: string }[];
  knownSignalIds: Set<string>;
  consecutiveLosses: number;
  lastLossAt: Date | null;
  dailyR: number; // realised R so far today (UTC)
  balance: number; // equity used for sizing (paper.starting_balance in shadow, the wallet in paper and up)
  filters?: SymbolFilters; // exchange step/tick/minimums for the signal's symbol, when known
}

export type Sizing = { ok: true; qty: number; riskAmount: number } | { ok: false; reason: RejectReason.BelowMinimum; detail: string };

/**
 * Quantity = risk% of equity / stop distance, capped at the notional cap, rounded down to the step.
 * Spot has no leverage, so effective risk = min(target, cap * stop distance); the caller journals the capped amount.
 */
export function sizePosition(cfg: AppConfig, balance: number, entry: number, stop: number, filters?: SymbolFilters): Sizing {
  const risk = entry - stop;
  const targetRisk = (balance * cfg.risk.per_trade_pct) / 100;
  let qty = targetRisk / risk;
  const notionalCap = (balance * cfg.risk.notional_cap_pct) / 100;
  if (qty * entry > notionalCap) qty = notionalCap / entry;
  const { qty: rounded, violation } = applyFilters(qty, entry, filters);
  if (violation === MinimumViolation.Quantity) return { ok: false, reason: RejectReason.BelowMinimum, detail: `qty ${rounded} < minQty ${filters!.minQty}` };
  if (violation === MinimumViolation.Notional)
    return { ok: false, reason: RejectReason.BelowMinimum, detail: `notional ${(rounded * entry).toFixed(2)} < minNotional ${filters!.minNotional}` };
  return { ok: true, qty: rounded, riskAmount: rounded * risk };
}

export type RiskDecision = { ok: true; qty: number; riskAmount: number } | { ok: false; reason: RejectReason; detail?: string };

export function checkSignal(cfg: AppConfig, sig: Signal, ctx: RiskContext): RiskDecision {
  if (!cfg.strategies.some((s) => s.id === sig.strategy_id && s.enabled)) return { ok: false, reason: RejectReason.UnknownStrategy };
  if (ctx.knownSignalIds.has(sig.id)) return { ok: false, reason: RejectReason.Duplicate };
  if (ctx.paused) return { ok: false, reason: RejectReason.Paused };
  if (ctx.newsBlock) return { ok: false, reason: RejectReason.NewsBlock };
  if (ctx.entriesEnabled === false) return { ok: false, reason: RejectReason.EntriesDisabled };
  const ageMs = ctx.now.getTime() - new Date(sig.ts).getTime();
  const maxAge = 2 * TIMEFRAME_MS[sig.timeframe as Timeframe];
  if (ageMs > maxAge) return { ok: false, reason: RejectReason.Stale, detail: `${Math.round(ageMs / 60000)} min old` };
  const risk = sig.entry.price - sig.stop_price;
  if (risk <= 0 || sig.tp_price <= sig.entry.price) return { ok: false, reason: RejectReason.BadGeometry };
  if (ctx.openPositions.length >= cfg.risk.max_open) return { ok: false, reason: RejectReason.MaxOpen };
  if (ctx.openPositions.filter((p) => p.symbol === sig.symbol).length >= cfg.risk.max_per_symbol)
    return { ok: false, reason: RejectReason.MaxPerSymbol };
  if (ctx.dailyR <= dailyLossLimitR(cfg)) return { ok: false, reason: RejectReason.DailyLoss, detail: `${ctx.dailyR.toFixed(2)}R today` };
  if (ctx.consecutiveLosses >= cfg.risk.consecutive_loss_cooldown && ctx.lastLossAt) {
    const until = ctx.lastLossAt.getTime() + cfg.risk.cooldown_minutes * 60_000;
    if (ctx.now.getTime() < until) return { ok: false, reason: RejectReason.Cooldown, detail: `until ${new Date(until).toISOString()}` };
  }
  return sizePosition(cfg, ctx.balance, sig.entry.price, sig.stop_price, ctx.filters);
}

/** Daily loss limit expressed in R (3% / 1% per trade = -3R). */
export function dailyLossLimitR(cfg: AppConfig): number {
  return -(cfg.risk.daily_loss_pct / cfg.risk.per_trade_pct);
}
