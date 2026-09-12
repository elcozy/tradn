import { describe, expect, it } from "vitest";
import { parseFilters } from "../src/execution/exchangeInfo.js";
import { MinimumViolation, applyFilters, decimalsOf, formatToStep, roundPriceToTick, roundQtyDownToStep } from "../src/execution/precision.js";

const btc = { tickSize: "0.01000000", stepSize: "0.00001000", minQty: "0.00001000", minNotional: "5.00000000" };

describe("precision", () => {
  it("decimals of a step", () => {
    expect(decimalsOf("0.00001000")).toBe(5);
    expect(decimalsOf("1.00000000")).toBe(0);
    expect(decimalsOf("0.1")).toBe(1);
  });
  it("rounds price to the tick (half up) and qty DOWN to the step", () => {
    expect(roundPriceToTick(61234.567, btc.tickSize)).toBe(61234.57);
    expect(roundPriceToTick(61234.564, btc.tickSize)).toBe(61234.56);
    expect(roundQtyDownToStep(0.040829999, btc.stepSize)).toBe(0.04082);
    expect(roundQtyDownToStep(0.1 + 0.2, "0.1")).toBe(0.3); // no float garbage
  });
  it("formats with exactly the step's decimals", () => {
    expect(formatToStep(0.04082, btc.stepSize)).toBe("0.04082");
    expect(formatToStep(61234.5, btc.tickSize)).toBe("61234.50");
    expect(formatToStep(1e-7, "0.00000001")).toBe("0.00000010");
  });
  it("rejects below minimum quantity or notional", () => {
    expect(applyFilters(0.000005, 60000, btc)).toEqual({ qty: 0, violation: MinimumViolation.Quantity });
    expect(applyFilters(0.00005, 60000, btc)).toEqual({ qty: 0.00005, violation: MinimumViolation.Notional }); // 3 USDT < 5
    expect(applyFilters(0.001, 60000, btc)).toEqual({ qty: 0.001, violation: null });
    expect(applyFilters(0.123456789, 60000, undefined)).toEqual({ qty: 0.123456789, violation: null });
  });
  it("parses exchangeInfo filters", () => {
    const f = parseFilters([
      { filterType: "PRICE_FILTER", tickSize: "0.01000000" },
      { filterType: "LOT_SIZE", stepSize: "0.00001000", minQty: "0.00001000" },
      { filterType: "NOTIONAL", minNotional: "5.00000000" },
      { filterType: "PERCENT_PRICE_BY_SIDE" },
    ]);
    expect(f).toEqual(btc);
    expect(parseFilters([{ filterType: "LOT_SIZE", stepSize: "1", minQty: "1" }])).toBeNull();
  });
});
