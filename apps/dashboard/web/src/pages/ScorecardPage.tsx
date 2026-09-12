import { useEffect, useState } from "react";
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmt, get, type SignalRow } from "../api";

interface Row { strategy_id: string; symbol: string; timeframe: string; trades: number; wins: number; losses: number; expectancy_r: number; win_rate: number; profit_factor: number | null; avg_mfe_of_losers: number | null; avg_mae_of_winners: number | null; avg_bars_held: number; total_pnl: number }

export function ScorecardPage({ tick }: { tick: number }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [hist, setHist] = useState<{ bucket: string; n: number }[]>([]);
  useEffect(() => {
    get<Row[]>("/api/scorecard").then(setRows).catch(console.error);
    get<{ rows: SignalRow[] }>("/api/signals?limit=500").then(({ rows }) => {
      const buckets = new Map<string, number>();
      for (const s of rows) {
        if (s.realized_r == null) continue;
        const b = (Math.floor(s.realized_r * 2) / 2).toFixed(1);
        buckets.set(b, (buckets.get(b) ?? 0) + 1);
      }
      setHist([...buckets.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([bucket, n]) => ({ bucket, n })));
    }).catch(console.error);
  }, [tick]);
  return (
    <div className="grid">
      <div className="panel">
        <h3>per strategy instance</h3>
        {rows.length === 0 ? <div className="flat">no closed trades yet</div> : (
          <table>
            <thead><tr><th>strategy</th><th>symbol</th><th>trades</th><th>W/L</th><th>win rate</th><th>expectancy</th><th>profit factor</th><th>MFE of losers</th><th>MAE of winners</th><th>avg bars</th><th>pnl</th></tr></thead>
            <tbody>{rows.map((r) => <tr key={r.strategy_id + r.symbol + r.timeframe}><td>{r.strategy_id}</td><td>{r.symbol} {r.timeframe}</td><td>{r.trades}</td><td>{r.wins}/{r.losses}</td><td>{fmt.pct(r.win_rate)}</td><td className={r.expectancy_r > 0 ? "win" : "loss"}>{fmt.r(r.expectancy_r)}</td><td>{r.profit_factor ?? "–"}</td><td>{fmt.r(r.avg_mfe_of_losers)}</td><td>{fmt.r(r.avg_mae_of_winners)}</td><td>{r.avg_bars_held}</td><td>{r.total_pnl?.toFixed(2)}</td></tr>)}</tbody>
          </table>
        )}
      </div>
      <div className="panel">
        <h3>R distribution (last 500 closed)</h3>
        <div style={{ height: 220 }}>
          <ResponsiveContainer><BarChart data={hist}><XAxis dataKey="bucket" /><YAxis width={30} allowDecimals={false} /><Tooltip contentStyle={{ background: "#121821", border: "1px solid #1f2937" }} /><Bar dataKey="n" fill="#3b82f6" /></BarChart></ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
