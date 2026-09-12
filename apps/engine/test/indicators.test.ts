import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Candle } from "../src/db.js";
import { atr, atrSeries, rsi, trueRange } from "../src/indicators.js";

const fx = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../services/research/tests/fixtures/indicators_case_1.json"), "utf8"),
);
const candles: Candle[] = fx.candles.map((c: any, i: number) => ({
  symbol: "X", timeframe: "15m", openTime: new Date(i * 900_000), open: c.open, high: c.high, low: c.low, close: c.close, volume: 1, closed: true,
}));

describe("indicators match python", () => {
  it("wilder ATR last value and tail", () => {
    expect(atr(candles, fx.n)).toBeCloseTo(fx.expected_atr_last, 8);
    const tail = atrSeries(candles, fx.n).slice(-5);
    tail.forEach((v, i) => expect(v).toBeCloseTo(fx.expected_atr_series_tail[i], 8));
  });
  it("RSI last value", () => {
    expect(rsi(candles.map((c) => c.close), fx.n)).toBeCloseTo(fx.expected_rsi_last, 6);
  });
  it("true range first bar is high-low", () => {
    expect(trueRange(candles)[0]).toBeCloseTo(candles[0]!.high - candles[0]!.low, 10);
  });
  it("RSI edge cases", () => {
    expect(rsi([1, 1, 1, 1], 3)).toBe(50);
    expect(rsi([1, 2, 3, 4], 3)).toBe(100);
  });
});
