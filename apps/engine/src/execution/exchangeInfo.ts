/** Symbol filters from Binance exchangeInfo (public, no keys), fetched once at start via ccxt. */
import { log } from "../log.js";
import type { SymbolFilters } from "./precision.js";

export interface FiltersSource {
  fetchFilters(symbols: string[]): Promise<Map<string, SymbolFilters>>;
}

interface RawFilter {
  filterType: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
}

/** Parse the `filters` array of one exchangeInfo symbol entry. */
export function parseFilters(filters: RawFilter[]): SymbolFilters | null {
  const price = filters.find((f) => f.filterType === "PRICE_FILTER");
  const lot = filters.find((f) => f.filterType === "LOT_SIZE");
  const notional = filters.find((f) => f.filterType === "NOTIONAL" || f.filterType === "MIN_NOTIONAL");
  if (!price?.tickSize || !lot?.stepSize || !lot.minQty) return null;
  return { tickSize: price.tickSize, stepSize: lot.stepSize, minQty: lot.minQty, minNotional: notional?.minNotional ?? "0" };
}

/** Production source: GET /api/v3/exchangeInfo through ccxt (testnet when sandbox is on). */
export function ccxtFiltersSource(sandbox = false): FiltersSource {
  return {
    async fetchFilters(symbols) {
      const ccxt = await import("ccxt");
      const ex = new ccxt.binance({ enableRateLimit: true });
      if (sandbox) ex.setSandboxMode(true);
      const info = (await (ex as unknown as { publicGetExchangeInfo(p: Record<string, string>): Promise<{ symbols: { symbol: string; filters: RawFilter[] }[] }> })
        .publicGetExchangeInfo({ symbols: JSON.stringify(symbols) }));
      const out = new Map<string, SymbolFilters>();
      for (const s of info.symbols) {
        const f = parseFilters(s.filters);
        if (f) out.set(s.symbol, f);
      }
      return out;
    },
  };
}

/** Never fail startup on a filters fetch: log and size without rounding instead. */
export async function loadFilters(source: FiltersSource, symbols: string[]): Promise<Map<string, SymbolFilters>> {
  try {
    const m = await source.fetchFilters(symbols);
    const missing = symbols.filter((s) => !m.has(s));
    if (missing.length) log.warn({ missing }, "no exchange filters for some symbols; sizing them unrounded");
    return m;
  } catch (err) {
    log.warn({ err }, "exchangeInfo fetch failed; sizing unrounded");
    return new Map();
  }
}
