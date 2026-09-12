/**
 * Execution adapter interface. Shadow (M3) records only; paper (M5) fills against a simulated wallet
 * at the next candle open; testnet/live (M6+) place real orders with exchange-side OCO protection.
 * The position manager never knows which one it is talking to.
 */
import type { Signal } from "@trading/contracts";
import type { Mode } from "../config.js";

/** When the entry fill happens relative to the signal. */
export enum EntryTiming {
  /** Fill now at the signal price (shadow) or with a market order (testnet/live). */
  Immediate = "immediate",
  /** Fill at the open of the next entry-timeframe candle, like the backtester (paper). */
  NextOpen = "next_open",
}

export interface Fill {
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  ts: Date;
  orderId?: string;
}

export interface OpenRequest {
  signal: Signal;
  positionId: string;
  qty: number;
  /** Reference price: signal price (immediate) or the candle open (next open). */
  refPrice: number;
  feePct: number;
}

export interface CloseRequest {
  positionId: string;
  symbol: string;
  qty: number;
  /** Price the exit policy closed at (stop / target / close). */
  refPrice: number;
  feePct: number;
  reason: string;
}

export interface ProtectRequest {
  positionId: string;
  symbol: string;
  /** Remaining quantity to protect. */
  qty: number;
  stop: number;
  tp: number;
  tp1: number | null;
  /** Quantity the exit policy will sell at tp1 (qty * tp1_fraction); null when there is no TP1. */
  tp1Qty: number | null;
  tp1Done: boolean;
}

/** Raised by an adapter when it had to sell a position itself (protection impossible); the manager closes the record. */
export interface ForcedClose {
  positionId: string;
  fill: Fill;
  reason: string;
}

export interface ExchangeAdapter {
  readonly mode: Mode;
  readonly entryTiming: EntryTiming;
  /** Expected entry fill for a reference price (paper adds slippage); used for the gap-at-fill check. */
  quoteEntry(refPrice: number): number;
  /** Buy `qty`; returns the actual fill (price, sellable qty, fee). */
  openLong(req: OpenRequest): Promise<Fill>;
  /** Sell `qty` at (or around) `refPrice`; shadow and paper fill exactly there. */
  closeLong(req: CloseRequest): Promise<Fill>;
  /** Place or replace protective orders for the remaining quantity. No-op below testnet. */
  protect(req: ProtectRequest): Promise<void>;
  /** The position is closed: drop any protection still on the exchange. */
  release(positionId: string): Promise<void>;
}
