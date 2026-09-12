import { useEffect, useState } from "react";
import { get, post, type PositionRow } from "../api";

export function ControlsPage({ tick }: { tick: number }) {
  const [status, setStatus] = useState<{ engine: { paused: boolean; news_block: boolean } | null } | null>(null);
  const [positions, setPositions] = useState<PositionRow[]>([]);
  const [msg, setMsg] = useState("");
  useEffect(() => {
    get<typeof status>("/api/status").then(setStatus).catch(console.error);
    get<PositionRow[]>("/api/positions").then(setPositions).catch(console.error);
  }, [tick]);
  const send = async (type: string, extra: Record<string, unknown> = {}, confirmText?: string) => {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await post("/api/commands", { type, reason: "dashboard", ...extra });
      setMsg(`${type} sent`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const e = status?.engine;
  return (
    <div className="grid cols-2">
      <div className="panel grid" style={{ gap: 8 }}>
        <h3>engine</h3>
        <div>{e?.paused ? "⏸ paused" : "▶ running"} {e?.news_block ? "· 📰 news block on" : ""}</div>
        <div className="toolbar">
          <button className="btn" onClick={() => send("pause")}>pause</button>
          <button className="btn" onClick={() => send("resume")}>resume</button>
          <button className="btn" onClick={() => send(e?.news_block ? "news_off" : "news_on")}>news block {e?.news_block ? "off" : "on"}</button>
          <button className="btn danger" onClick={() => send("close_all", {}, "Close every open position at market?")}>close all</button>
          <button className="btn danger" onClick={() => send("kill", {}, "KILL: close everything and pause the engine?")}>kill</button>
        </div>
        <div className="flat">{msg}</div>
      </div>
      <div className="panel">
        <h3>open positions</h3>
        {positions.length === 0 ? <div className="flat">none</div> : positions.map((p) => (
          <div key={p.id} className="toolbar"><span>{p.symbol} {p.timeframe} · {p.state} · stop {p.sl_price}</span><button className="btn danger" onClick={() => send("close_position", { position_id: p.id, symbol: p.symbol }, `Close ${p.symbol}?`)}>close</button></div>
        ))}
      </div>
    </div>
  );
}
