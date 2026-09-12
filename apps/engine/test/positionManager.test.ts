import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SignalSchema, type Signal } from "@trading/contracts";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import type { Candle } from "../src/db.js";
import { EngineEventType, MemoryEventSink } from "../src/events.js";
import { ShadowAdapter } from "../src/execution/shadow.js";
import { ExitReason } from "../src/positions/exitPolicy.js";
import { PositionManager, closeReasonOf, outcomeOf } from "../src/positions/manager.js";
import { MemoryPositionStore } from "../src/positions/store.js";

const cfg = parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8"));
const fixture = JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8"));

let t = new Date(fixture.ts).getTime();
const candle = (o: Partial<Candle> & { high: number; low: number; close: number }, tf = "15m"): Candle => {
  t += 900_000;
  return { symbol: "BTCUSDT", timeframe: tf, openTime: new Date(t), open: o.close, volume: 1, closed: true, ...o };
};

describe("PositionManager (shadow)", () => {
  let store: MemoryPositionStore;
  let sink: MemoryEventSink;
  let pm: PositionManager;
  let sig: Signal;

  beforeEach(() => {
    t = new Date(fixture.ts).getTime();
    store = new MemoryPositionStore();
    sink = new MemoryEventSink();
    pm = new PositionManager(cfg, store, sink, new ShadowAdapter(() => new Date(t)), () => new Date(t + 30_000));
    sig = SignalSchema.parse(fixture);
    // warm ATR source: 30 flat-ish candles
    store.candles = Array.from({ length: 30 }, () => candle({ high: 61300, low: 61100, close: 61200 }));
    t = new Date(fixture.ts).getTime();
  });

  it("opens a shadow position at the signal price and journals acceptance", async () => {
    const id = await pm.handleSignal(sig, { paused: false, newsBlock: false });
    expect(id).toBe(`pos:${sig.id}`);
    expect(store.accepted.get(sig.id)?.actualEntry).toBe(sig.entry.price);
    const p = store.positions.get(id!)!;
    expect(p.state.sl).toBe(sig.stop_price);
    expect(p.state.tp1).toBe(sig.tp1_price);
    expect(p.invalidation_level).toBeNull(); // fixture meta has no invalidation_level
    expect(sink.ofType(EngineEventType.PositionOpened)).toHaveLength(1);
  });

  it("rejects when paused and journals the reason", async () => {
    const id = await pm.handleSignal(sig, { paused: true, newsBlock: false });
    expect(id).toBeNull();
    expect(store.rejected.get(sig.id)).toBe("paused");
    expect(sink.ofType(EngineEventType.SignalRejected)[0]?.reason).toBe("paused");
  });

  it("ignores a duplicate signal", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    const again = await pm.handleSignal(sig, { paused: false, newsBlock: false });
    expect(again).toBeNull();
    expect(store.rejected.get(sig.id)).toBe("duplicate");
  });

  it("steps the exit policy on its own timeframe and writes the outcome on stop", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ high: 61400, low: 61000, close: 61300 }, "1h")); // other tf, no invalidation level -> ignored
    expect(pm.openPositions).toHaveLength(1);
    await pm.onCandleClosed(candle({ high: 61300, low: 60600, close: 60700 })); // low < stop 60698? no: 60600 <= 60698 -> stop
    expect(pm.openPositions).toHaveLength(0);
    const o = store.outcomes.get(sig.id)!;
    expect(o.outcome).toBe("loss");
    expect(o.close_reason).toBe("stop");
    expect(o.realized_r).toBeLessThan(-0.9);
    expect(o.bars_held).toBe(1);
    expect(o.duration_s).toBeGreaterThan(0);
    const closed = sink.ofType(EngineEventType.PositionClosed)[0]!;
    expect(closed.reason).toBe("stop");
    expect(closed.r_multiple).toBeCloseTo(o.realized_r, 10);
  });

  it("takes TP1, trails, and reports a trailing close as win", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ high: 61900, low: 61200, close: 61850 })); // > tp1 61770.5 -> partial + breakeven + trailing
    expect(sink.ofType(EngineEventType.TpPartial)).toHaveLength(1);
    expect(sink.ofType(EngineEventType.SlMoved).length).toBeGreaterThanOrEqual(1);
    const p = pm.openPositions[0]!;
    expect(p.state.sl).toBeGreaterThan(sig.entry.price);
    const sl = p.state.sl;
    await pm.onCandleClosed(candle({ high: 61860, low: sl - 1, close: sl })); // hits the trailed stop
    const o = store.outcomes.get(sig.id)!;
    expect(o.close_reason).toBe("trailing");
    expect(o.outcome).toBe("win");
  });

  it("closes on regime invalidation from the regime timeframe", async () => {
    const withLevel = { ...sig, meta: { ...sig.meta, invalidation_level: 60850 } };
    await pm.handleSignal(withLevel, { paused: false, newsBlock: false });
    await pm.onCandleClosed(candle({ high: 61000, low: 60700, close: 60800 }, "1h")); // 1h close below level
    expect(pm.openPositions).toHaveLength(0);
    expect(store.outcomes.get(sig.id)?.close_reason).toBe("regime");
  });

  it("closeAll closes at the latest close and restore() reloads open positions", async () => {
    await pm.handleSignal(sig, { paused: false, newsBlock: false });
    const pm2 = new PositionManager(cfg, store, sink, new ShadowAdapter());
    expect(await pm2.restore()).toBe(1);
    expect(await pm2.closeAll(ExitReason.Kill)).toBe(1);
    expect(store.outcomes.get(sig.id)?.close_reason).toBe("kill");
  });

  it("helpers", () => {
    expect(outcomeOf(0.2)).toBe("win");
    expect(outcomeOf(-0.2)).toBe("loss");
    expect(outcomeOf(0.01)).toBe("breakeven");
    expect(closeReasonOf({ state: { events: [] } } as never)).toBe("open");
  });
});
