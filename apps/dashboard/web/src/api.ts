import { useEffect, useRef, useState } from "react";

export async function get<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

export async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json() as Promise<T>;
}

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
export interface SignalRow {
  id: string; ts: string; strategy_id: string; symbol: string; timeframe: string; entry_price: number; stop_price: number;
  tp1_price: number | null; tp_price: number; projected_r: number | null; outcome: string | null; reject_reason: string | null;
  position_id: string | null; actual_entry: number | null; exit_price: number | null; realized_r: number | null; realized_pnl: number | null;
  mfe_r: number | null; mae_r: number | null; bars_held: number | null; duration_s: number | null; close_reason: string | null; closed_at: string | null;
  meta: Record<string, unknown>;
}
export interface PositionRow {
  id: string; signal_id: string; symbol: string; timeframe: string; entry_price: number; qty: number; remaining_qty: number; sl_price: number;
  sl_initial: number; tp_price: number; tp1_price: number | null; tp1_done: boolean; state: string; bars_held: number; opened_at: string;
  meta: { events?: { bar: number; type: string; price?: number; reason?: string }[] };
}
export interface Config { mode: string; symbols: string[]; timeframes: string[]; strategies: { id: string; symbol: string; entry_tf: string; regime_tf: string; enabled: boolean }[] }

export type WsMessage = { kind: "event"; event: Record<string, unknown> } | { kind: "candle"; symbol: string; tf: string; candle: Candle };

/** Live feed: reconnects on close; returns the latest message and a counter that bumps on every event. */
export function useLive(onMessage: (m: WsMessage) => void) {
  const [connected, setConnected] = useState(false);
  const cb = useRef(onMessage);
  cb.current = onMessage;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => cb.current(JSON.parse(e.data));
      ws.onclose = () => {
        setConnected(false);
        if (!stop) setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stop = true;
      ws?.close();
    };
  }, []);
  return connected;
}

export const fmt = {
  price: (x: number | null | undefined) => (x == null ? "–" : x >= 1000 ? x.toFixed(1) : x.toPrecision(5)),
  r: (x: number | null | undefined) => (x == null ? "–" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}R`),
  pct: (x: number | null | undefined) => (x == null ? "–" : `${(x * 100).toFixed(0)}%`),
  time: (iso: string | null | undefined) => (iso ? new Date(iso).toISOString().replace("T", " ").slice(0, 16) : "–"),
  ago: (iso: string | null | undefined) => (iso ? `${Math.round((Date.now() - new Date(iso).getTime()) / 60000)} min ago` : "never"),
};
