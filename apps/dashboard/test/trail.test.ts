import { describe, expect, it } from "vitest";
import { outcomeColor, signalCandleTime, trailPath } from "../web/src/lib/trail.js";

describe("trail helpers", () => {
  it("builds an ascending stop path from sl_moved events and ends at close", () => {
    const pts = trailPath(1000, "15m", 95, [
      { bar: 1, type: "tp_partial", price: 104 },
      { bar: 1, type: "sl_moved", price: 100.2, reason: "breakeven" },
      { bar: 1, type: "sl_moved", price: 102.5, reason: "trailing" },
      { bar: 3, type: "sl_moved", price: 105.6, reason: "trailing" },
      { bar: 5, type: "closed", price: 105.6, reason: "stop" },
    ]);
    expect(pts).toEqual([
      { time: 1000, value: 95 },
      { time: 1900, value: 102.5 }, // last value wins for the same bar
      { time: 3700, value: 105.6 },
      { time: 5500, value: 105.6 },
    ]);
  });
  it("puts the signal marker on the candle that closed at ts", () => {
    expect(signalCandleTime("2026-09-12T14:15:00Z", "15m")).toBe(Math.floor(Date.parse("2026-09-12T14:00:00Z") / 1000));
  });
  it("colors by outcome", () => {
    expect(outcomeColor("win", null)).toBe("#22c55e");
    expect(outcomeColor(null, "pos")).toBe("#3b82f6");
    expect(outcomeColor(null, null)).toBe("#eab308");
  });
});
