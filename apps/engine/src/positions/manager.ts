/**
 * PositionManager: opens positions from accepted signals, steps the exit policy on every closed
 * candle of the position's timeframe, applies regime invalidation on regime-timeframe closes,
 * persists every change, emits events and writes the outcome back to the signal journal.
 *
 * Works for every mode through the ExchangeAdapter:
 * - immediate adapters (shadow, testnet, live) fill when the signal arrives
 * - next-open adapters (paper) park a PENDING record and fill at the open of the next candle of the
 *   entry timeframe, then step the exit policy over that same candle — exactly like the backtester
 * Exit fills (TP1 partial, stop, target, manual) go through the adapter too, so a wallet or an
 * exchange sees every sell; shadow ignores them.
 */
import type { Signal } from "@trading/contracts";
import { ExitParamsSchema, type AppConfig, type ExitParams } from "../config.js";
import type { Candle } from "../db.js";
import { EngineEventType, type EventSink } from "../events.js";
import { EntryTiming, type ExchangeAdapter, type Fill, type ForcedClose } from "../execution/adapter.js";
import type { SymbolFilters } from "../execution/precision.js";
import type { EquitySnapshot, Wallet } from "../execution/wallet.js";
import { atr as wilderAtr } from "../indicators.js";
import { log } from "../log.js";
import { RejectReason, checkSignal, dailyLossLimitR, sizePosition, type RiskContext } from "../risk/riskManager.js";
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
import { RiskEventType, type Outcome, type PositionRecord, type PositionStore } from "./store.js";

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

export interface EngineFlagsInput {
  paused: boolean;
  newsBlock: boolean;
  entriesEnabled?: boolean;
}

export interface ManagerOptions {
  /** Paper wallet (and up): sizing uses its equity and every fill moves cash. Absent in shadow. */
  wallet?: Wallet | null;
  /** Exchange precision per symbol; absent -> unrounded sizing. */
  filters?: Map<string, SymbolFilters>;
}

export class PositionManager {
  private open = new Map<string, PositionRecord>();
  private wallet: Wallet | null;
  private filters: Map<string, SymbolFilters>;

  constructor(
    private cfg: AppConfig,
    private store: PositionStore,
    private events: EventSink,
    private adapter: ExchangeAdapter,
    private now: () => Date = () => new Date(),
    opts: ManagerOptions = {},
  ) {
    this.wallet = opts.wallet ?? null;
    this.filters = opts.filters ?? new Map();
  }

  /** Every record the manager tracks, including pending (unfilled) entries. */
  get openPositions(): PositionRecord[] {
    return [...this.open.values()];
  }

  /** Filled positions only. */
  get activePositions(): PositionRecord[] {
    return this.openPositions.filter((p) => !p.pending);
  }

  async restore(): Promise<number> {
    for (const p of await this.store.loadOpen()) this.open.set(p.id, p);
    if (this.open.size) log.info({ ids: [...this.open.keys()] }, "restored open positions");
    return this.open.size;
  }

  /** Equity used for sizing: the wallet's cash plus open cost in paper and up; the configured balance in shadow. */
  private sizingBalance(): number {
    return this.wallet ? this.wallet.equity(this.openCost()) : this.cfg.paper.starting_balance;
  }

  private openCost(): number {
    return this.activePositions.reduce((a, p) => a + p.state.remaining_qty * p.state.entry, 0);
  }

  /** Risk-check a signal; open (immediate) or park (next open) a position. Returns the position id or null when rejected. */
  async handleSignal(sig: Signal, flags: EngineFlagsInput): Promise<string | null> {
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
      entriesEnabled: flags.entriesEnabled,
      openPositions: this.openPositions.map((p) => ({ symbol: p.symbol, signal_id: p.signal_id })),
      knownSignalIds: new Set([...this.openPositions.map((p) => p.signal_id), ...((await this.store.signalExists(sig.id)) ? [sig.id] : [])]),
      consecutiveLosses,
      lastLossAt: history.find((h) => h.realized_r < -BREAKEVEN_BAND)?.closed_at ?? null,
      dailyR: history.filter((h) => h.closed_at.toISOString().slice(0, 10) === today).reduce((a, h) => a + h.realized_r, 0),
      balance: this.sizingBalance(),
      filters: this.filters.get(sig.symbol),
    };
    const decision = checkSignal(this.cfg, sig, ctx);
    if (!decision.ok) {
      await this.reject(sig, decision.reason, decision.detail);
      return null;
    }

    const inst = this.cfg.strategies.find((s) => s.id === sig.strategy_id)!;
    const exit: ExitParams = ExitParamsSchema.parse({ ...inst.exit, ...(sig.exit ?? {}) });
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
      fees_paid: 0,
      exit_params: exit,
      opened_at: this.now(),
      // placeholder state until filled; qty is the planned size
      state: openPosition(sig.entry.price, decision.qty, sig.stop_price, sig.tp_price, exit, sig.tp1_price ?? null),
      pending: { signal: sig },
    };

    if (this.adapter.entryTiming === EntryTiming.NextOpen) {
      await this.store.insert(rec);
      this.open.set(rec.id, rec);
      log.info({ position: rec.id, qty: decision.qty }, "entry pending: fills at the next candle open");
      return rec.id;
    }

    const fill = await this.adapter.openLong({ signal: sig, positionId: rec.id, qty: decision.qty, refPrice: sig.entry.price, feePct: exit.fee_pct });
    await this.activate(rec, fill, true);
    return rec.id;
  }

  private async reject(sig: Signal, reason: RejectReason | string, detail?: string): Promise<void> {
    await this.store.markSignalRejected(sig.id, reason);
    await this.events.emit({
      type: EngineEventType.SignalRejected,
      signal_id: sig.id,
      strategy_id: sig.strategy_id,
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      reason,
      detail: detail ? { detail } : undefined,
    });
  }

  /** Turn a (pending or fresh) record into a live position from its entry fill. */
  private async activate(rec: PositionRecord, fill: Fill, insert: boolean): Promise<void> {
    const sig = rec.pending!.signal;
    const exit = rec.exit_params as ExitParams;
    rec.state = openPosition(fill.price, fill.qty, sig.stop_price, sig.tp_price, exit, sig.tp1_price ?? null);
    rec.risk_amount = (fill.price - sig.stop_price) * fill.qty;
    rec.fees_paid = fill.fee;
    rec.opened_at = fill.ts;
    rec.pending = null;
    if (insert) await this.store.insert(rec);
    else await this.store.update(rec);
    await this.store.markSignalAccepted(sig.id, rec.id, fill.price, ((fill.price - sig.entry.price) / sig.entry.price) * 100);
    await this.protect(rec);
    this.open.set(rec.id, rec);
    await this.events.emit({
      type: EngineEventType.PositionOpened,
      position_id: rec.id,
      signal_id: sig.id,
      strategy_id: sig.strategy_id,
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      entry_price: fill.price,
      sl_price: rec.state.sl,
      tp1_price: rec.state.tp1 ?? undefined,
      tp_price: rec.state.tp,
      qty: rec.state.qty,
      reason: typeof sig.meta?.["level"] === "number" ? `level ${sig.meta["level"]}` : undefined,
      detail: {
        projected_r: (sig.tp_price - fill.price) / (fill.price - sig.stop_price),
        risk_amount: rec.risk_amount,
        fee: fill.fee,
        meta: sig.meta ?? {},
      },
    });
  }

  /** Fill a pending entry at this candle's open (paper). Returns false when the entry was cancelled. */
  private async fillPending(p: PositionRecord, c: Candle): Promise<boolean> {
    const sig = p.pending!.signal;
    const expected = this.adapter.quoteEntry(c.open);
    if (expected <= sig.stop_price || expected >= sig.tp_price)
      return this.cancelPending(p, RejectReason.GapAtFill, `open ${c.open} vs stop ${sig.stop_price} / tp ${sig.tp_price}`);
    const sizing = sizePosition(this.cfg, this.sizingBalance(), c.open, sig.stop_price, this.filters.get(sig.symbol));
    if (!sizing.ok) return this.cancelPending(p, sizing.reason, sizing.detail);
    const fill = await this.adapter.openLong({ signal: sig, positionId: p.id, qty: sizing.qty, refPrice: c.open, feePct: p.fee_pct });
    await this.activate(p, fill, false);
    return true;
  }

  private async cancelPending(p: PositionRecord, reason: string, detail?: string): Promise<false> {
    this.open.delete(p.id);
    await this.store.cancelPending(p, reason);
    const sig = p.pending!.signal;
    await this.events.emit({
      type: EngineEventType.SignalRejected,
      signal_id: sig.id,
      strategy_id: sig.strategy_id,
      symbol: sig.symbol,
      timeframe: sig.timeframe,
      reason,
      detail: detail ? { detail } : undefined,
    });
    return false;
  }

  private protect(p: PositionRecord): Promise<void> {
    const s = p.state;
    const fraction = (p.exit_params as ExitParams).tp1_fraction;
    const tp1Qty = s.tp1 === null ? null : Math.round(s.qty * fraction * 1e8) / 1e8;
    return this.adapter.protect({ positionId: p.id, symbol: p.symbol, qty: s.remaining_qty, stop: s.sl, tp: s.tp, tp1: s.tp1, tp1Qty, tp1Done: s.tp1_done });
  }

  /** Reconciliation found a position without exchange-side protection: place it again. */
  async reprotect(positionId: string): Promise<boolean> {
    const p = this.open.get(positionId);
    if (!p || p.pending) return false;
    await this.protect(p);
    return true;
  }

  /** The adapter sold a position on its own (protection failed three times, stop already breached). */
  async forceClose(fc: ForcedClose): Promise<boolean> {
    const p = this.open.get(fc.positionId);
    if (!p || p.pending) return false;
    const evs = closeManual(p.state, fc.fill.price, fc.reason);
    p.fees_paid += fc.fill.fee;
    await this.finish(p, null, evs);
    return true;
  }

  /** Called for every closed candle of any configured symbol/timeframe. */
  async onCandleClosed(c: Candle): Promise<void> {
    for (const p of this.openPositions) {
      if (p.symbol !== c.symbol) continue;
      if (p.pending) {
        if (c.timeframe !== p.timeframe) continue;
        if (!(await this.fillPending(p, c))) continue;
        // fall through: the fill candle is also the first bar the exit policy sees (as in the backtester)
      } else if (c.timeframe === p.regime_tf && p.invalidation_level !== null && c.close < p.invalidation_level) {
        const evs = closeManual(p.state, c.close, ExitReason.Regime);
        await this.settleExits(p, evs);
        await this.finish(p, c);
        continue;
      }
      if (c.timeframe !== p.timeframe) continue;
      const candles = await this.store.recentCandles(p.symbol, p.timeframe, ATR_BARS);
      const atrLen = Number((this.cfg.strategies.find((s) => s.id === p.strategy_id)?.params["atr_len"] as number | undefined) ?? 14);
      const atr = candles.length ? wilderAtr(candles, atrLen) : c.high - c.low;
      const evs = step(p.state, { high: c.high, low: c.low, close: c.close, atr }, p.exit_params as ExitParams);
      await this.settleExits(p, evs);
      if (p.state.state === ExitState.Closed) {
        await this.finish(p, c, evs);
      } else {
        await this.store.update(p);
        await this.protect(p);
        for (const ev of evs) await this.emitExitEvent(p, ev);
      }
    }
  }

  /** Close every open position (or one) at the latest close price; pending entries are cancelled. */
  async closeAll(reason: ExitReason.Manual | ExitReason.Kill, positionId?: string): Promise<number> {
    let n = 0;
    for (const p of this.openPositions) {
      if (positionId && p.id !== positionId) continue;
      if (p.pending) {
        await this.cancelPending(p, reason);
        n += 1;
        continue;
      }
      const last = (await this.store.recentCandles(p.symbol, p.timeframe, 1))[0];
      const price = last?.close ?? p.state.entry;
      const evs = closeManual(p.state, price, reason);
      await this.settleExits(p, evs);
      await this.finish(p, last ?? null);
      n += 1;
    }
    return n;
  }

  /** Every sell the exit policy decided (partial TP1, stop, target, manual close) goes through the adapter. */
  private async settleExits(p: PositionRecord, evs: ExitEvent[]): Promise<void> {
    for (const ev of evs) {
      if ((ev.type !== ExitEventType.TpPartial && ev.type !== ExitEventType.Closed) || !ev.qty || ev.price === undefined) continue;
      const fill = await this.adapter.closeLong({
        positionId: p.id,
        symbol: p.symbol,
        qty: ev.qty,
        refPrice: ev.price,
        feePct: p.fee_pct,
        reason: String(ev.reason ?? ev.type),
      });
      p.fees_paid += fill.fee;
      // exchange fills can differ from the policy price (slippage on a market close): journal what really happened
      if (fill.price !== ev.price) ev.price = fill.price;
    }
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
    await this.adapter.release(p.id);
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
      detail: { outcome: o.outcome, bars_held: o.bars_held, duration_s: o.duration_s, mfe_r: o.mfe_r, mae_r: o.mae_r, fees_paid: p.fees_paid },
    });
    await this.checkRiskLimits(o.closed_at);
    await this.snapshotEquity(o.closed_at);
  }

  /**
   * After a close: if the daily-loss limit or the consecutive-loss cooldown has just been reached, record a
   * risk_events row and emit risk_limit_hit once. Enforcement itself happens per signal in checkSignal.
   */
  private async checkRiskLimits(closedAt: Date): Promise<void> {
    const history = await this.store.recentOutcomes();
    const day = closedAt.toISOString().slice(0, 10);
    const dailyR = history.filter((h) => h.closed_at.toISOString().slice(0, 10) === day).reduce((a, h) => a + h.realized_r, 0);
    const limitR = dailyLossLimitR(this.cfg);
    if (dailyR <= limitR) {
      const last = await this.store.lastRiskEventAt(RiskEventType.DailyLoss);
      if (!last || last.toISOString().slice(0, 10) !== day) {
        const detail = { daily_r: dailyR, limit_r: limitR, day };
        await this.store.insertRiskEvent(RiskEventType.DailyLoss, detail);
        await this.events.emit({
          type: EngineEventType.RiskLimitHit,
          reason: `daily loss ${dailyR.toFixed(2)}R reached the ${limitR}R limit; no new entries until the next UTC day`,
          detail,
        });
      }
    }
    let consecutive = 0;
    for (const h of history) {
      if (h.realized_r < -BREAKEVEN_BAND) consecutive += 1;
      else break;
    }
    if (consecutive >= this.cfg.risk.consecutive_loss_cooldown) {
      const lastLossAt = history[0]!.closed_at;
      const last = await this.store.lastRiskEventAt(RiskEventType.Cooldown);
      if (!last || last.getTime() < lastLossAt.getTime()) {
        const until = new Date(lastLossAt.getTime() + this.cfg.risk.cooldown_minutes * 60_000);
        const detail = { consecutive_losses: consecutive, until: until.toISOString() };
        await this.store.insertRiskEvent(RiskEventType.Cooldown, detail);
        await this.events.emit({
          type: EngineEventType.RiskLimitHit,
          reason: `${consecutive} consecutive losses; cooling down until ${until.toISOString()}`,
          detail,
        });
      }
    }
  }

  /** Paper and up: record cash + open cost, unrealised PnL at the last close, and drawdown. */
  async snapshotEquity(ts: Date = this.now()): Promise<EquitySnapshot | null> {
    if (!this.wallet) return null;
    let unrealised = 0;
    for (const p of this.activePositions) {
      const last = (await this.store.recentCandles(p.symbol, p.timeframe, 1))[0];
      const mark = last?.close ?? p.state.entry;
      unrealised += p.state.remaining_qty * (mark - p.state.entry);
    }
    return this.wallet.snapshot(ts, this.openCost(), unrealised);
  }

  private tfMs(tf: string): number {
    const m = /^(\d+)([mhd])$/.exec(tf);
    if (!m) return 0;
    const n = Number(m[1]);
    return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
  }
}
