import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EngineCommandSchema } from "@trading/contracts";
import { applyCommand } from "../src/commands/consumer.js";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import { EngineEventType, MemoryEventSink } from "../src/events.js";
import { ShadowAdapter } from "../src/execution/shadow.js";
import { PositionManager } from "../src/positions/manager.js";
import { MemoryPositionStore } from "../src/positions/store.js";
import { parseEntry } from "../src/signals/consumer.js";
import { MemoryStateStore } from "../src/state.js";
import { withFixtureStrategyEnabled } from "./testConfig.js";

const cfg = withFixtureStrategyEnabled(parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8")));
const cmd = (type: string) => EngineCommandSchema.parse({ v: 1, ts: new Date().toISOString(), source: "telegram", type });

describe("commands", () => {
  it("pause / resume / news toggles flip state and emit events", async () => {
    const state = new MemoryStateStore();
    const sink = new MemoryEventSink();
    const pm = new PositionManager(cfg, new MemoryPositionStore(), sink, new ShadowAdapter());
    await applyCommand(cmd("pause"), state, pm, sink);
    expect(state.flags.paused).toBe(true);
    await applyCommand(cmd("resume"), state, pm, sink);
    expect(state.flags.paused).toBe(false);
    await applyCommand(cmd("news_on"), state, pm, sink);
    expect(state.flags.news_block).toBe(true);
    await applyCommand(cmd("news_off"), state, pm, sink);
    expect(state.flags.news_block).toBe(false);
    expect(sink.ofType(EngineEventType.Paused)).toHaveLength(2);
    expect(sink.ofType(EngineEventType.Resumed)).toHaveLength(2);
  });
  it("kill closes everything and pauses", async () => {
    const state = new MemoryStateStore();
    const sink = new MemoryEventSink();
    const pm = new PositionManager(cfg, new MemoryPositionStore(), sink, new ShadowAdapter());
    await applyCommand(cmd("kill"), state, pm, sink);
    expect(state.flags.paused).toBe(true);
    expect(sink.ofType(EngineEventType.KillSwitch)[0]?.detail).toEqual({ closed: 0 });
  });
});

describe("signal stream parsing", () => {
  const valid = readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8");
  it("parses a valid entry", () => {
    expect(parseEntry(["json", valid])?.symbol).toBe("BTCUSDT");
  });
  it("returns null for invalid or missing json", () => {
    expect(parseEntry(["json", JSON.stringify({ v: 2 })])).toBeNull();
    expect(parseEntry(["other", "x"])).toBeNull();
  });
});
