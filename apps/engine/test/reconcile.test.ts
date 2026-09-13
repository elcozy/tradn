import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SignalSchema } from "@trading/contracts";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import { EngineEventType, MemoryEventSink } from "../src/events.js";
import { BinanceSpotAdapter } from "../src/execution/binance/adapter.js";
import { MemoryOrderStore } from "../src/execution/binance/orders.js";
import { Reconciler } from "../src/execution/binance/reconcile.js";
import { PositionManager } from "../src/positions/manager.js";
import { MemoryPositionStore, RiskEventType } from "../src/positions/store.js";
import { MemoryStateStore } from "../src/state.js";
import { FakeBinance } from "./fakeBinance.js";
import { withFixtureStrategyEnabled } from "./testConfig.js";

const cfg = { ...withFixtureStrategyEnabled(parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8"))), mode: "testnet" as const };
const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8"));
const filters = new Map([["BTCUSDT", { tickSize: "0.01", stepSize: "0.00001", minQty: "0.00001", minNotional: "5" }]]);

async function setup() {
  const ex = new FakeBinance(61234.5);
  const store = new MemoryPositionStore();
  const sink = new MemoryEventSink();
  const orders = new MemoryOrderStore();
  const state = new MemoryStateStore();
  const t = new Date(fixture.ts).getTime();
  const adapter = new BinanceSpotAdapter({ mode: "testnet", rest: ex, orders, filters, events: sink, now: () => new Date(t), sleep: async () => {} });
  const pm = new PositionManager(cfg, store, sink, adapter, () => new Date(t + 30_000), { filters });
  await pm.handleSignal(SignalSchema.parse(fixture), { paused: false, newsBlock: false });
  const rec = new Reconciler({ rest: ex, orders, adapter, manager: pm, events: sink, risk: store, state });
  return { ex, store, sink, orders, state, adapter, pm, rec };
}

describe("Reconciler", () => {
  it("is quiet when the exchange and the database agree", async () => {
    const { rec, sink, state } = await setup();
    const r = await rec.run();
    expect(r).toEqual({ unknownOrders: [], reprotected: [], balanceMismatches: [] });
    expect(sink.ofType(EngineEventType.ReconcileMismatch)).toHaveLength(0);
    expect(state.flags.paused).toBe(false);
  });

  it("pauses entries and records a risk event on an unknown exchange order", async () => {
    const { rec, ex, sink, state, store } = await setup();
    const id = ex.foreignOrder("BTCUSDT");
    const r = await rec.run();
    expect(r.unknownOrders).toEqual([`BTCUSDT#${id}`]);
    expect(state.flags.paused).toBe(true);
    expect(store.riskEvents[0]!.type).toBe(RiskEventType.ReconcileMismatch);
    expect(sink.ofType(EngineEventType.ReconcileMismatch)).toHaveLength(1);
  });

  it("re-protects a position whose exchange stop disappeared (engine killed, list cancelled by hand)", async () => {
    const { rec, ex, pm, adapter, sink, store } = await setup();
    for (const o of ex.openSells()) await ex.cancelOrder("BTCUSDT", o.orderId); // simulate the stops vanishing
    expect(ex.openSells()).toHaveLength(0);
    const r = await rec.run();
    expect(r.reprotected).toEqual([pm.activePositions[0]!.id]);
    expect(ex.openSells()).toHaveLength(4);
    expect(await adapter.stopCoverage(pm.activePositions[0]!.id)).toBeCloseTo(pm.activePositions[0]!.state.qty, 8);
    expect(store.riskEvents.map((e) => e.type)).toContain(RiskEventType.Unprotected);
    expect(sink.ofType(EngineEventType.Alert).some((e) => e.reason?.includes("re-protected"))).toBe(true);
  });

  it("flags a base balance smaller than what positions hold", async () => {
    const { rec, ex, sink } = await setup();
    ex.balances_["BTC"] = { free: 0.0001, locked: 0 };
    const r = await rec.run();
    expect(r.balanceMismatches).toEqual(["BTCUSDT"]);
    expect(sink.ofType(EngineEventType.ReconcileMismatch)[0]!.reason).toContain("BTC balance");
  });
});
