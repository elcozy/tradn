/**
 * Paper adapter (M5): a simulated exchange over a PaperWallet.
 * - entry: market fill at the NEXT candle open plus slippage (the manager passes that open as refPrice)
 * - exits: filled exactly at the exit policy's price (stop / target), fee on every fill
 * - no protective orders: stop and target are simulated by the exit policy against candle high/low
 * Same rules as research/backtest/engine.py, so paper and backtest agree on the same candles.
 */
import { EntryTiming, type CloseRequest, type ExchangeAdapter, type Fill, type OpenRequest } from "./adapter.js";
import type { Ledger } from "./wallet.js";

export interface PaperParams {
  slippage_pct: number;
}

export class PaperAdapter implements ExchangeAdapter {
  readonly mode = "paper" as const;
  readonly entryTiming = EntryTiming.NextOpen;
  constructor(private params: PaperParams, private ledger: Ledger, private now: () => Date = () => new Date()) {}

  quoteEntry(refPrice: number): number {
    return refPrice * (1 + this.params.slippage_pct / 100);
  }
  async openLong(req: OpenRequest): Promise<Fill> {
    const price = this.quoteEntry(req.refPrice);
    const fill: Fill = { price, qty: req.qty, fee: (price * req.qty * req.feePct) / 100, feeAsset: "USDT", ts: this.now() };
    await this.ledger.onBuy(fill);
    return fill;
  }
  async closeLong(req: CloseRequest): Promise<Fill> {
    const fill: Fill = { price: req.refPrice, qty: req.qty, fee: (req.refPrice * req.qty * req.feePct) / 100, feeAsset: "USDT", ts: this.now() };
    await this.ledger.onSell(fill);
    return fill;
  }
  async protect(): Promise<void> {}
  async release(): Promise<void> {}
}
