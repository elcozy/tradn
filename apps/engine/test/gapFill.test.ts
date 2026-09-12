import { describe, expect, it } from "vitest";
import { fillGap, lastClosedOpenMs, toCcxtSymbol, type KlineFetcher, type OhlcvRow } from "../src/marketdata/gapFill.js";

const TF = 900_000; // 15m

/** Minimal fake of the `postgres` tagged-template client: records upserts, answers lastCandleTime. */
function fakeSql(last: Date | null) {
  const written: Date[] = [];
  const sql = (async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join("?");
    if (q.includes("max(open_time)")) return [{ t: last }];
    if (q.startsWith("\n    INSERT INTO candles")) {
      written.push(vals[2] as Date);
      return [];
    }
    throw new Error(`unexpected query: ${q}`);
  }) as unknown as import("../src/db.js").Sql;
  return { sql, written };
}

function fakeFetcher(available: number[]): KlineFetcher & { calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    async fetchOHLCV(_s, _tf, since, limit) {
      calls.push(since);
      return available.filter((t) => t >= since).slice(0, limit).map((t) => [t, 1, 2, 0.5, 1.5, 10] as OhlcvRow);
    },
  };
}

describe("gap fill helpers", () => {
  it("maps symbols", () => {
    expect(toCcxtSymbol("BTCUSDT")).toBe("BTC/USDT");
    expect(() => toCcxtSymbol("XYZ")).toThrow();
  });
  it("computes the last closed candle open time", () => {
    expect(lastClosedOpenMs(10 * TF + 1, TF)).toBe(9 * TF);
    expect(lastClosedOpenMs(10 * TF, TF)).toBe(9 * TF);
  });
});

describe("fillGap", () => {
  it("fetches exactly the missing closed candles after the last stored one", async () => {
    const last = new Date(5 * TF);
    const now = 10 * TF + 1000; // candle 10 is forming, 9 is the last closed
    const { sql, written } = fakeSql(last);
    const fetcher = fakeFetcher([6, 7, 8, 9, 10].map((i) => i * TF));
    const res = await fillGap(sql, fetcher, "BTCUSDT", "15m", { nowMs: now });
    expect(res.fetched).toBe(4);
    expect(written.map((d) => d.getTime() / TF)).toEqual([6, 7, 8, 9]);
    expect(fetcher.calls[0]).toBe(6 * TF);
  });

  it("does nothing when already up to date", async () => {
    const { sql, written } = fakeSql(new Date(9 * TF));
    const fetcher = fakeFetcher([10 * TF]);
    const res = await fillGap(sql, fetcher, "BTCUSDT", "15m", { nowMs: 10 * TF + 1000 });
    expect(res.fetched).toBe(0);
    expect(written).toHaveLength(0);
    expect(fetcher.calls).toHaveLength(0);
  });

  it("bootstraps N bars when the table is empty", async () => {
    const { sql, written } = fakeSql(null);
    const all = Array.from({ length: 30 }, (_, i) => i * TF);
    const fetcher = fakeFetcher(all);
    const res = await fillGap(sql, fetcher, "BTCUSDT", "15m", { nowMs: 20 * TF + 5, bootstrapBars: 5 });
    expect(res.fetched).toBe(5);
    expect(written.map((d) => d.getTime() / TF)).toEqual([15, 16, 17, 18, 19]);
  });

  it("pages through large gaps", async () => {
    const { sql, written } = fakeSql(new Date(0));
    const all = Array.from({ length: 25 }, (_, i) => i * TF);
    const fetcher = fakeFetcher(all);
    await fillGap(sql, fetcher, "BTCUSDT", "15m", { nowMs: 24 * TF + 5, pageSize: 10 });
    expect(written).toHaveLength(23); // candles 1..23
    expect(fetcher.calls).toEqual([1 * TF, 11 * TF, 21 * TF]);
  });
});
