/** PositionManager in paper mode: pending entry, next-open fill, wallet accounting, risk events. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SignalSchema, type Signal } from "@trading/contracts";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import type { Candle } from "../src/db.js";
import { EngineEventType, MemoryEventSink } from "../src/events.js";
import { PaperAdapter } from "../src/execution/paper.js";
import { MemoryWalletStore, PaperWallet } from "../src/execution/wallet.js";
import { PositionManager } from "../src/positions/manager.js";
import { MemoryPositionStore, RiskEventType } from "../src/positions/store.js";
import { RejectReason } from "../src/risk/riskManager.js";

const cfg = { ...parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8")), mode: "paper" as const };
const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8"));
const btcFilters = { tickSize: "0.01", stepSize: "0.00001", minQty: "0.00001", minNotional: "5" };

let t = 0;
const candle = (o: Partial<Candle> & { open: number; high: number; low: number; close: number }, tf = "15m"): Candle => {
  t += 900_000;
  return { symbol: "BTCUSDT", timeframe: tf, openTime: new Date(t), volume: 1, closed: true, ...o };
};

describe("PositionManager (paper)", () => {
  let store: MemoryPositionStore;
  let sink: MemoryEventSink;
  let wallet: PaperWallet;
  let pm: PositionManager;
  let sig: Signal;

  beforeEach(async () => {
    t = new Date(fixture.ts).getTime();
    store = new MemoryPositionStore();
    sink = new MemoryEventSink();
    wallet = new PaperWallet(new MemoryWalletStore(), 10_000);
    await wallet.init();
    const adapter = new PaperAdapter(cfg.paper, wallet, () => new Date(t));
    pm = new PositionManager(cfg, store, sink, adapter, () => new Date(t + 30_000), { wallet, filters: new Map([["BTCUSDT", btcFilters]]) });
    sig = SignalSchema.parse(fixture);
    store.candles = Array.from({ length: 30 }, () => candle({ open: 61200, high: 61300, low: 61100, close: 61200 }));
    t = new Date(fixture.ts).getTime();
  });

  it("parks the entry, fills at the next 15m open + slippage, sizes on the fill and charges the wallet", async () => {
    const id = await pm.handleSignal(sig, { paused: false, newsBlock: false });
    expect(id).toBe(`pos:${sig.id}`);
    expect(pm.openPositions[0]!.pending).not.toBeNull();
    expect(pm.activePositions).toHaveLength(0);
    expect(store.accepted.has(sig.id)).toBe(false); // nothing journaled until the fill
    expect(sink.ofType(EngineEventType.PositionOpened)).toHaveLength(0);

    await pm.onCandleClosed(candle({ open: 61250, high: 61400, low: 61200, close: 61350 }, "1h")); // wrong tf: still pending
    expect(pm.activePositions).toHaveLength(0);

    await pm.onCandleClosed(candle({ open: 61250, high: 61400, low: 61200, close: 61350 }));
    const p = pm.activePositions[0]!;
    const fill = 61250 * (1 + cfg.paper.slippage_pct / 100);
    expect(p.state.entry).toBeCloseTo(fill, 6);
    expect(p.state.bars).toBe(1); // the fill candle is also the first exit-policy bar
    // sized at the candle open: 25% notional cap of 10k -> 2500 / 61250, rounded down to the step
    expect(p.state.qty).toBeCloseTo(Math.floor((2500 / 61250) / 0.00001) * 0.00001, 12);
    expect(p.risk_amount).toBeCloseTo((fill - sig.stop_price) * p.state.qty, 8);
    expect(store.accepted.get(sig.id)!.actualEntry).toBeCloseTo(fill, 6);
    expect(store.accepted.get(sig.id)!.slippagePct).toBeCloseTo(((fill - sig.entry.price) / sig.entry.price) * 100, 8);
    expect(sink.ofType(EngineEventType.PositionOpened)).toHaveLength(1);
    expect(wallet.cash).toBeCloseTo(10_000 - fill * p.state.qty * (1 + 0.001), 6);
  });

  it("cancels the entry when the next open gaps beyond the stop (journaled as gap_at_fill)", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ open: 60600, high: 60700, low: 60500, close: 60650 }));
    expect(pm.openPositions).toHaveLength(0);
    expect(store.rejected.get(sig.id)).toBe(RejectReason.GapAtFill);
    expect(sink.ofType(EngineEventType.SignalRejected)[0]?.reason).toBe(RejectReason.GapAtFill);
    expect(wallet.cash).toBe(10_000);
  });

  it("wallet delta equals realised pnl after TP1 partial and a trailing stop close", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ open: 61250, high: 61300, low: 61200, close: 61280 }));
    const p = pm.activePositions[0]!;
    const qty = p.state.qty;
    await pm.onCandleClosed(candle({ open: 61300, high: 61900, low: 61250, close: 61850 })); // > tp1 -> partial + breakeven + trailing
    expect(sink.ofType(EngineEventType.TpPartial)).toHaveLength(1);
    expect(p.fees_paid).toBeGreaterThan(0);
    const sl = p.state.sl;
    await pm.onCandleClosed(candle({ open: 61850, high: 61860, low: sl - 1, close: sl }));
    const o = store.outcomes.get(sig.id)!;
    expect(o.close_reason).toBe("trailing");
    // cash out - cash in == (gross pnl - fees) == realised_pnl, up to the sizing basis (risk_amount uses the fill)
    const delta = wallet.cash - 10_000;
    expect(delta).toBeCloseTo(o.realized_pnl, 6);
    expect(o.fees).toBeCloseTo(p.fees_paid, 6);
    expect(qty).toBe(p.state.qty);
    // equity snapshot written on close
    expect((await pm.snapshotEquity())!.balance_quote).toBeCloseTo(wallet.cash, 8);
  });

  it("records a daily-loss risk event once and a cooldown event after N consecutive losses", async () => {
    const lossR = -1; // full stop
    const day = new Date(t).toISOString().slice(0, 10);
    store.history = [
      { realized_r: lossR, closed_at: new Date(t) },
      { realized_r: lossR, closed_at: new Date(t) },
    ];
    store.now = () => new Date(t);
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ open: 61250, high: 61300, low: 61200, close: 61280 }));
    await pm.onCandleClosed(candle({ open: 61200, high: 61250, low: 60600, close: 60700 })); // stop
    const closed = store.outcomes.get(sig.id)!;
    expect(closed.outcome).toBe("loss");
    expect(closed.closed_at.toISOString().slice(0, 10)).toBe(day);
    const hits = sink.ofType(EngineEventType.RiskLimitHit);
    expect(store.riskEvents.map((e) => e.type)).toEqual([RiskEventType.DailyLoss, RiskEventType.Cooldown]);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.reason).toContain("daily loss");
    expect(hits[1]!.reason).toContain("3 consecutive losses");
    // a further loss the same day does not repeat the daily event
    const again = SignalSchema.parse({ ...fixture, id: "s1_btc_15m:BTCUSDT:15m:2026-09-12T18:00:00Z", ts: new Date(t + 600_000).toISOString() });
    expect(await pm.handleSignal(again, { paused: false, newsBlock: false })).toBeNull(); // daily_loss / cooldown reject
    expect(store.rejected.get(again.id)).toBe(RejectReason.DailyLoss);
  });

  it("rejects when the sized quantity is below the exchange minimum", async () => {
    const tiny = new PositionManager(cfg, store, sink, new PaperAdapter(cfg.paper, wallet), () => new Date(t + 30_000), {
      wallet,
      filters: new Map([["BTCUSDT", { ...btcFilters, minNotional: "100000" }]]),
    });
    expect(await tiny.handleSignal(sig, { paused: false, newsBlock: false })).toBeNull();
    expect(store.rejected.get(sig.id)).toBe(RejectReason.BelowMinimum);
  });

  it("entries_enabled=false rejects and kill cancels a pending entry", async () => {
    expect(await pm.handleSignal(sig, { paused: false, newsBlock: false, entriesEnabled: false })).toBeNull();
    expect(store.rejected.get(sig.id)).toBe(RejectReason.EntriesDisabled);
    const s2 = SignalSchema.parse({ ...fixture, id: "s1_btc_15m:BTCUSDT:15m:2026-09-12T14:15:00Z" });
    await pm.handleSignal(s2, { paused: false, newsBlock: false });
    expect(pm.openPositions).toHaveLength(1);
    expect(await pm.closeAll("kill" as never)).toBe(1);
    expect(store.cancelled.get(s2.id)).toBe("kill");
    expect(pm.openPositions).toHaveLength(0);
  });

  it("restore() brings back a pending entry and fills it later", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    const pm2 = new PositionManager(cfg, store, sink, new PaperAdapter(cfg.paper, wallet, () => new Date(t)), () => new Date(t), { wallet });
    expect(await pm2.restore()).toBe(1);
    expect(pm2.openPositions[0]!.pending?.signal.id).toBe(sig.id);
    await pm2.onCandleClosed(candle({ open: 61250, high: 61300, low: 61200, close: 61280 }));
    expect(pm2.activePositions).toHaveLength(1);
  });
});
