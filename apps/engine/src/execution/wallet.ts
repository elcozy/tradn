/**
 * Simulated quote wallet for paper mode (M5). Cash moves on every fill (fees included); the
 * balance survives restarts in engine_state.balance_quote; equity_snapshots record
 * balance-at-cost + unrealised PnL and the drawdown from the peak.
 */
import type { Mode } from "../config.js";
import type { Sql } from "../db.js";
import type { Fill } from "./adapter.js";

export interface EquitySnapshot {
  ts: Date;
  balance_quote: number; // cash + cost basis of open positions
  unrealised: number; // sum of remaining_qty * (mark - entry)
  drawdown_pct: number;
}

export interface WalletStore {
  loadBalance(): Promise<number | null>;
  saveBalance(balance: number): Promise<void>;
  peakEquity(): Promise<number | null>;
  snapshot(s: EquitySnapshot): Promise<void>;
}

export interface Ledger {
  readonly cash: number;
  onBuy(fill: Fill): Promise<void>;
  onSell(fill: Fill): Promise<void>;
}

/** What the position manager needs from any wallet (paper or exchange): sizing equity and snapshots. */
export interface Wallet {
  readonly cash: number;
  /** Equity used for sizing: quote cash plus what the open positions cost. */
  equity(openCost: number): number;
  snapshot(ts: Date, openCost: number, unrealised: number): Promise<EquitySnapshot>;
}

export const QUOTE = "USDT";

/** Shared snapshot maths: equity = cash + cost of open positions + unrealised; drawdown from the running peak. */
async function writeSnapshot(store: WalletStore, self: { cash: number; peak: number }, ts: Date, openCost: number, unrealised: number): Promise<EquitySnapshot> {
  const equity = self.cash + openCost + unrealised;
  self.peak = Math.max(self.peak, equity);
  const s: EquitySnapshot = {
    ts,
    balance_quote: self.cash + openCost,
    unrealised,
    drawdown_pct: self.peak > 0 ? ((self.peak - equity) / self.peak) * 100 : 0,
  };
  await store.snapshot(s);
  return s;
}

export class PaperWallet implements Ledger, Wallet {
  cash = 0;
  peak = 0;
  constructor(private store: WalletStore, private starting: number) {}

  async init(): Promise<void> {
    this.cash = (await this.store.loadBalance()) ?? this.starting;
    this.peak = Math.max((await this.store.peakEquity()) ?? 0, this.cash);
  }
  async onBuy(fill: Fill): Promise<void> {
    this.cash -= fill.price * fill.qty + (fill.feeAsset === QUOTE ? fill.fee : 0);
    await this.store.saveBalance(this.cash);
  }
  async onSell(fill: Fill): Promise<void> {
    this.cash += fill.price * fill.qty - (fill.feeAsset === QUOTE ? fill.fee : 0);
    await this.store.saveBalance(this.cash);
  }
  equity(openCost: number): number {
    return this.cash + openCost;
  }
  snapshot(ts: Date, openCost: number, unrealised: number): Promise<EquitySnapshot> {
    return writeSnapshot(this.store, this, ts, openCost, unrealised);
  }
}

/** Testnet/live: the quote balance is whatever the exchange says (free + locked), refreshed on demand. */
export class ExchangeWallet implements Wallet {
  cash = 0;
  peak = 0;
  constructor(private store: WalletStore, private fetchBalances: () => Promise<Record<string, { free: number; locked: number }>>, private quote = QUOTE) {}

  async refresh(): Promise<number> {
    const b = (await this.fetchBalances())[this.quote];
    this.cash = b ? b.free + b.locked : 0;
    await this.store.saveBalance(this.cash);
    return this.cash;
  }
  async init(): Promise<void> {
    await this.refresh();
    this.peak = Math.max((await this.store.peakEquity()) ?? 0, this.cash);
  }
  equity(openCost: number): number {
    return this.cash + openCost;
  }
  async snapshot(ts: Date, openCost: number, unrealised: number): Promise<EquitySnapshot> {
    await this.refresh();
    return writeSnapshot(this.store, this, ts, openCost, unrealised);
  }
}

export class PgWalletStore implements WalletStore {
  constructor(private sql: Sql, private mode: Mode) {}
  async loadBalance() {
    const rows = await this.sql<{ balance_quote: string | null }[]>`SELECT balance_quote FROM engine_state WHERE mode = ${this.mode}`;
    const b = rows[0]?.balance_quote;
    return b == null ? null : Number(b);
  }
  async saveBalance(balance: number) {
    await this.sql`UPDATE engine_state SET balance_quote = ${balance}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async peakEquity() {
    const rows = await this.sql<{ peak: string | null }[]>`
      SELECT max(balance_quote + unrealised) AS peak FROM equity_snapshots WHERE mode = ${this.mode}`;
    const p = rows[0]?.peak;
    return p == null ? null : Number(p);
  }
  async snapshot(s: EquitySnapshot) {
    await this.sql`INSERT INTO equity_snapshots (ts, mode, balance_quote, unrealised, drawdown_pct)
      VALUES (${s.ts}, ${this.mode}, ${s.balance_quote}, ${s.unrealised}, ${s.drawdown_pct})
      ON CONFLICT (mode, ts) DO UPDATE SET balance_quote = EXCLUDED.balance_quote, unrealised = EXCLUDED.unrealised, drawdown_pct = EXCLUDED.drawdown_pct`;
  }
}

export class MemoryWalletStore implements WalletStore {
  balance: number | null = null;
  snapshots: EquitySnapshot[] = [];
  async loadBalance() {
    return this.balance;
  }
  async saveBalance(b: number) {
    this.balance = b;
  }
  async peakEquity() {
    return this.snapshots.length ? Math.max(...this.snapshots.map((s) => s.balance_quote + s.unrealised)) : null;
  }
  async snapshot(s: EquitySnapshot) {
    this.snapshots.push(s);
  }
}
