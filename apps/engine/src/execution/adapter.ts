/** Execution adapter interface. Shadow (M3) records only; paper (M5), testnet/live (M6+) place orders. */
import type { Signal } from "@trading/contracts";
import type { Mode } from "../config.js";

export interface Fill {
  price: number;
  qty: number;
  fee: number;
  feeAsset: string;
  ts: Date;
}

export interface ExchangeAdapter {
  readonly mode: Mode;
  /** Buy `qty` for the signal. Shadow fills at the signal entry price. */
  openLong(sig: Signal, qty: number): Promise<Fill>;
  /** Sell `qty` at (or around) `price`; shadow fills exactly at `price`. */
  closeLong(symbol: string, qty: number, price: number, reason: string): Promise<Fill>;
  /** Place/replace protective orders. No-op in shadow. */
  protect(symbol: string, qty: number, stop: number, tp: number): Promise<void>;
}
