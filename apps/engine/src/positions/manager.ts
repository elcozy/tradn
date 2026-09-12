/**
 * PositionManager: opens positions from accepted signals, steps the exit policy on every closed
 * candle of the position's timeframe, applies regime invalidation on regime-timeframe closes,
 * persists every change, emits events and writes the outcome back to the signal journal.
 * Works for shadow and (later) paper/testnet/live via the ExchangeAdapter.
 */
import type { Signal } from "@trading/contracts";
import { ExitParamsSchema, type AppConfig, type ExitParams } from "../config.js";
import type { Candle } from "../db.js";
import { EngineEventType, type EventSink } from "../events.js";
import type { ExchangeAdapter } from "../execution/adapter.js";
import { atr as wilderAtr } from "../indicators.js";
import { log } from "../log.js";
import { checkSignal, type RiskContext } from "../risk/riskManager.js";
import {
  ExitEventType,
  ExitReason,
  ExitState,
  closeManual,
  maeR,
  mfeR,
  openPosition,
  realizedR,
  step,
  type ExitEvent,
} from "./exitPolicy.js";
import type { Outcome, PositionRecord, PositionStore } from "./store.js";

const ATR_BARS = 600;
const BREAKEVEN_BAND = 0.05;

export function outcomeOf(r: number): Outcome["outcome"] {
  return r > BREAKEVEN_BAND ? "win" : r < -BREAKEVEN_BAND ? "loss" : "breakeven";
}

export function closeReasonOf(p: PositionRecord): string {
  const last = p.state.events[p.state.events.length - 1];
  if (!last || last.type !== ExitEventType.Closed) return "open";
  if (last.reason === ExitReason.Stop) return p.state.sl > p.state.sl_initial ? "trailing" : "stop";
  return String(last.reason);
}

export class PositionManager {
  private open = new Map<string, PositionRecord>();

  constructor(
    private cfg: AppConfig,
    private store: PositionStore,
    private events: EventSink,
    private adapter: ExchangeAdapter,
    private now: () => Date = () => new Date(),
  ) {}

  get openPositions(): PositionRecord[] {
    return [...this.open.values()];
  }

  async restore(): Promise<number> {
    for (const p of await this.store.loadOpen()) this.open.set(p.id, p);
    if (this.open.size) log.info({ ids: [...this.open.keys()] }, "restored open positions");
    return this.open.size;
  }

  /** Risk-check and open a position for a signal. Returns the position id or null when rejected. */
  async handleSignal(sig: Signal, flags: { paused: boolean; newsBlock: boolean }): Promise<string | null> {
    const history = await this.store.recentOutcomes();
    const today = this.now().toISOString().slice(0, 10);
    let consecutiveLosses = 0;
    for (const h of history) {
      if (h.realized_r < -BREAKEVEN_BAND) consecutiveLosses += 1;
      else break;
    }
    const ctx: RiskContext = {
      now: this.now(),
      paused: flags.paused,
      newsBlock: flags.newsBlock,
      openPositions: this.openPositions.map((p) => ({ symbol: p.symbol, signal_id: p.signal_id })),
      knownSignalIds: new Set([...this.openPositions.map((p) => p.signal_id), ...((await this.store.signalExists(sig.id)) ? [sig.id] : [])]),
      consecutiveLosses,
      lastLossAt: history.find((h) => h.realized_r < -BREAKEVEN_BAND)?.closed_at ?? null,
      dailyR: history.filter((h) => h.closed_at.toISOString().slice(0, 10) === today).reduce((a, h) => a + h.realized_r, 0),
      balance: this.cfg.paper.starting_balance,
    };
    const decision = checkSignal(this.cfg, sig, ctx);
    if (!decision.ok) {
      await this.store.markSignalRejected(sig.id, decision.reason);
      await this.events.emit({
        type: EngineEventType.SignalRejected,
        signal_id: sig.id,
        strategy_id: sig.strategy_id,
        symbol: sig.symbol,
        timeframe: sig.timeframe,
        reason: decision.reason,
        detail: decision.detail ? { detail: decision.detail } : undefined,
      });
      return null;
    }

    const inst = this.cfg.strategies.find((s) => s.id === sig.strategy_id)!;
    const exit: ExitParams = ExitParamsSchema.parse({ ...inst.exit, ...(sig.exit ?? {}) });
    const fill = await this.adapter.openLong(sig, decision.qty);
    const state = openPosition(fill.price, fill.qty, sig.stop_price, sig.tp_price, exit, sig.tp1_price ?? null);
    const rec: PositionRecord = {
      id: `pos:${sig.id}`,
      signal_id: sig.id,
      strategy_id: sig.strategy_id,
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      regime_tf: inst.regime_tf,
      invalidation_level: typeof sig.meta?.["invalidation_level"] === "number" ? (sig.meta["invalidation_level"] as number) : null,
      risk_amount: decision.riskAmount,
      fee_pct: exit.fee_pct,
      exit_params: exit,
      opened_at: fill.ts,
      state,
    };
    await this.store.insert(rec);
    await this.store.markSignalAccepted(sig.id, rec.id, fill.price, ((fill.price - sig.entry.price) / sig.entry.price) * 100);
    await this.adapter.protect(rec.symbol, state.qty, state.sl, state.tp);
    this.open.set(rec.id, rec);
    await this.events.emit({
      type: EngineEventType.PositionOpened,
      position_id: rec.id,
      signal_id: sig.id,
      strategy_id: sig.strategy_id,
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      entry_price: fill.price,
      sl_price: state.sl,
      tp1_price: state.tp1 ?? undefined,
      tp_price: state.tp,
      qty: state.qty,
      reason: typeof sig.meta?.["level"] === "number" ? `level ${sig.meta["level"]}` : undefined,
      detail: { projected_r: (sig.tp_price - fill.price) / (fill.price - sig.stop_price), meta: sig.meta ?? {} },
    });
    return rec.id;
  }

  /** Called for every closed candle of any configured symbol/timeframe. */
  async onCandleClosed(c: Candle): Promise<void> {
    for (const p of this.openPositions) {
      if (p.symbol !== c.symbol) continue;
      if (c.timeframe === p.regime_tf && p.invalidation_level !== null && c.close < p.invalidation_level) {
        closeManual(p.state, c.close, ExitReason.Regime);
        await this.finish(p, c);
        continue;
      }
      if (c.timeframe !== p.timeframe) continue;
      const candles = await this.store.recentCandles(p.symbol, p.timeframe, ATR_BARS);
      const atrLen = Number((this.cfg.strategies.find((s) => s.id === p.strategy_id)?.params["atr_len"] as number | undefined) ?? 14);
      const atr = candles.length ? wilderAtr(candles, atrLen) : c.high - c.low;
      const evs = step(p.state, { high: c.high, low: c.low, close: c.close, atr }, p.exit_params as ExitParams);
      if (p.state.state === ExitState.Closed) {
        await this.finish(p, c, evs);
      } else {
        await this.store.update(p);
        await this.adapter.protect(p.symbol, p.state.remaining_qty, p.state.sl, p.state.tp);
        for (const ev of evs) await this.emitExitEvent(p, ev);
      }
    }
  }

  /** Close every open position (or one) at the latest close price. */
  async closeAll(reason: ExitReason.Manual | ExitReason.Kill, positionId?: string): Promise<number> {
    let n = 0;
    for (const p of this.openPositions) {
      if (positionId && p.id !== positionId) continue;
      const last = (await this.store.recentCandles(p.symbol, p.timeframe, 1))[0];
      const price = last?.close ?? p.state.entry;
      closeManual(p.state, price, reason);
      await this.finish(p, last ?? null);
      n += 1;
    }
    return n;
  }

  private async emitExitEvent(p: PositionRecord, ev: ExitEvent): Promise<void> {
    const base = { position_id: p.id, signal_id: p.signal_id, strategy_id: p.strategy_id, symbol: p.symbol, timeframe: p.timeframe };
    if (ev.type === ExitEventType.SlMoved)
      await this.events.emit({ type: EngineEventType.SlMoved, ...base, sl_price: ev.price, reason: String(ev.reason) });
    else if (ev.type === ExitEventType.TpMoved)
      await this.events.emit({ type: EngineEventType.TpMoved, ...base, tp_price: ev.price, reason: String(ev.reason) });
    else if (ev.type === ExitEventType.TpPartial)
      await this.events.emit({ type: EngineEventType.TpPartial, ...base, price: ev.price, qty: ev.qty });
  }

  private async finish(p: PositionRecord, c: Candle | null, evs: ExitEvent[] = []): Promise<void> {
    const [r, feesR] = realizedR(p.state, p.fee_pct);
    const last = p.state.events[p.state.events.length - 1]!;
    const closedAt = c ? new Date(c.openTime.getTime() + this.tfMs(c.timeframe)) : this.now();
    const o: Outcome = {
      outcome: outcomeOf(r),
      exit_price: last.price!,
      realized_r: r,
      realized_pnl: r * p.risk_amount,
      fees: feesR * p.risk_amount,
      mfe_r: mfeR(p.state),
      mae_r: maeR(p.state),
      bars_held: p.state.bars,
      duration_s: Math.round((closedAt.getTime() - p.opened_at.getTime()) / 1000),
      close_reason: closeReasonOf(p),
      closed_at: closedAt,
    };
    for (const ev of evs) if (ev.type !== ExitEventType.Closed) await this.emitExitEvent(p, ev);
    await this.store.close(p, o);
    this.open.delete(p.id);
    await this.events.emit({
      type: EngineEventType.PositionClosed,
      position_id: p.id,
      signal_id: p.signal_id,
      strategy_id: p.strategy_id,
      symbol: p.symbol,
      timeframe: p.timeframe,
      price: o.exit_price,
      pnl: o.realized_pnl,
      r_multiple: o.realized_r,
      reason: o.close_reason,
      detail: { outcome: o.outcome, bars_held: o.bars_held, duration_s: o.duration_s, mfe_r: o.mfe_r, mae_r: o.mae_r },
    });
  }

  private tfMs(tf: string): number {
    const m = /^(\d+)([mhd])$/.exec(tf);
    if (!m) return 0;
    const n = Number(m[1]);
    return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
  }
}
