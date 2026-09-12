import { describe, expect, it } from "vitest";
import { PaperAdapter } from "../src/execution/paper.js";
import { MemoryWalletStore, PaperWallet } from "../src/execution/wallet.js";
import type { Signal } from "@trading/contracts";

const sig = { symbol: "BTCUSDT" } as Signal;

describe("paper wallet + adapter", () => {
  it("starts from the configured balance, then from the persisted one", async () => {
    const store = new MemoryWalletStore();
    const w = new PaperWallet(store, 10_000);
    await w.init();
    expect(w.cash).toBe(10_000);
    store.balance = 9_500;
    const w2 = new PaperWallet(store, 10_000);
    await w2.init();
    expect(w2.cash).toBe(9_500);
  });

  it("buys at the next open plus slippage with a fee, sells at the policy price with a fee", async () => {
    const store = new MemoryWalletStore();
    const w = new PaperWallet(store, 10_000);
    await w.init();
    const ad = new PaperAdapter({ slippage_pct: 0.05 }, w, () => new Date(0));
    expect(ad.quoteEntry(100)).toBeCloseTo(100.05, 10);
    const buy = await ad.openLong({ signal: sig, positionId: "p", qty: 10, refPrice: 100, feePct: 0.1 });
    expect(buy.price).toBeCloseTo(100.05, 10);
    expect(buy.fee).toBeCloseTo(1.0005, 10); // 0.1% of 1000.5
    expect(w.cash).toBeCloseTo(10_000 - 1000.5 - 1.0005, 8);
    expect(store.balance).toBeCloseTo(w.cash, 10);
    const sell = await ad.closeLong({ positionId: "p", symbol: "BTCUSDT", qty: 10, refPrice: 103, feePct: 0.1, reason: "take_profit" });
    expect(sell.price).toBe(103);
    expect(sell.fee).toBeCloseTo(1.03, 10);
    expect(w.cash).toBeCloseTo(10_000 - 1000.5 - 1.0005 + 1030 - 1.03, 8);
  });

  it("snapshots equity at cost plus unrealised and tracks drawdown from the peak", async () => {
    const store = new MemoryWalletStore();
    const w = new PaperWallet(store, 10_000);
    await w.init();
    await w.snapshot(new Date(1), 0, 0);
    w.cash = 9_000; // bought 1000 of stock at cost
    const s1 = await w.snapshot(new Date(2), 1000, 50);
    expect(s1.balance_quote).toBe(10_000);
    expect(s1.unrealised).toBe(50);
    expect(s1.drawdown_pct).toBe(0);
    expect(w.peak).toBe(10_050);
    const s2 = await w.snapshot(new Date(3), 1000, -200);
    expect(s2.drawdown_pct).toBeCloseTo(((10_050 - 9_800) / 10_050) * 100, 10);
    expect(store.snapshots).toHaveLength(3);
    // peak is recovered from the snapshots on restart
    const w2 = new PaperWallet(store, 10_000);
    store.balance = 9_000;
    await w2.init();
    expect(w2.peak).toBe(10_050);
  });
});
