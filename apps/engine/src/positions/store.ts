/** Persistence for positions + signal outcome write-back. Pg implementation and an in-memory one for tests. */
import { SignalSchema, type Signal } from "@trading/contracts";
import type { Mode } from "../config.js";
import { type Candle, type Sql, loadRecentCandles } from "../db.js";
import type { ExitEvent, ExitState, PositionState } from "./exitPolicy.js";

/** A position accepted by risk but not filled yet: paper fills at the next candle open. */
export interface PendingEntry {
  signal: Signal;
}

export interface PositionRecord {
  id: string;
  signal_id: string;
  strategy_id: string;
  symbol: string;
  timeframe: string;
  regime_tf: string;
  invalidation_level: number | null;
  risk_amount: number;
  fee_pct: number;
  /** Exchange fees actually paid on this position's fills (quote); zero in shadow. */
  fees_paid: number;
  exit_params: Record<string, unknown>;
  opened_at: Date;
  state: PositionState;
  pending: PendingEntry | null;
}

export interface Outcome {
  outcome: "win" | "loss" | "breakeven";
  exit_price: number;
  realized_r: number;
  realized_pnl: number;
  fees: number;
  mfe_r: number;
  mae_r: number;
  bars_held: number;
  duration_s: number;
  close_reason: string;
  closed_at: Date;
}

export enum RiskEventType {
  DailyLoss = "daily_loss",
  Cooldown = "cooldown",
  ReconcileMismatch = "reconcile_mismatch",
  Unprotected = "unprotected_position",
}

export interface PositionStore {
  insert(p: PositionRecord): Promise<void>;
  update(p: PositionRecord): Promise<void>;
  close(p: PositionRecord, o: Outcome): Promise<void>;
  /** A pending entry that never filled (gap at fill, below minimum, manual cancel). */
  cancelPending(p: PositionRecord, reason: string): Promise<void>;
  loadOpen(): Promise<PositionRecord[]>;
  markSignalAccepted(signalId: string, positionId: string, actualEntry: number, slippagePct: number): Promise<void>;
  markSignalRejected(signalId: string, reason: string): Promise<void>;
  signalExists(signalId: string): Promise<boolean>;
  recentCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  recentOutcomes(): Promise<{ realized_r: number; closed_at: Date }[]>;
  insertRiskEvent(type: RiskEventType, detail: Record<string, unknown>): Promise<void>;
  lastRiskEventAt(type: RiskEventType): Promise<Date | null>;
}

const dbState = (p: PositionRecord) => (p.pending ? "pending" : p.state.state);
const metaOf = (p: PositionRecord) => ({
  regime_tf: p.regime_tf,
  invalidation_level: p.invalidation_level,
  risk_amount: p.risk_amount,
  fee_pct: p.fee_pct,
  fees_paid: p.fees_paid,
  events: p.state.events,
  pending_signal: p.pending?.signal ?? null,
});

export class PgPositionStore implements PositionStore {
  constructor(private sql: Sql, private mode: Mode) {}

  async insert(p: PositionRecord) {
    const s = p.state;
    await this.sql`
      INSERT INTO positions (id, mode, signal_id, strategy_id, symbol, timeframe, side, entry_price, qty, remaining_qty,
        sl_price, sl_initial, tp_price, tp1_price, tp1_done, highest_high, lowest_low, bars_held, state, opened_at, exit_params, meta)
      VALUES (${p.id}, ${this.mode}, ${p.signal_id}, ${p.strategy_id}, ${p.symbol}, ${p.timeframe}, 'long', ${s.entry}, ${s.qty},
        ${s.remaining_qty}, ${s.sl}, ${s.sl_initial}, ${s.tp}, ${s.tp1}, ${s.tp1_done}, ${s.highest_high}, ${s.lowest_low},
        ${s.bars}, ${dbState(p)}, ${p.opened_at}, ${this.sql.json(p.exit_params as never)}, ${this.sql.json(metaOf(p) as never)})`;
  }

  async update(p: PositionRecord) {
    const s = p.state;
    await this.sql`
      UPDATE positions SET entry_price = ${s.entry}, qty = ${s.qty}, remaining_qty = ${s.remaining_qty}, sl_price = ${s.sl},
        sl_initial = ${s.sl_initial}, tp_price = ${s.tp}, tp1_price = ${s.tp1}, tp1_done = ${s.tp1_done},
        highest_high = ${s.highest_high}, lowest_low = ${s.lowest_low}, bars_held = ${s.bars}, state = ${dbState(p)},
        opened_at = ${p.opened_at}, meta = meta || ${this.sql.json(metaOf(p) as never)}
      WHERE id = ${p.id}`;
  }

  async close(p: PositionRecord, o: Outcome) {
    await this.update(p);
    await this.sql`
      UPDATE positions SET closed_at = ${o.closed_at}, close_reason = ${o.close_reason}, exit_price = ${o.exit_price},
        pnl = ${o.realized_pnl}, r_multiple = ${o.realized_r} WHERE id = ${p.id}`;
    // The journal row belongs to the first mode that acted on it (a paper engine beside the shadow soak must not clobber it).
    await this.sql`
      UPDATE signals SET outcome = ${o.outcome}, exit_price = ${o.exit_price}, realized_r = ${o.realized_r},
        realized_pnl = ${o.realized_pnl}, fees = ${o.fees}, mfe_r = ${o.mfe_r}, mae_r = ${o.mae_r}, bars_held = ${o.bars_held},
        duration_s = ${o.duration_s}, close_reason = ${o.close_reason}, closed_at = ${o.closed_at}
      WHERE id = ${p.signal_id} AND (mode IS NULL OR mode = ${this.mode})`;
  }

  async cancelPending(p: PositionRecord, reason: string) {
    await this.sql`UPDATE positions SET state = 'closed', close_reason = ${reason}, closed_at = now(),
      meta = meta || ${this.sql.json({ pending_signal: null } as never)} WHERE id = ${p.id}`;
    await this.markSignalRejected(p.signal_id, reason);
  }

  async loadOpen(): Promise<PositionRecord[]> {
    const rows = await this.sql<Record<string, any>[]>`
      SELECT * FROM positions WHERE mode = ${this.mode} AND state <> 'closed'`;
    return rows.map((r) => ({
      id: r.id,
      signal_id: r.signal_id,
      strategy_id: r.strategy_id,
      symbol: r.symbol,
      timeframe: r.timeframe,
      regime_tf: r.meta?.regime_tf ?? "1h",
      invalidation_level: r.meta?.invalidation_level ?? null,
      risk_amount: Number(r.meta?.risk_amount ?? 0),
      fee_pct: Number(r.meta?.fee_pct ?? 0.1),
      fees_paid: Number(r.meta?.fees_paid ?? 0),
      exit_params: r.exit_params ?? {},
      opened_at: r.opened_at,
      pending: r.state === "pending" && r.meta?.pending_signal ? { signal: SignalSchema.parse(r.meta.pending_signal) } : null,
      state: {
        entry: Number(r.entry_price),
        qty: Number(r.qty),
        sl_initial: Number(r.sl_initial),
        sl: Number(r.sl_price),
        tp: Number(r.tp_price),
        tp1: r.tp1_price === null ? null : Number(r.tp1_price),
        remaining_qty: Number(r.remaining_qty),
        highest_high: Number(r.highest_high),
        lowest_low: Number(r.lowest_low),
        tp1_done: r.tp1_done,
        state: (r.state === "pending" ? "open" : r.state) as ExitState,
        bars: r.bars_held,
        events: (r.meta?.events ?? []) as ExitEvent[],
      },
    }));
  }

  async markSignalAccepted(signalId: string, positionId: string, actualEntry: number, slippagePct: number) {
    await this.sql`UPDATE signals SET mode = ${this.mode}, position_id = ${positionId}, actual_entry = ${actualEntry},
      slippage_pct = ${slippagePct} WHERE id = ${signalId} AND (mode IS NULL OR mode = ${this.mode})`;
  }
  async markSignalRejected(signalId: string, reason: string) {
    await this.sql`UPDATE signals SET mode = ${this.mode}, outcome = 'rejected', reject_reason = ${reason}
      WHERE id = ${signalId} AND (mode IS NULL OR mode = ${this.mode})`;
  }
  async signalExists(signalId: string) {
    const rows = await this.sql`SELECT 1 FROM positions WHERE signal_id = ${signalId} AND mode = ${this.mode}`;
    return rows.length > 0;
  }
  recentCandles(symbol: string, timeframe: string, limit: number) {
    return loadRecentCandles(this.sql, symbol, timeframe, limit);
  }
  async recentOutcomes() {
    // positions, not signals: the journal row may belong to another mode running beside this one
    const rows = await this.sql<{ r_multiple: string; closed_at: Date }[]>`
      SELECT r_multiple, closed_at FROM positions WHERE mode = ${this.mode} AND closed_at IS NOT NULL AND r_multiple IS NOT NULL
      ORDER BY closed_at DESC LIMIT 50`;
    return rows.map((r) => ({ realized_r: Number(r.r_multiple), closed_at: r.closed_at }));
  }
  async insertRiskEvent(type: RiskEventType, detail: Record<string, unknown>) {
    await this.sql`INSERT INTO risk_events (mode, type, detail) VALUES (${this.mode}, ${type}, ${this.sql.json(detail as never)})`;
  }
  async lastRiskEventAt(type: RiskEventType) {
    const rows = await this.sql<{ ts: Date }[]>`SELECT ts FROM risk_events WHERE mode = ${this.mode} AND type = ${type} ORDER BY ts DESC LIMIT 1`;
    return rows[0]?.ts ?? null;
  }
}

export class MemoryPositionStore implements PositionStore {
  positions = new Map<string, PositionRecord>();
  outcomes = new Map<string, Outcome>();
  accepted = new Map<string, { positionId: string; actualEntry: number; slippagePct: number }>();
  rejected = new Map<string, string>();
  cancelled = new Map<string, string>();
  candles: Candle[] = [];
  history: { realized_r: number; closed_at: Date }[] = [];
  riskEvents: { ts: Date; type: RiskEventType; detail: Record<string, unknown> }[] = [];
  now: () => Date = () => new Date();
  async insert(p: PositionRecord) {
    this.positions.set(p.id, p);
  }
  async update(p: PositionRecord) {
    this.positions.set(p.id, p);
  }
  async close(p: PositionRecord, o: Outcome) {
    this.positions.set(p.id, p);
    this.outcomes.set(p.signal_id, o);
    this.history.unshift({ realized_r: o.realized_r, closed_at: o.closed_at });
  }
  async cancelPending(p: PositionRecord, reason: string) {
    this.positions.delete(p.id);
    this.cancelled.set(p.signal_id, reason);
    this.rejected.set(p.signal_id, reason);
  }
  async loadOpen() {
    return [...this.positions.values()].filter((p) => p.pending || p.state.state !== "closed");
  }
  async markSignalAccepted(signalId: string, positionId: string, actualEntry: number, slippagePct: number) {
    this.accepted.set(signalId, { positionId, actualEntry, slippagePct });
  }
  async markSignalRejected(signalId: string, reason: string) {
    this.rejected.set(signalId, reason);
  }
  async signalExists(signalId: string) {
    return [...this.positions.values()].some((p) => p.signal_id === signalId);
  }
  async recentCandles(_s: string, _tf: string, limit: number) {
    return this.candles.slice(-limit);
  }
  async recentOutcomes() {
    return this.history;
  }
  async insertRiskEvent(type: RiskEventType, detail: Record<string, unknown>) {
    this.riskEvents.push({ ts: this.now(), type, detail });
  }
  async lastRiskEventAt(type: RiskEventType) {
    const last = [...this.riskEvents].reverse().find((e) => e.type === type);
    return last?.ts ?? null;
  }
}
