/**
 * Exit policy: SL/TP with breakeven, partial TP1, ATR trailing stop and TP ratchet.
 *
 * PORT of services/research/research/exit_policy.py. Both must produce identical event streams on
 * services/research/tests/fixtures/exit_policy_case_*.json (see test/exitPolicy.test.ts).
 * Change one -> change both -> run both suites.
 *
 * Evaluated once per CLOSED candle, worst-case ordering (stop before take-profit in the same bar).
 * Long-only until futures.
 */
import type { ExitParams } from "../config.js";

export enum ExitState {
  Open = "open",
  Breakeven = "breakeven",
  Trailing = "trailing",
  Closed = "closed",
}

export enum ExitEventType {
  TpPartial = "tp_partial",
  SlMoved = "sl_moved",
  TpMoved = "tp_moved",
  Closed = "closed",
}

/** Why a position closed or a stop/target moved. String values match the Python side and the journal. */
export enum ExitReason {
  Stop = "stop",
  TakeProfit = "take_profit",
  Time = "time",
  Breakeven = "breakeven",
  Trailing = "trailing",
  Ratchet = "ratchet",
  Regime = "regime",
  Manual = "manual",
  Kill = "kill",
  End = "end",
}

export interface ExitEvent {
  bar: number;
  type: ExitEventType;
  price?: number;
  qty?: number;
  reason?: ExitReason | string;
}

export interface PositionState {
  entry: number;
  qty: number;
  sl_initial: number;
  sl: number;
  tp: number;
  tp1: number | null;
  remaining_qty: number;
  highest_high: number;
  lowest_low: number;
  tp1_done: boolean;
  state: ExitState;
  bars: number;
  events: ExitEvent[];
}

export interface Bar {
  high: number;
  low: number;
  close: number;
  atr: number;
}

const r8 = (x: number) => Math.round(x * 1e8) / 1e8;

export const risk = (p: PositionState) => p.entry - p.sl_initial;
export const mfeR = (p: PositionState) => (p.highest_high - p.entry) / risk(p);
export const maeR = (p: PositionState) => (p.entry - p.lowest_low) / risk(p);

export function openPosition(
  entry: number,
  qty: number,
  sl: number,
  tp: number,
  params: ExitParams,
  tp1: number | null = null,
): PositionState {
  const r = entry - sl;
  if (r <= 0) throw new Error("stop must be below entry for a long");
  if (tp <= entry) throw new Error("take-profit must be above entry for a long");
  return {
    entry,
    qty,
    sl_initial: sl,
    sl,
    tp,
    tp1: tp1 ?? entry + params.tp1_r * r,
    remaining_qty: qty,
    highest_high: entry,
    lowest_low: entry,
    tp1_done: false,
    state: ExitState.Open,
    bars: 0,
    events: [],
  };
}

/** Advance one closed bar. Mutates pos; returns this bar's events (also appended to pos.events). */
export function step(pos: PositionState, bar: Bar, params: ExitParams): ExitEvent[] {
  if (pos.state === ExitState.Closed) return [];
  const events: ExitEvent[] = [];
  pos.bars += 1;
  const r = risk(pos);
  pos.highest_high = Math.max(pos.highest_high, bar.high);
  pos.lowest_low = Math.min(pos.lowest_low, bar.low);

  const emit = (ev: Omit<ExitEvent, "bar">) => {
    const full: ExitEvent = { bar: pos.bars, ...ev };
    if (full.price !== undefined) full.price = r8(full.price);
    if (full.qty !== undefined) full.qty = r8(full.qty);
    events.push(full);
    pos.events.push(full);
  };
  const close = (reason: ExitReason, price: number) => {
    emit({ type: ExitEventType.Closed, reason, price, qty: pos.remaining_qty });
    pos.remaining_qty = 0;
    pos.state = ExitState.Closed;
    return events;
  };

  // 1) Hard stop first (worst case).
  if (bar.low <= pos.sl) return close(ExitReason.Stop, pos.sl);

  // 2) Partial take-profit.
  if (!pos.tp1_done && pos.tp1 !== null && bar.high >= pos.tp1) {
    const sell = r8(pos.qty * params.tp1_fraction);
    pos.remaining_qty = r8(pos.remaining_qty - sell);
    pos.tp1_done = true;
    emit({ type: ExitEventType.TpPartial, price: pos.tp1, qty: sell });
    if (pos.remaining_qty <= 0) return close(ExitReason.TakeProfit, pos.tp1);
  }

  // 3) Final take-profit.
  if (bar.high >= pos.tp) return close(ExitReason.TakeProfit, pos.tp);

  // 4) Time stop.
  if (params.max_bars != null && pos.bars >= params.max_bars) return close(ExitReason.Time, bar.close);

  // 5) Breakeven once the close reaches +breakeven_r.
  if (pos.state === ExitState.Open && bar.close >= pos.entry + params.breakeven_r * r) {
    const be = pos.entry * (1 + (2 * params.fee_pct) / 100);
    if (be > pos.sl) {
      pos.sl = be;
      emit({ type: ExitEventType.SlMoved, price: pos.sl, reason: ExitReason.Breakeven });
    }
    pos.state = ExitState.Breakeven;
  }

  // 6) Trailing after TP1 (or after breakeven when there is no TP1).
  if (pos.tp1_done || (pos.tp1 === null && pos.state === ExitState.Breakeven)) pos.state = ExitState.Trailing;
  if (pos.state === ExitState.Trailing) {
    const newSl = pos.highest_high - params.trail_atr_k * bar.atr;
    if (newSl > pos.sl) {
      pos.sl = newSl;
      emit({ type: ExitEventType.SlMoved, price: pos.sl, reason: ExitReason.Trailing });
    }
    const newTp = pos.highest_high + params.tp_ratchet_atr * bar.atr;
    if (newTp > pos.tp) {
      pos.tp = newTp;
      emit({ type: ExitEventType.TpMoved, price: pos.tp, reason: ExitReason.Ratchet });
    }
  }
  return events;
}

/** Close outside the bar loop (regime invalidation, manual, kill). */
export function closeManual(pos: PositionState, price: number, reason: string): ExitEvent[] {
  if (pos.state === ExitState.Closed) return [];
  const ev: ExitEvent = { bar: pos.bars, type: ExitEventType.Closed, reason, price: r8(price), qty: r8(pos.remaining_qty) };
  pos.events.push(ev);
  pos.remaining_qty = 0;
  pos.state = ExitState.Closed;
  return [ev];
}

/** [realized_r, fees_in_r]; fees on entry and on every exit fill. */
export function realizedR(pos: PositionState, feePct: number): [number, number] {
  const r = risk(pos);
  let pnl = 0;
  let fees = (pos.entry * pos.qty * feePct) / 100;
  for (const ev of pos.events) {
    if (ev.type === ExitEventType.TpPartial || ev.type === ExitEventType.Closed) {
      pnl += (ev.price! - pos.entry) * ev.qty!;
      fees += (ev.price! * ev.qty! * feePct) / 100;
    }
  }
  const perR = r * pos.qty;
  return [(pnl - fees) / perR, fees / perR];
}
