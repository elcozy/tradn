import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EngineCommandSchema, EngineEventSchema, SignalSchema, TIMEFRAME_MS, TIMEFRAMES } from "../src/index.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (f: string) => JSON.parse(readFileSync(join(fixtures, f), "utf8"));

describe("contracts", () => {
  it("accepts the shared signal fixture", () => {
    const s = SignalSchema.parse(load("signal.valid.json"));
    expect(s.symbol).toBe("BTCUSDT");
    expect(s.exit?.trail_atr_k).toBe(2);
  });
  it("rejects an unknown version", () => {
    expect(() => SignalSchema.parse({ ...load("signal.valid.json"), v: 2 })).toThrow();
  });
  it("rejects an extra field", () => {
    expect(() => SignalSchema.parse({ ...load("signal.valid.json"), extra: 1 })).toThrow();
  });
  it("rejects a non-positive stop", () => {
    expect(() => SignalSchema.parse({ ...load("signal.valid.json"), stop_price: 0 })).toThrow();
  });
  it("accepts engine event and command fixtures", () => {
    expect(EngineEventSchema.parse(load("engine_event.valid.json")).type).toBe("sl_moved");
    expect(EngineCommandSchema.parse(load("engine_command.valid.json")).type).toBe("pause");
  });
  it("rejects an unknown event type", () => {
    expect(() => EngineEventSchema.parse({ ...load("engine_event.valid.json"), type: "nope" })).toThrow();
  });
  it("has a duration for every timeframe", () => {
    for (const tf of TIMEFRAMES) expect(TIMEFRAME_MS[tf]).toBeGreaterThan(0);
  });
});
