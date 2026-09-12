/** Wilder ATR and RSI — ports of research/indicators.py (pandas ewm alpha=1/n, adjust=False). */
import type { Candle } from "./db.js";

export function trueRange(c: Candle[]): number[] {
  return c.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const pc = c[i - 1]!.close;
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
  });
}

function wilder(values: number[], n: number): number[] {
  const a = 1 / n;
  const out: number[] = [];
  let prev = NaN;
  for (const v of values) {
    prev = Number.isNaN(prev) ? v : a * v + (1 - a) * prev;
    out.push(prev);
  }
  return out;
}

export function atrSeries(c: Candle[], n = 14): number[] {
  return wilder(trueRange(c), n);
}

export function atr(c: Candle[], n = 14): number {
  const s = atrSeries(c, n);
  return s[s.length - 1] ?? NaN;
}

export function rsi(closes: number[], n = 14): number {
  const ups: number[] = [0];
  const downs: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    ups.push(Math.max(d, 0));
    downs.push(Math.max(-d, 0));
  }
  const au = wilder(ups, n);
  const ad = wilder(downs, n);
  const u = au[au.length - 1]!;
  const d = ad[ad.length - 1]!;
  if (u === 0 && d === 0) return 50;
  if (d === 0) return 100;
  return 100 - 100 / (1 + u / d);
}
