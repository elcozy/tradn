/**
 * Exchange precision rules (Binance exchangeInfo filters) applied with decimal.js, never floats:
 * prices round to the tick, quantities round DOWN to the step, and anything under the minimum
 * quantity or notional is rejected before an order is ever built.
 */
import { Decimal } from "decimal.js";

export interface SymbolFilters {
  tickSize: string; // PRICE_FILTER.tickSize, e.g. "0.01"
  stepSize: string; // LOT_SIZE.stepSize, e.g. "0.00001"
  minQty: string; // LOT_SIZE.minQty
  minNotional: string; // NOTIONAL.minNotional (quote)
}

export enum MinimumViolation {
  Quantity = "below_min_qty",
  Notional = "below_min_notional",
}

/** Number of decimals implied by a step like "0.00100000" -> 3. */
export function decimalsOf(step: string): number {
  const d = new Decimal(step);
  if (d.lte(0)) throw new Error(`invalid step ${step}`);
  return d.decimalPlaces();
}

export function roundPriceToTick(price: number, tickSize: string): number {
  const tick = new Decimal(tickSize);
  return new Decimal(price).div(tick).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul(tick).toNumber();
}

export function roundQtyDownToStep(qty: number, stepSize: string): number {
  const step = new Decimal(stepSize);
  return new Decimal(qty).div(step).toDecimalPlaces(0, Decimal.ROUND_DOWN).mul(step).toNumber();
}

/** Round a quantity down to the step and check the exchange minimums at `price`. */
export function applyFilters(
  qty: number,
  price: number,
  f: SymbolFilters | undefined,
): { qty: number; violation: MinimumViolation | null } {
  if (!f) return { qty, violation: null };
  const rounded = roundQtyDownToStep(qty, f.stepSize);
  if (new Decimal(rounded).lt(f.minQty)) return { qty: rounded, violation: MinimumViolation.Quantity };
  if (new Decimal(rounded).mul(price).lt(f.minNotional)) return { qty: rounded, violation: MinimumViolation.Notional };
  return { qty: rounded, violation: null };
}

/** Format a number for the exchange with exactly the decimals the step allows (no exponent notation). */
export function formatToStep(value: number, step: string): string {
  return new Decimal(value).toFixed(decimalsOf(step));
}
