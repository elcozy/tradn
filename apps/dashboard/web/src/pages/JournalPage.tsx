import { useEffect, useState } from "react";
import { fmt, get, type Config, type SignalRow } from "../api";

export function JournalPage({ config, tick, onShowOnChart }: { config: Config; tick: number; onShowOnChart: (id: string) => void }) {
  const [strategy, setStrategy] = useState("");
  const [outcome, setOutcome] = useState("");
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ total: number; rows: SignalRow[] }>({ total: 0, rows: [] });
  const [openRow, setOpenRow] = useState<string | null>(null);
  const limit = 50;
  useEffect(() => {
    const q = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
    if (strategy) q.set("strategy_id", strategy);
    if (outcome) q.set("outcome", outcome);
    get<typeof data>(`/api/signals?${q}`).then(setData).catch(console.error);
  }, [strategy, outcome, page, tick]);
  return (
    <div className="panel">
      <div className="toolbar">
        <select value={strategy} onChange={(e) => { setStrategy(e.target.value); setPage(0); }}><option value="">all strategies</option>{config.strategies.map((s) => <option key={s.id} value={s.id}>{s.id}</option>)}</select>
        <select value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(0); }}>
          <option value="">all outcomes</option>{["open", "win", "loss", "breakeven", "rejected"].map((o) => <option key={o}>{o}</option>)}
        </select>
        <span className="pill">{data.total} signals</span>
        <button className="btn" disabled={page === 0} onClick={() => setPage(page - 1)}>‹</button>
        <button className="btn" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>›</button>
      </div>
      <table>
        <thead><tr><th>time</th><th>strategy</th><th>symbol</th><th>entry</th><th>stop</th><th>tp</th><th>proj R</th><th>outcome</th><th>real R</th><th>reason</th><th>bars</th><th>mfe/mae</th><th></th></tr></thead>
        <tbody>
          {data.rows.map((s) => (
            <>
              <tr key={s.id} className={`click ${openRow === s.id ? "selected" : ""}`} onClick={() => setOpenRow(openRow === s.id ? null : s.id)}>
                <td>{fmt.time(s.ts)}</td><td>{s.strategy_id}</td><td>{s.symbol} {s.timeframe}</td>
                <td>{fmt.price(s.actual_entry ?? s.entry_price)}</td><td>{fmt.price(s.stop_price)}</td><td>{fmt.price(s.tp_price)}</td><td>{fmt.r(s.projected_r)}</td>
                <td className={s.outcome ?? (s.position_id ? "open" : "")}>{s.outcome ?? (s.position_id ? "open" : "pending")}</td>
                <td className={s.realized_r == null ? "" : s.realized_r > 0 ? "win" : "loss"}>{fmt.r(s.realized_r)}</td>
                <td>{s.reject_reason ?? s.close_reason ?? ""}</td><td>{s.bars_held ?? ""}</td>
                <td>{s.mfe_r != null ? `${s.mfe_r.toFixed(2)} / ${s.mae_r?.toFixed(2)}` : ""}</td>
                <td><button className="btn" onClick={(e) => { e.stopPropagation(); onShowOnChart(s.id); }}>chart</button></td>
              </tr>
              {openRow === s.id && <tr key={s.id + "x"}><td colSpan={13}><pre>{JSON.stringify(s.meta, null, 1)}</pre></td></tr>}
            </>
          ))}
        </tbody>
      </table>
    </div>
  );
}
