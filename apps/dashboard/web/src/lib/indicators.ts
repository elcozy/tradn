/** Chart overlays computed in the browser from the loaded candles. Mirrors research/indicators.py. */
/** Minimal candle shape (structurally compatible with api.Candle; declared locally so this module
 * compiles under both the app's NodeNext config and the web bundler config). */
export interface OhlcBar {
  time: number;
  close: number;
}

export interface BandPoint {
  time: number;
  upper: number;
  mid: number;
  lower: number;
}

/**
 * Bollinger Bands: SMA(n) of close with a population standard deviation band at +/- k.
 * Returns points only from bar n-1 onward (a shorter window would misstate the band).
 */
export function bollinger(candles: OhlcBar[], n = 20, k = 2): BandPoint[] {
  if (candles.length < n || n < 2) return [];
  const out: BandPoint[] = [];
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!.close;
    sum += c;
    sumSq += c * c;
    if (i >= n) {
      const drop = candles[i - n]!.close;
      sum -= drop;
      sumSq -= drop * drop;
    }
    if (i < n - 1) continue;
    const mid = sum / n;
    const variance = Math.max(0, sumSq / n - mid * mid); // population variance, matches pandas std(ddof=0)
    const sd = Math.sqrt(variance);
    out.push({ time: candles[i]!.time, mid, upper: mid + k * sd, lower: mid - k * sd });
  }
  return out;
}
