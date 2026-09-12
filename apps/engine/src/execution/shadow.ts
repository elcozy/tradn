import type { Signal } from "@trading/contracts";
import type { ExchangeAdapter, Fill } from "./adapter.js";

/** No side effects: every "fill" happens at the requested price with zero exchange fee
 * (fees are accounted in R by the exit policy's fee_pct, exactly as in the backtester). */
export class ShadowAdapter implements ExchangeAdapter {
  readonly mode = "shadow" as const;
  constructor(private now: () => Date = () => new Date()) {}
  async openLong(sig: Signal, qty: number): Promise<Fill> {
    return { price: sig.entry.price, qty, fee: 0, feeAsset: "USDT", ts: this.now() };
  }
  async closeLong(_symbol: string, qty: number, price: number): Promise<Fill> {
    return { price, qty, fee: 0, feeAsset: "USDT", ts: this.now() };
  }
  async protect(): Promise<void> {}
}
