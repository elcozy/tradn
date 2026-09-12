import { useEffect, useState } from "react";
import { Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, get } from "../api";

interface Run {
  id: string; strategy_id: string; symbol: string; timeframe: string; from_ts: string; to_ts: string; created_at: string;
  params: { params: Record<string, unknown>; exit: Record<string, unknown> };
  metrics: { trades: number; win_rate?: number; expectancy_r?: number; sum_r?: number; profit_factor?: number | null; max_drawdown_r?: number; total_pnl?: number; total_fees?: number; close_reasons?: Record<string, number>; baselines?: { buy_and_hold: { return_pct: number }; random: Record<string, unknown> }; skip_reasons?: Record<string, number> };
}
interface Trade { signal_id: string; ts: string; actual_entry: number; exit_price: number; outcome: string; realized_r: number; close_reason: string; bars_held: number; closed_at: string }
interface Whw { id: string; ts: string; strategy_id: string; symbol: string; reject_reason: string; projected_r: number | null; would_have: string; would_have_r: number | null; would_have_close_reason: string | null; would_have_bars: number | null }

const tooltipStyle = { background: "#121821", border: "1px solid #1f2937" };

export function BacktestsPage({ tick }: { tick: number }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [whw, setWhw] = useState<Whw[]>([]);
  useEffect(() => {
    get<Run[]>("/api/backtests").then((r) => { setRuns(r); if (!selected && r[0]) setSelected(r[0].id); }).catch(console.error);
    get<Whw[]>("/api/would-have-won?limit=100").then(setWhw).catch(console.error);
  }, [tick]);
  useEffect(() => {
    if (!selected) return;
    get<Trade[]>(`/api/backtests/${selected}/trades`).then(setTrades).catch(console.error);
  }, [selected]);
  const run = runs.find((r) => r.id === selected);
  const curve = trades.reduce<{ i: number; t: string; cum: number }[]>((acc, t) => [...acc, { i: acc.length + 1, t: t.closed_at.slice(0, 10), cum: Math.round(((acc[acc.length - 1]?.cum ?? 0) + t.realized_r) * 1000) / 1000 }], []);
  const whwWins = whw.filter((w) => w.would_have === "win").length;
  const whwDecided = whw.filter((w) => ["win", "loss", "breakeven"].includes(w.would_have)).length;
  return (
    <div className="grid">
      <div className="grid cols-2">
        <div className="panel">
          <h3>backtest runs (research backtest / walkforward)</h3>
          {runs.length === 0 ? <div className="flat">none stored yet — run <code>research backtest s1_btc_15m</code></div> : (
            <table>
              <thead><tr><th>run</th><th>strategy</th><th>window</th><th>trades</th><th>win</th><th>exp</th><th>sum</th><th>PF</th><th>maxDD</th></tr></thead>
              <tbody>{runs.map((r) => (
                <tr key={r.id} className={`click ${r.id === selected ? "active" : ""}`} onClick={() => setSelected(r.id)}>
                  <td>{r.created_at.slice(0, 16).replace("T", " ")}</td><td>{r.strategy_id}</td><td>{r.from_ts.slice(0, 10)} → {r.to_ts.slice(0, 10)}</td>
                  <td>{r.metrics.trades}</td><td>{fmt.pct(r.metrics.win_rate)}</td>
                  <td className={(r.metrics.expectancy_r ?? 0) > 0 ? "win" : "loss"}>{fmt.r(r.metrics.expectancy_r)}</td>
                  <td>{fmt.r(r.metrics.sum_r)}</td><td>{r.metrics.profit_factor ?? "–"}</td><td>{r.metrics.max_drawdown_r ?? "–"}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div>
        <div className="panel">
          <h3>cumulative R{run ? ` · ${run.strategy_id} ${run.symbol} ${run.timeframe}` : ""}</h3>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <LineChart data={curve}>
                <XAxis dataKey="i" tick={{ fontSize: 11 }} /><YAxis width={40} tick={{ fontSize: 11 }} />
                <Tooltip contentStyle={tooltipStyle} labelFormatter={(i) => curve[Number(i) - 1]?.t ?? ""} />
                <ReferenceLine y={0} stroke="#6b7280" strokeDasharray="4 4" />
                <Line type="stepAfter" dataKey="cum" stroke="#3b82f6" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {run && (
            <div className="flat" style={{ fontSize: 12, marginTop: 6 }}>
              pnl {run.metrics.total_pnl?.toFixed(2)} (fees {run.metrics.total_fees?.toFixed(2)}) · buy&amp;hold {run.metrics.baselines?.buy_and_hold.return_pct}% · close reasons {JSON.stringify(run.metrics.close_reasons ?? {})}
              <br />params {JSON.stringify(run.params.params)} · exit {JSON.stringify(run.params.exit)}
            </div>
          )}
        </div>
      </div>
      <div className="panel">
        <h3>trades of the selected run</h3>
        {trades.length === 0 ? <div className="flat">no trades</div> : (
          <table>
            <thead><tr><th>signal</th><th>entry</th><th>exit</th><th>R</th><th>outcome</th><th>reason</th><th>bars</th></tr></thead>
            <tbody>{trades.map((t) => <tr key={t.signal_id}><td>{t.ts.slice(0, 16).replace("T", " ")}</td><td>{fmt.price(t.actual_entry)}</td><td>{fmt.price(t.exit_price)}</td><td className={t.realized_r > 0 ? "win" : "loss"}>{fmt.r(t.realized_r)}</td><td>{t.outcome}</td><td>{t.close_reason}</td><td>{t.bars_held}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h3>rejected signals that would have won (nightly job) · {whwWins}/{whwDecided} decided as wins</h3>
        {whw.length === 0 ? <div className="flat">nothing yet — <code>research would-have-won</code> runs nightly</div> : (
          <table>
            <thead><tr><th>signal</th><th>strategy</th><th>rejected for</th><th>projected</th><th>would have</th><th>R</th><th>reason</th><th>bars</th></tr></thead>
            <tbody>{whw.map((w) => <tr key={w.id}><td>{w.ts.slice(0, 16).replace("T", " ")}</td><td>{w.strategy_id}</td><td>{w.reject_reason}</td><td>{fmt.r(w.projected_r)}</td><td className={w.would_have === "win" ? "win" : w.would_have === "loss" ? "loss" : "flat"}>{w.would_have}</td><td>{fmt.r(w.would_have_r)}</td><td>{w.would_have_close_reason ?? ""}</td><td>{w.would_have_bars ?? ""}</td></tr>)}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
