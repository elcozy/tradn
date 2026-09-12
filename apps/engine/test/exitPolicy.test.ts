/** Cross-language test: reads the Python fixtures directly (not copies). */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExitParamsSchema } from "../src/config.js";
import { ExitReason, ExitState, closeManual, maeR, mfeR, openPosition, realizedR, step } from "../src/positions/exitPolicy.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../services/research/tests/fixtures");
const files = readdirSync(fixtures).filter((f) => /^exit_policy_case_.*\.json$/.test(f)).sort();
const P = (over: Record<string, unknown> = {}) => ExitParamsSchema.parse(over);

describe("exit policy matches python fixtures", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    it(f, () => {
      const c = JSON.parse(readFileSync(join(fixtures, f), "utf8"));
      const params = ExitParamsSchema.parse(c.params);
      const pos = openPosition(c.entry, c.qty, c.sl, c.tp, params, c.tp1 ?? null);
      for (const b of c.bars) step(pos, b, params);
      expect({
        state: pos.state,
        sl: Math.round(pos.sl * 1e6) / 1e6,
        tp: Math.round(pos.tp * 1e6) / 1e6,
        remaining_qty: pos.remaining_qty,
        highest_high: pos.highest_high,
        lowest_low: pos.lowest_low,
        events: pos.events,
      }).toEqual(c.expected);
    });
  }
});

describe("exit policy invariants", () => {
  it("rejects bad geometry", () => {
    expect(() => openPosition(100, 1, 101, 110, P())).toThrow();
    expect(() => openPosition(100, 1, 95, 99, P())).toThrow();
  });
  it("trailing never lowers the stop", () => {
    const p = P({ trail_atr_k: 1 });
    const pos = openPosition(100, 1, 95, 130, p);
    step(pos, { high: 106, low: 99, close: 106, atr: 1 }, p);
    const sl = pos.sl;
    step(pos, { high: 106, low: 104, close: 104, atr: 3 }, p);
    expect(pos.sl).toBe(sl);
  });
  it("manual close and realized R", () => {
    const p = P({ fee_pct: 0 });
    const pos = openPosition(100, 2, 96, 116, p);
    step(pos, { high: 104.5, low: 100, close: 104, atr: 1 }, p);
    closeManual(pos, 106, ExitReason.Regime);
    const [r, fees] = realizedR(pos, 0);
    expect(r).toBeCloseTo(1.25, 10);
    expect(fees).toBe(0);
    expect(pos.state).toBe(ExitState.Closed);
  });
  it("fees reduce realized R", () => {
    const p = P({ fee_pct: 0.1 });
    const pos = openPosition(100, 1, 99, 110, p);
    closeManual(pos, 100, ExitReason.Manual);
    const [r, fees] = realizedR(pos, 0.1);
    expect(r).toBeCloseTo(-0.2, 10);
    expect(fees).toBeCloseTo(0.2, 10);
  });
  it("mfe / mae", () => {
    const p = P();
    const pos = openPosition(100, 1, 95, 120, p);
    step(pos, { high: 110, low: 97.5, close: 105, atr: 1 }, p);
    expect(mfeR(pos)).toBeCloseTo(2, 10);
    expect(maeR(pos)).toBeCloseTo(0.5, 10);
  });
});
