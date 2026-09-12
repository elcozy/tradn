import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, get, type PositionRow } from "../api";

interface Status { mode: string; engine: { paused: boolean; news_block: boolean; last_candle_at: string | null; last_heartbeat: string | null } | null; open_positions: number; today: { signals: number; rejected: number; closed: number; r: number; pnl: number } }

export function OverviewPage({ tick, onShowOnChart }: { tick: number; onShowOnChart: (id: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [daily, setDaily] = useState<{ day: string; trades: number; r: number; pnl: number }[]>([]);
  const [events, setEvents] = useState<Record<string, any>[]>([]);
  useEffect(() => {
    get<Status>("/api/status").then(setStatus).catch(console.error);
    get<PositionRow[]>("/api/positions").then(setPositions).catch(console.error);
    get<typeof daily>("/api/daily").then(setDaily).catch(console.error);
    get<typeof events>("/api/events?limit=30").then(setEvents).catch(console.error);
  }, [tick]);
  if (!status) return <div>loading…</div>;
  const e = status.engine;
  const cum = daily.reduce<{ day: string; r: number; cum: number }[]>((acc, d) => [...acc, { day: d.day.slice(0, 10), r: d.r, cum: (acc[acc.length - 1]?.cum ?? 0) + d.r }], []);
  return (
    <div className="grid">
      <div className="grid cols-3">
        <div className="panel stat"><b>{e?.paused ? "⏸ paused" : "▶ running"}{e?.news_block ? " · 📰" : ""}</b><span>last candle {fmt.ago(e?.last_candle_at)} · heartbeat {fmt.ago(e?.last_heartbeat)}</span></div>
        <div className="panel stat"><b>{status.today.signals} signals today</b><span>{status.today.rejected} rejected · {status.today.closed} closed · {fmt.r(status.today.r)}</span></div>
        <div className="panel stat"><b>{status.open_positions} open</b><span>{status.mode} mode</span></div>
      </div>
      <div className="grid cols-2">
        <div className="panel">
          <h3>open positions</h3>
          {positions.length === 0 ? <div className="flat">none</div> : (
            <table><thead><tr><th>symbol</th><th>state</th><th>entry</th><th>stop</th><th>tp</th><th>bars</th></tr></thead>
              <tbody>{positions.map((p) => <tr key={p.id} className="click" onClick={() => onShowOnChart(p.signal_id)}><td>{p.symbol} {p.timeframe}</td><td>{p.state}</td><td>{fmt.price(p.entry_price)}</td><td>{fmt.price(p.sl_price)}</td><td>{fmt.price(p.tp_price)}</td><td>{p.bars_held}</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="panel">
          <h3>cumulative R by day</h3>
          <div style={{ height: 200 }}>
            <ResponsiveContainer><BarChart data={cum}><XAxis dataKey="day" hide /><YAxis width={40} /><Tooltip contentStyle={{ background: "#121821", border: "1px solid #1f2937" }} /><Bar dataKey="cum" fill="#3b82f6" /></BarChart></ResponsiveContainer>
          </div>
        </div>
      </div>
      <div className="panel">
        <h3>recent events</h3>
        <table><tbody>{events.map((ev) => <tr key={ev.id}><td>{fmt.time(ev.ts)}</td><td>{ev.type}</td><td>{ev.symbol ?? ""}</td><td>{ev.reason ?? ""}</td><td>{ev.sl_price ? `sl ${fmt.price(ev.sl_price)}` : ev.r_multiple != null ? fmt.r(ev.r_multiple) : ""}</td></tr>)}</tbody></table>
      </div>
    </div>
  );
}
