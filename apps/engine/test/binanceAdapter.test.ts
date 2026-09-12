import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SignalSchema, type Signal } from "@trading/contracts";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import type { Candle } from "../src/db.js";
import { EngineEventType, MemoryEventSink } from "../src/events.js";
import type { ForcedClose } from "../src/execution/adapter.js";
import { BinanceSpotAdapter, clientId } from "../src/execution/binance/adapter.js";
import { LocalOrderStatus, MemoryOrderStore, OrderGroup, OrderLeg } from "../src/execution/binance/orders.js";
import { RestError, RestErrorKind } from "../src/execution/binance/rest.js";
import { PositionManager } from "../src/positions/manager.js";
import { MemoryPositionStore } from "../src/positions/store.js";
import { FakeBinance } from "./fakeBinance.js";

const filters = new Map([["BTCUSDT", { tickSize: "0.01", stepSize: "0.00001", minQty: "0.00001", minNotional: "5" }]]);
const sig = { symbol: "BTCUSDT" } as Signal;
const now = () => new Date(0);

function make(ex: FakeBinance, onForcedClose?: (fc: ForcedClose) => Promise<void>) {
  ex.balances_["BTC"] ??= { free: 0.04, locked: 0 }; // the position these tests protect
  const orders = new MemoryOrderStore();
  const events = new MemoryEventSink();
  const adapter = new BinanceSpotAdapter({ mode: "testnet", rest: ex, orders, filters, events, onForcedClose, now, sleep: async () => {} });
  return { orders, events, adapter };
}
const protectReq = (over: Partial<Parameters<BinanceSpotAdapter["protect"]>[0]> = {}) => ({
  positionId: "pos:1", symbol: "BTCUSDT", qty: 0.04, stop: 98, tp: 106, tp1: 103, tp1Qty: 0.02, tp1Done: false, ...over,
});

describe("clientId", () => {
  it("is deterministic, short and Binance-safe", () => {
    const a = clientId("e-", "pos:s1_btc_15m:BTCUSDT:15m:2026-09-12T14:00:00Z");
    expect(a).toBe(clientId("e-", "pos:s1_btc_15m:BTCUSDT:15m:2026-09-12T14:00:00Z"));
    expect(a).toMatch(/^[.A-Z:/a-z0-9_-]{1,36}$/);
    expect(clientId("a-", "x", 123456789).length).toBeLessThanOrEqual(36);
  });
});

describe("BinanceSpotAdapter", () => {
  let ex: FakeBinance;
  beforeEach(() => {
    ex = new FakeBinance(100);
  });

  it("market buy: fill from the FULL response, sellable qty net of base-asset commission, idempotent retry", async () => {
    ex.commissionAsset = "BASE";
    const { adapter, orders } = make(ex);
    const fill = await adapter.openLong({ signal: sig, positionId: "pos:1", qty: 0.04, refPrice: 100, feePct: 0.1 });
    expect(fill.price).toBe(100);
    expect(fill.qty).toBeCloseTo(0.04 - 0.00004, 10); // commission 0.1% in BTC, rounded down to the step
    expect(fill.feeAsset).toBe("USDT");
    expect(fill.fee).toBeCloseTo(0.00004 * 100, 10);
    const again = await adapter.openLong({ signal: sig, positionId: "pos:1", qty: 0.04, refPrice: 100, feePct: 0.1 });
    expect(again.price).toBe(100);
    expect(ex.calls.filter((c) => c.startsWith("market:BUY"))).toHaveLength(1);
    const row = (await orders.forPosition("pos:1"))[0]!;
    expect(row.group).toBe(OrderGroup.Entry);
    expect(row.status).toBe(LocalOrderStatus.Filled);
    expect(await orders.fillsFor(row.id)).toHaveLength(1);
  });

  it("places two OCOs (tp1 half, tp remainder) with the stop-limit 0.2% under the stop; no churn when nothing moved", async () => {
    const { adapter, orders } = make(ex);
    await adapter.protect(protectReq());
    const open = ex.openSells();
    expect(open).toHaveLength(4);
    const stops = open.filter((o) => o.stopPrice !== null);
    expect(stops.map((o) => o.stopPrice)).toEqual([98, 98]);
    expect(stops[0]!.price).toBe(97.8); // 98 * 0.998 = 97.804 rounded to the 0.01 tick
    expect(open.filter((o) => o.stopPrice === null).map((o) => o.price).sort()).toEqual([103, 106]);
    expect(stops.map((o) => o.origQty)).toEqual([0.02, 0.02]);
    const rows = await orders.forPosition("pos:1");
    expect(rows.map((r) => `${r.group}:${r.leg}`).sort()).toEqual(["oco_a:limit", "oco_a:stop", "oco_b:limit", "oco_b:stop"]);
    ex.calls.length = 0;
    await adapter.protect(protectReq());
    await adapter.protect(protectReq({ stop: 98.02 })); // +0.02%: under the replace threshold
    expect(ex.calls).toEqual([]);
  });

  it("replaces the lists when the stop trails up, drops OCO-A after TP1, cancels everything on release", async () => {
    const { adapter } = make(ex);
    await adapter.protect(protectReq());
    ex.calls.length = 0;
    await adapter.protect(protectReq({ stop: 99 })); // +1%: replace both
    expect(ex.calls.filter((c) => c.startsWith("cancelList"))).toHaveLength(2);
    expect(ex.calls.filter((c) => c.startsWith("oco"))).toHaveLength(2);
    expect(ex.openSells().filter((o) => o.stopPrice !== null).map((o) => o.stopPrice)).toEqual([99, 99]);
    ex.calls.length = 0;
    await adapter.protect(protectReq({ stop: 99, qty: 0.02, tp1Done: true })); // TP1 sold: only B with the remaining qty
    expect(ex.openSells()).toHaveLength(2);
    expect(ex.openSells()[0]!.origQty).toBe(0.02);
    await adapter.release("pos:1");
    expect(ex.openSells()).toHaveLength(0);
  });

  it("closeLong uses the fill the exchange already made when a leg triggered intrabar", async () => {
    const { adapter } = make(ex);
    await adapter.protect(protectReq());
    ex.moveTo(97); // both stops trigger at 98*0.998
    ex.calls.length = 0;
    const fill = await adapter.closeLong({ positionId: "pos:1", symbol: "BTCUSDT", qty: 0.04, refPrice: 98, feePct: 0.1, reason: "stop" });
    expect(fill.qty).toBeCloseTo(0.04, 10);
    expect(fill.price).toBe(97.8);
    expect(fill.fee).toBeCloseTo(97.8 * 0.04 * 0.001, 8);
    expect(ex.calls.filter((c) => c.startsWith("market"))).toHaveLength(0);
    expect(await adapter.stopCoverage("pos:1")).toBe(0);
  });

  it("closeLong for a TP1 partial consumes only leg A, then protect re-covers the rest", async () => {
    const { adapter } = make(ex);
    await adapter.protect(protectReq());
    ex.moveTo(103.5); // limit leg of A fills at 103; B's limit at 106 does not
    const fill = await adapter.closeLong({ positionId: "pos:1", symbol: "BTCUSDT", qty: 0.02, refPrice: 103, feePct: 0.1, reason: "tp_partial" });
    expect(fill.qty).toBeCloseTo(0.02, 10);
    expect(fill.price).toBe(103);
    expect(ex.openSells()).toHaveLength(2); // B still resting
    await adapter.protect(protectReq({ qty: 0.02, tp1Done: true, stop: 100.2 })); // breakeven stop
    const open = ex.openSells();
    expect(open).toHaveLength(2);
    expect(open.find((o) => o.stopPrice !== null)!.stopPrice).toBe(100.2);
  });

  it("closeLong with nothing filled cancels the lists and sells at market", async () => {
    const { adapter } = make(ex);
    await adapter.protect(protectReq());
    ex.moveTo(101);
    const fill = await adapter.closeLong({ positionId: "pos:1", symbol: "BTCUSDT", qty: 0.04, refPrice: 101, feePct: 0.1, reason: "manual" });
    expect(fill.price).toBe(101);
    expect(fill.qty).toBeCloseTo(0.04, 10);
    expect(ex.openSells()).toHaveLength(0);
    expect(ex.calls.filter((c) => c.startsWith("market:SELL"))).toHaveLength(1);
  });

  it("market already through the stop: sells that quantity at market and alerts", async () => {
    const { adapter, events } = make(ex);
    ex.moveTo(97);
    await adapter.protect(protectReq());
    expect(ex.calls.filter((c) => c.startsWith("market:SELL"))).toHaveLength(2); // A and B
    expect(ex.openSells()).toHaveLength(0);
    expect(events.ofType(EngineEventType.Alert)[0]!.reason).toContain("stop already breached");
    // the exit policy then closes at the stop on candle close; closeLong finds the fills already made
    const fill = await adapter.closeLong({ positionId: "pos:1", symbol: "BTCUSDT", qty: 0.04, refPrice: 98, feePct: 0.1, reason: "stop" });
    expect(fill.qty).toBeCloseTo(0.04, 10);
    expect(fill.price).toBe(97);
  });

  it("OCO rejected for another reason: lone stop-loss-limit as fallback, upgraded to an OCO on the next protect", async () => {
    const { adapter, events, orders } = make(ex);
    ex.ocoFailures.push(new RestError(RestErrorKind.InvalidOrder, "Filter failure: PERCENT_PRICE_BY_SIDE", -1013));
    await adapter.protect(protectReq({ tp1: null, tp1Qty: null }));
    const open = ex.openSells();
    expect(open).toHaveLength(1);
    expect(open[0]!.type).toBe("STOP_LOSS_LIMIT");
    expect(events.ofType(EngineEventType.Alert)[0]!.reason).toContain("stop-loss-limit");
    expect((await orders.forPosition("pos:1")).map((r) => r.group)).toEqual([OrderGroup.StopOnly]);
    await adapter.protect(protectReq({ tp1: null, tp1Qty: null }));
    expect(ex.openSells().map((o) => o.type).sort()).toEqual(["LIMIT_MAKER", "STOP_LOSS_LIMIT"]);
  });

  it("three failed placements sell the position at market and force-close it", async () => {
    const forced: ForcedClose[] = [];
    const { adapter, events } = make(ex, async (fc) => void forced.push(fc));
    ex.ocoFailures.push(new RestError(RestErrorKind.Network, "timeout"), new RestError(RestErrorKind.Network, "timeout"), new RestError(RestErrorKind.Other, "boom"));
    await adapter.protect(protectReq({ tp1: null, tp1Qty: null }));
    expect(ex.calls.filter((c) => c.startsWith("market:SELL"))).toHaveLength(1);
    expect(forced).toHaveLength(1);
    expect(forced[0]!.fill.qty).toBeCloseTo(0.04, 10);
    expect(events.ofType(EngineEventType.OrderRejected)).toHaveLength(1);
  });

  it("applies execution reports from the user stream", async () => {
    const { adapter, orders } = make(ex);
    await adapter.protect(protectReq({ tp1: null, tp1Qty: null }));
    const row = (await orders.forPosition("pos:1")).find((r) => r.leg === OrderLeg.Stop)!;
    const ok = await adapter.applyExecutionReport({
      symbol: "BTCUSDT", orderId: row.exchangeOrderId!, clientOrderId: row.clientOrderId, orderListId: row.orderListId, side: "SELL", execType: "TRADE", status: "FILLED",
      lastQty: 0.04, lastPrice: 97.8, cumQty: 0.04, cumQuote: 3.912, commission: 0.003912, commissionAsset: "USDT", tradeId: "t1", time: 1,
    });
    expect(ok).toBe(true);
    const fresh = await orders.byId(row.id);
    expect(fresh!.status).toBe(LocalOrderStatus.Filled);
    expect(await orders.fillsFor(row.id)).toHaveLength(1);
    expect(await adapter.applyExecutionReport({ symbol: "BTCUSDT", orderId: "999", clientOrderId: "web", orderListId: null, side: "SELL", execType: "NEW", status: "NEW", lastQty: 0, lastPrice: 0, cumQty: 0, cumQuote: 0, commission: 0, commissionAsset: "", tradeId: "", time: 1 })).toBe(false);
  });
});

describe("PositionManager over the Binance adapter (testnet flow)", () => {
  const cfg = { ...parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8")), mode: "testnet" as const };
  const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8"));
  let t = 0;
  const candle = (o: { open: number; high: number; low: number; close: number }, tf = "15m"): Candle => {
    t += 900_000;
    return { symbol: "BTCUSDT", timeframe: tf, openTime: new Date(t), volume: 1, closed: true, ...o };
  };

  it("buys at market, protects with OCOs, takes TP1 on the exchange, trails, and closes on the exchange stop", async () => {
    t = new Date(fixture.ts).getTime();
    const ex = new FakeBinance(61234.5);
    const store = new MemoryPositionStore();
    const sink = new MemoryEventSink();
    const orders = new MemoryOrderStore();
    const filtersBtc = new Map([["BTCUSDT", { tickSize: "0.01", stepSize: "0.00001", minQty: "0.00001", minNotional: "5" }]]);
    const adapter = new BinanceSpotAdapter({ mode: "testnet", rest: ex, orders, filters: filtersBtc, events: sink, now: () => new Date(t), sleep: async () => {} });
    const pm = new PositionManager(cfg, store, sink, adapter, () => new Date(t + 30_000), { filters: filtersBtc });
    adapter["d"].onForcedClose = (fc) => pm.forceClose(fc).then(() => {});
    store.candles = Array.from({ length: 30 }, () => candle({ open: 61200, high: 61300, low: 61100, close: 61200 }));
    t = new Date(fixture.ts).getTime();
    const s: Signal = SignalSchema.parse(fixture);

    const id = await pm.handleSignal(s, { paused: false, newsBlock: false });
    expect(id).not.toBeNull();
    const p = pm.activePositions[0]!;
    expect(p.state.entry).toBe(61234.5);
    expect(ex.openSells()).toHaveLength(4); // two OCO lists
    expect(await adapter.stopCoverage(p.id)).toBeCloseTo(p.state.qty, 8);

    // price runs through tp1 intrabar: the exchange fills OCO-A's limit leg before the candle closes
    ex.moveTo(61800);
    await pm.onCandleClosed(candle({ open: 61300, high: 61900, low: 61250, close: 61850 }));
    expect(sink.ofType(EngineEventType.TpPartial)).toHaveLength(1);
    expect(p.state.tp1_done).toBe(true);
    expect(p.fees_paid).toBeGreaterThan(0);
    const sells = ex.openSells();
    expect(sells).toHaveLength(2); // OCO-B replaced with the breakeven/trailing stop
    expect(sells.find((o) => o.stopPrice !== null)!.stopPrice).toBeCloseTo(p.state.sl, 2);

    // trailing stop hit on the exchange, then the candle closes below it
    const sl = p.state.sl;
    ex.moveTo(sl - 5);
    await pm.onCandleClosed(candle({ open: 61850, high: 61860, low: sl - 10, close: sl - 5 }));
    expect(pm.activePositions).toHaveLength(0);
    const o = store.outcomes.get(s.id)!;
    expect(o.close_reason).toBe("trailing");
    expect(ex.openSells()).toHaveLength(0);
    expect(ex.balances_["BTC"]!.free).toBeCloseTo(0, 6); // everything sold
    const closed = sink.ofType(EngineEventType.PositionClosed)[0]!;
    expect((closed.detail as { fees_paid: number }).fees_paid).toBeCloseTo(p.fees_paid, 10);
  });
});
