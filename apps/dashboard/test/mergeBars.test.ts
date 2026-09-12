import { describe, expect, it } from "vitest";
import { mergeBars, type Bar } from "../src/api/server.js";

const bar = (time: number, open: number, high: number, low: number, close: number, volume = 1): Bar => ({ time, open, high, low, close, volume });

describe("mergeBars", () => {
  it("takes the first open, last close, extreme high/low and total volume", () => {
    const merged = mergeBars([bar(0, 10, 12, 9, 11, 2), bar(900, 11, 15, 8, 14, 3), bar(1800, 14, 14.5, 13, 13.5, 5)], 0);
    expect(merged).toEqual({ time: 0, open: 10, high: 15, low: 8, close: 13.5, volume: 10 });
  });
  it("stamps the bucket time, not the first bar's time", () => {
    expect(mergeBars([bar(950, 1, 2, 0.5, 1.5)], 900).time).toBe(900);
  });
  it("passes a single bar through unchanged apart from its time", () => {
    expect(mergeBars([bar(900, 1, 2, 0.5, 1.5, 7)], 900)).toEqual(bar(900, 1, 2, 0.5, 1.5, 7));
  });
});
