import { useEffect, useState } from "react";
import { Bar, BarChart, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, get, type PositionRow } from "../api";

interface Status {
  mode: string;
  engine: { paused: boolean; news_block: boolean; entries_enabled: boolean; balance_quote: number | null; last_candle_at: string | null; last_heartbeat: string | null } | null;
  open_positions: number;
  today: { signals: number; rejected: number; closed: number; r: number; pnl: number };
  limits: { daily_loss_r: number; daily_loss_quote: number | null };
}
interface EquityPoint { ts: string; balance_quote: number; unrealised: number; drawdown_pct: number; equity: number }

const tooltipStyle = { background: "#121821", border: "1px solid #1f2937" };

export function OverviewPage({ tick, onShowOnChart }: { tick: number; onShowOnChart: (id: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [daily, setDaily] = useState<{ day: string; trades: number; r: number; pnl: number }[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [events, setEvents] = useState<Record<string, any>[]>([]);
  useEffect(() => {
    get<Status>("/api/status").then(setStatus).catch(console.error);
    get<PositionRow[]>("/api/positions").then(setPositions).catch(console.error);
    get<typeof daily>("/api/daily").then(setDaily).catch(console.error);
    get<EquityPoint[]>("/api/equity").then(setEquity).catch(console.error);
    get<typeof events>("/api/events?limit=30").then(setEvents).catch(console.error);
  }, [tick]);
  if (!status) return <div>loading…</div>;
  const e = status.engine;
  const cum = daily.reduce<{ day: string; r: number; cum: number }[]>((acc, d) => [...acc, { day: d.day.slice(0, 10), r: d.r, cum: (acc[acc.length - 1]?.cum ?? 0) + d.r }], []);
  const eq = equity.map((p) => ({ t: p.ts.slice(5, 16).replace("T", " "), equity: Math.round(p.equity * 100) / 100, dd: p.drawdown_pct }));
  const lastEq = equity[equity.length - 1];
  const limitR = status.limits.daily_loss_r;
  const todayPct = Math.min(100, Math.max(0, (status.today.r / limitR) * 100)); // how much of the daily loss budget is used
  return (
    <div className="grid">
      <div className="grid cols-3">
        <div className="panel stat"><b>{e?.paused ? "⏸ paused" : "▶ running"}{e?.news_block ? " · 📰" : ""}{e && !e.entries_enabled ? " · entries off" : ""}</b><span>last candle {fmt.ago(e?.last_candle_at)} · heartbeat {fmt.ago(e?.last_heartbeat)}</span></div>
        <div className="panel stat"><b>{status.today.signals} signals today</b><span>{status.today.rejected} rejected · {status.today.closed} closed · {fmt.r(status.today.r)}</span></div>
        <div className="panel stat"><b>{status.open_positions} open</b><span>{status.mode} mode{lastEq ? ` · equity ${lastEq.equity.toFixed(2)} · dd ${lastEq.drawdown_pct.toFixed(2)}%` : e?.balance_quote != null ? ` · balance ${e.balance_quote.toFixed(2)}` : ""}</span></div>
      </div>
      <div className="grid cols-2">
        <div className="panel">
          <h3>today vs the daily loss limit</h3>
          <div className="stat">
            <b className={status.today.r < 0 ? "loss" : "win"}>{fmt.r(status.today.r)} <span style={{ fontSize: 13 }}>({status.today.pnl.toFixed(2)})</span></b>
            <span>limit {fmt.r(limitR)}{status.limits.daily_loss_quote != null ? ` (${status.limits.daily_loss_quote.toFixed(2)})` : ""} · {todayPct.toFixed(0)}% of the budget used</span>
          </div>
          <div style={{ height: 8, background: "#1f2937", borderRadius: 4, marginTop: 8 }}>
            <div style={{ height: 8, width: `${todayPct}%`, background: todayPct >= 100 ? "#ef4444" : todayPct >= 66 ? "#f59e0b" : "#22c55e", borderRadius: 4 }} />
          </div>
        </div>
        <div className="panel">
          <h3>cumulative R by day</h3>
          <div style={{ height: 160 }}>
            <ResponsiveContainer><BarChart data={cum}><XAxis dataKey="day" hide /><YAxis width={40} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="cum" fill="#3b82f6" /></BarChart></ResponsiveContainer>
          </div>
        </div>
      </div>
      {eq.length > 0 && (
        <div className="panel">
          <h3>equity curve (balance at cost + unrealised)</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={eq}>
                <XAxis dataKey="t" minTickGap={60} tick={{ fontSize: 11 }} />
                <YAxis width={70} domain={["auto", "auto"]} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} />
                <ReferenceLine y={eq[0]!.equity} stroke="#6b7280" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="equity" stroke="#22c55e" dot={false} strokeWidth={1.5} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div className="grid cols-2">
        <div className="panel">
          <h3>open positions</h3>
          {positions.length === 0 ? <div className="flat">none</div> : (
            <table><thead><tr><th>symbol</th><th>state</th><th>entry</th><th>stop</th><th>tp</th><th>bars</th></tr></thead>
              <tbody>{positions.map((p) => <tr key={p.id} className="click" onClick={() => onShowOnChart(p.signal_id)}><td>{p.symbol} {p.timeframe}</td><td>{p.state}</td><td>{fmt.price(p.entry_price)}</td><td>{fmt.price(p.sl_price)}</td><td>{fmt.price(p.tp_price)}</td><td>{p.bars_held}</td></tr>)}</tbody></table>
          )}
        </div>
        <div className="panel">
          <h3>recent events</h3>
          {events.length === 0 ? <div className="flat">none</div> : (
            <div className="table-scroll" style={{ maxHeight: 320 }}><table><tbody>{events.map((ev) => (
              <tr key={ev.id} className={ev.signal_id ? "click" : ""} onClick={() => ev.signal_id && onShowOnChart(ev.signal_id)}>
                <td>{fmt.time(ev.ts)}</td><td>{ev.type}</td><td>{ev.symbol ?? ""}</td><td>{ev.reason ?? ""}</td>
                <td>{ev.sl_price ? `sl ${fmt.price(ev.sl_price)}` : ev.r_multiple != null ? fmt.r(ev.r_multiple) : ""}</td>
              </tr>
            ))}</tbody></table></div>
          )}
        </div>
      </div>
    </div>
  );
}
