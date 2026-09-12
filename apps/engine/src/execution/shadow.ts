import { EntryTiming, type CloseRequest, type ExchangeAdapter, type Fill, type OpenRequest } from "./adapter.js";

/** No side effects: every "fill" happens at the requested price with zero exchange fee
 * (fees are accounted in R by the exit policy's fee_pct, exactly as in the backtester). */
export class ShadowAdapter implements ExchangeAdapter {
  readonly mode = "shadow" as const;
  readonly entryTiming = EntryTiming.Immediate;
  constructor(private now: () => Date = () => new Date()) {}
  quoteEntry(refPrice: number): number {
    return refPrice;
  }
  async openLong(req: OpenRequest): Promise<Fill> {
    return { price: req.refPrice, qty: req.qty, fee: 0, feeAsset: "USDT", ts: this.now() };
  }
  async closeLong(req: CloseRequest): Promise<Fill> {
    return { price: req.refPrice, qty: req.qty, fee: 0, feeAsset: "USDT", ts: this.now() };
  }
  async protect(): Promise<void> {}
  async release(): Promise<void> {}
}
