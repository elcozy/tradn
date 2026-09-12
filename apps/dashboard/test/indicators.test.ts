import { describe, expect, it } from "vitest";
import { bollinger, type OhlcBar } from "../web/src/lib/indicators.js";

const mk = (closes: number[]): OhlcBar[] => closes.map((c, i) => ({ time: i * 900, close: c }));

describe("bollinger", () => {
  it("is flat with zero width on constant prices", () => {
    const b = bollinger(mk(Array(30).fill(100)), 20, 2);
    expect(b).toHaveLength(11);
    expect(b[0]).toMatchObject({ mid: 100, upper: 100, lower: 100 });
  });
  it("matches a hand-computed window", () => {
    // closes 1..5, n=5: mean 3, population sd = sqrt(2) ≈ 1.4142
    const b = bollinger(mk([1, 2, 3, 4, 5]), 5, 2);
    expect(b).toHaveLength(1);
    expect(b[0]!.mid).toBeCloseTo(3, 10);
    expect(b[0]!.upper).toBeCloseTo(3 + 2 * Math.SQRT2, 10);
    expect(b[0]!.lower).toBeCloseTo(3 - 2 * Math.SQRT2, 10);
  });
  it("rolls the window forward", () => {
    const b = bollinger(mk([1, 2, 3, 4, 5, 6]), 5, 2);
    expect(b).toHaveLength(2);
    expect(b[1]!.mid).toBeCloseTo(4, 10); // mean of 2..6
    expect(b[1]!.time).toBe(5 * 900);
  });
  it("returns nothing when there are too few candles", () => {
    expect(bollinger(mk([1, 2, 3]), 20)).toEqual([]);
    expect(bollinger(mk(Array(30).fill(1)), 1)).toEqual([]);
  });
  it("bands widen with volatility", () => {
    const calm = bollinger(mk(Array.from({ length: 25 }, (_, i) => 100 + (i % 2))), 20, 2).at(-1)!;
    const wild = bollinger(mk(Array.from({ length: 25 }, (_, i) => 100 + (i % 2) * 20)), 20, 2).at(-1)!;
    expect(wild.upper - wild.lower).toBeGreaterThan(calm.upper - calm.lower);
  });
});
