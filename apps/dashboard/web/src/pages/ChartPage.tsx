import { ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type LogicalRange, type SeriesMarker, type Time, type UTCTimestamp } from "lightweight-charts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmt, get, useLive, type Candle, type Config, type PositionRow, type SignalRow } from "../api";
import { TF_SECONDS, outcomeColor, signalCandleTime, trailPath } from "../lib/trail";

interface Props { config: Config; tick: number; selectedSignal: string | null; onSelectSignal: (id: string | null) => void }

/** Visible history. Upper-case so it cannot be confused with the candle timeframe picker (15m = 15 minutes). */
const RANGES: { label: string; seconds: number | null }[] = [
  { label: "1D", seconds: 86400 }, { label: "3D", seconds: 3 * 86400 }, { label: "1W", seconds: 7 * 86400 }, { label: "1MO", seconds: 30 * 86400 },
  { label: "3MO", seconds: 90 * 86400 }, { label: "6MO", seconds: 180 * 86400 }, { label: "1Y", seconds: 365 * 86400 }, { label: "ALL", seconds: null },
];
const PAGE = 1500;

export function ChartPage({ config, tick, selectedSignal, onSelectSignal }: Props) {
  const [symbol, setSymbol] = useState(config.symbols[0] ?? "BTCUSDT");
  const [tf, setTf] = useState(config.timeframes[0] ?? "15m");
  const [range, setRange] = useState("1W");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [detail, setDetail] = useState<{ signal: SignalRow; position: PositionRow | null; events: any[] } | null>(null);
  const [lastLive, setLastLive] = useState<Candle | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const trail = useRef<ISeriesApi<"Line"> | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const candlesRef = useRef<Candle[]>([]);
  candlesRef.current = candles;
  const tfs = config.chart_timeframes ?? config.timeframes;

  // initial load for symbol / tf / range
  useEffect(() => {
    const r = RANGES.find((x) => x.label === range)!;
    const q = new URLSearchParams({ symbol, tf, limit: String(r.seconds === null ? 50000 : Math.min(50000, Math.ceil(r.seconds / (TF_SECONDS[tf] ?? 900)) + 5)) });
    if (r.seconds !== null) q.set("from", new Date(Date.now() - r.seconds * 1000).toISOString());
    setExhausted(false);
    get<Candle[]>(`/api/candles?${q}`).then((c) => {
      setCandles(c);
      series.current?.setData(c.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
      chart.current?.timeScale().fitContent();
    }).catch(console.error);
  }, [symbol, tf, range]);

  // lazy-load older candles when scrolled near the left edge
  const loadOlder = useCallback(async () => {
    const first = candlesRef.current[0];
    if (!first || loadingOlder || exhausted) return;
    setLoadingOlder(true);
    try {
      const older = await get<Candle[]>(`/api/candles?symbol=${symbol}&tf=${tf}&limit=${PAGE}&to=${new Date(first.time * 1000).toISOString()}`);
      if (older.length === 0) setExhausted(true);
      else {
        const merged = [...older, ...candlesRef.current];
        setCandles(merged);
        series.current?.setData(merged.map((k) => ({ ...k, time: k.time as UTCTimestamp })));
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [symbol, tf, loadingOlder, exhausted]);

  useEffect(() => {
    get<{ rows: SignalRow[] }>(`/api/signals?symbol=${symbol}&limit=300`).then((r) => setSignals(r.rows.filter((s) => s.timeframe === tf))).catch(console.error);
    get<PositionRow[]>("/api/positions").then((p) => setPositions(p.filter((x) => x.symbol === symbol))).catch(console.error);
  }, [symbol, tf, tick]);
  useEffect(() => {
    if (!selectedSignal) return setDetail(null);
    get<{ signal: SignalRow; position: PositionRow | null; events: any[] }>(`/api/signals/${encodeURIComponent(selectedSignal)}`).then(setDetail).catch(console.error);
  }, [selectedSignal, tick]);

  // live: forming candles every tick (base tf, or aggregated into the resampled tf) and closed candles
  useLive((m) => {
    if (m.kind !== "candle" && m.kind !== "live") return;
    if (m.symbol !== symbol) return;
    const step = TF_SECONDS[tf] ?? 900;
    let k: Candle;
    if (m.tf === tf) k = m.candle;
    else if (m.tf === "15m" && step > 900 && step % 900 === 0) {
      // aggregate a 15m update into the current bucket of the displayed timeframe
      const bucket = m.candle.time - (m.candle.time % step);
      const last = candlesRef.current[candlesRef.current.length - 1];
      const cur = last && last.time === bucket ? last : null;
      const prevInBucket = cur && cur.time === bucket && m.candle.time !== bucket ? cur : null;
      k = prevInBucket
        ? { time: bucket, open: prevInBucket.open, high: Math.max(prevInBucket.high, m.candle.high), low: Math.min(prevInBucket.low, m.candle.low), close: m.candle.close, volume: prevInBucket.volume + (m.kind === "candle" ? m.candle.volume : 0) }
        : { ...m.candle, time: bucket };
    } else return;
    series.current?.update({ ...k, time: k.time as UTCTimestamp });
    setLastLive(k);
    setCandles((c) => (c.length && c[c.length - 1]!.time === k.time ? [...c.slice(0, -1), k] : c.length && c[c.length - 1]!.time > k.time ? c : [...c, k]));
  });

  // chart lifecycle
  useEffect(() => {
    if (!box.current) return;
    const c = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "#121821" }, textColor: "#9ca3af" },
      grid: { vertLines: { color: "#1f2937" }, horzLines: { color: "#1f2937" } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    series.current = c.addCandlestickSeries({ upColor: "#22c55e", downColor: "#ef4444", wickUpColor: "#22c55e", wickDownColor: "#ef4444", borderVisible: false });
    trail.current = c.addLineSeries({ color: "#f59e0b", lineWidth: 2, lineStyle: LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false });
    chart.current = c;
    return () => c.remove();
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const h = (r: LogicalRange | null) => {
      if (r && r.from < 50) void loadOlder();
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(h);
    return () => c.timeScale().unsubscribeVisibleLogicalRangeChange(h);
  }, [loadOlder]);

  const markers = useMemo<SeriesMarker<Time>[]>(
    () =>
      signals
        .map((s) => ({
          time: signalCandleTime(s.ts, s.timeframe) as UTCTimestamp,
          position: "belowBar" as const,
          shape: (s.id === selectedSignal ? "arrowUp" : "circle") as "arrowUp" | "circle",
          color: outcomeColor(s.outcome, s.position_id),
          text: s.outcome === "rejected" ? "✕" : s.realized_r != null ? fmt.r(s.realized_r) : "",
          id: s.id,
        }))
        .sort((a, b) => (a.time as number) - (b.time as number)),
    [signals, selectedSignal],
  );
  useEffect(() => {
    series.current?.setMarkers(markers);
  }, [markers, candles.length]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const h = (p: { time?: Time }) => {
      if (!p.time) return;
      const hit = signals.find((s) => signalCandleTime(s.ts, s.timeframe) === (p.time as number));
      if (hit) onSelectSignal(hit.id);
    };
    c.subscribeClick(h);
    return () => c.unsubscribeClick(h);
  }, [signals, onSelectSignal]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.removePriceLine(l);
    lines.current = [];
    trail.current?.setData([]);
    const add = (price: number | null | undefined, title: string, color: string, style = LineStyle.Solid) => {
      if (price == null) return;
      lines.current.push(s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    };
    if (detail) {
      const sig = detail.signal;
      add(sig.actual_entry ?? sig.entry_price, "entry", "#3b82f6");
      add(sig.stop_price, "stop", "#ef4444");
      add(sig.tp1_price, "tp1", "#22c55e", LineStyle.Dashed);
      add(sig.tp_price, "tp", "#22c55e");
      add(typeof sig.meta?.level === "number" ? (sig.meta.level as number) : null, "level", "#a78bfa", LineStyle.Dotted);
      add(typeof sig.meta?.next_resistance === "number" ? (sig.meta.next_resistance as number) : null, "resistance", "#a78bfa", LineStyle.Dotted);
      if (detail.position) {
        const p = detail.position;
        const pts = trailPath(Math.floor(new Date(p.opened_at).getTime() / 1000), p.timeframe, p.sl_initial, detail.events);
        trail.current?.setData(pts.map((x) => ({ time: x.time as UTCTimestamp, value: x.value })));
        if (p.state !== "closed") add(p.sl_price, "current stop", "#f59e0b");
      }
    } else {
      for (const p of positions.filter((x) => x.timeframe === tf)) {
        add(p.entry_price, "entry", "#3b82f6");
        add(p.sl_price, "stop", "#ef4444");
        add(p.tp_price, "tp", "#22c55e");
      }
    }
  }, [detail, positions, tf]);

  return (
    <div className="chart-layout">
      <div className="panel">
        <div className="toolbar">
          <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>{config.symbols.map((s) => <option key={s}>{s}</option>)}</select>
          <label className="flat">candle</label>
          <select value={tf} onChange={(e) => setTf(e.target.value)}>{tfs.map((t) => <option key={t}>{t}</option>)}</select>
          <label className="flat">history</label>
          <span className="seg">{RANGES.map((r) => <button key={r.label} className={`btn ${range === r.label ? "active" : ""}`} onClick={() => setRange(r.label)}>{r.label}</button>)}</span>
          {selectedSignal && <button className="btn" onClick={() => onSelectSignal(null)}>clear selection</button>}
          <span className="pill">{candles.length} candles · {signals.length} signals{loadingOlder ? " · loading older…" : exhausted ? " · start of data" : ""}</span>
          {lastLive && <span className="pill on">last {fmt.price(lastLive.close)}</span>}
          <div className="spacer" style={{ flex: 1 }} />
          <a href={`https://www.tradingview.com/chart/?symbol=BINANCE:${symbol}`} target="_blank" rel="noreferrer">open on TradingView ↗</a>
        </div>
        <div ref={box} className="chart" />
        <div className="flat" style={{ marginTop: 6 }}>scroll left to load older candles · scroll to zoom · click a marker to inspect a signal</div>
      </div>
      <div className="panel scroll">
        <h3>{detail ? "selected signal" : "signals on this chart"}</h3>
        {detail ? <SignalDetail d={detail} /> : (
          <table>
            <thead><tr><th>time</th><th>entry</th><th>R</th><th>outcome</th></tr></thead>
            <tbody>
              {[...signals].reverse().map((s) => (
                <tr key={s.id} className="click" onClick={() => onSelectSignal(s.id)}>
                  <td>{fmt.time(s.ts)}</td><td>{fmt.price(s.entry_price)}</td>
                  <td>{s.realized_r != null ? fmt.r(s.realized_r) : s.projected_r != null ? `(${fmt.r(s.projected_r)})` : "–"}</td>
                  <td className={s.outcome ?? (s.position_id ? "open" : "")}>{s.outcome ?? (s.position_id ? "open" : "pending")}</td>
                </tr>
              ))}
              {signals.length === 0 && <tr><td colSpan={4} className="flat">no signals for {symbol} {tf} yet</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SignalDetail({ d }: { d: { signal: SignalRow; position: PositionRow | null; events: any[] } }) {
  const s = d.signal;
  return (
    <div className="grid" style={{ gap: 8 }}>
      <div><b>{s.symbol} {s.timeframe}</b> · {s.strategy_id} · {fmt.time(s.ts)}</div>
      <div>entry {fmt.price(s.actual_entry ?? s.entry_price)} · stop {fmt.price(s.stop_price)} · tp1 {fmt.price(s.tp1_price)} · tp {fmt.price(s.tp_price)} · projected {fmt.r(s.projected_r)}</div>
      <div className={s.outcome ?? "open"}>
        {s.outcome === "rejected" ? `rejected: ${s.reject_reason}` : s.outcome ? `${s.outcome} ${fmt.r(s.realized_r)} · ${s.close_reason} · ${s.bars_held} bars · mfe ${fmt.r(s.mfe_r)} mae ${fmt.r(s.mae_r)}` : s.position_id ? `open · ${d.position?.state} · stop now ${fmt.price(d.position?.sl_price)}` : "pending"}
      </div>
      <div><h3>why</h3><pre>{JSON.stringify(s.meta, null, 1)}</pre></div>
      {d.events.length > 0 && (
        <div><h3>events</h3><table><tbody>{d.events.map((e, i) => <tr key={i}><td>bar {e.bar}</td><td>{e.type}</td><td>{fmt.price(e.price)}</td><td>{e.reason ?? ""}</td></tr>)}</tbody></table></div>
      )}
    </div>
  );
}
