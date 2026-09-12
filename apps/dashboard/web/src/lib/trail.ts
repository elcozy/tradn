/** Pure helpers shared by the chart: map journal events to chart-time series. */

export interface JournalEvent {
  bar: number;
  type: string;
  price?: number;
  qty?: number;
  reason?: string;
}

export const TF_SECONDS: Record<string, number> = {
  "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
};

/** Bar k of a position closes at opened_at + k*tf; the stop that applies *after* that bar is drawn from there. */
export function trailPath(openedAtSec: number, tf: string, slInitial: number, events: JournalEvent[]): { time: number; value: number }[] {
  const step = TF_SECONDS[tf] ?? 900;
  const pts: { time: number; value: number }[] = [{ time: openedAtSec, value: slInitial }];
  for (const ev of events) {
    if (ev.type !== "sl_moved" || ev.price === undefined) continue;
    pts.push({ time: openedAtSec + ev.bar * step, value: ev.price });
  }
  const closed = events.find((e) => e.type === "closed");
  if (closed) pts.push({ time: openedAtSec + closed.bar * step, value: pts[pts.length - 1]!.value });
  // lightweight-charts needs strictly ascending times: keep the last value per time
  const byTime = new Map<number, number>();
  for (const p of pts) byTime.set(p.time, p.value);
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time, value }));
}

/** Signal ts is the candle CLOSE time; the marker belongs on the candle that opened one tf earlier. */
export function signalCandleTime(tsIso: string, tf: string): number {
  return Math.floor(new Date(tsIso).getTime() / 1000) - (TF_SECONDS[tf] ?? 900);
}

export function outcomeColor(outcome: string | null, positionId: string | null): string {
  if (outcome === "win") return "#22c55e";
  if (outcome === "loss") return "#ef4444";
  if (outcome === "breakeven") return "#a3a3a3";
  if (outcome === "rejected") return "#6b7280";
  if (positionId) return "#3b82f6";
  return "#eab308";
}
