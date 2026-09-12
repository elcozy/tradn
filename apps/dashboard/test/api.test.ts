import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { FakeRedis, testDb } from "./testDb.js";

const config = { symbols: ["BTCUSDT"], timeframes: ["15m", "1h"], strategies: [{ id: "s1", type: "sr_bounce", symbol: "BTCUSDT", entry_tf: "15m", regime_tf: "1h", enabled: true }] };

describe("dashboard api", async () => {
  const sql = await testDb();
  const redis = new FakeRedis();
  const app = await buildServer({ sql, redis, mode: "shadow", config, candlePollMs: 100 });

  beforeAll(async () => {
    await sql`INSERT INTO engine_state (mode, paused) VALUES ('shadow', false)`;
    for (let i = 0; i < 20; i++)
      await sql`INSERT INTO candles VALUES ('BTCUSDT', '15m', ${new Date(Date.UTC(2026, 8, 12, 0, i * 15))}, 100, 101, 99, ${100 + i}, 1, true)`;
    await sql`INSERT INTO signals (id, ts, strategy_id, strategy_type, symbol, timeframe, side, entry_type, entry_price, stop_price, tp1_price, tp_price, meta, mode, outcome, realized_r, realized_pnl, closed_at, bars_held, mfe_r, mae_r, fees)
      VALUES ('s1:a', now() - interval '1 day', 's1', 'sr_bounce', 'BTCUSDT', '15m', 'long', 'market', 100, 99, 101, 103, '{"level": 99.2}', 'shadow', 'win', 1.5, 33, now(), 7, 2, 0.3, 0.2)`;
    await sql`INSERT INTO signals (id, ts, strategy_id, strategy_type, symbol, timeframe, side, entry_type, entry_price, stop_price, tp_price, mode, outcome, reject_reason)
      VALUES ('s1:b', now(), 's1', 'sr_bounce', 'BTCUSDT', '15m', 'long', 'market', 100, 99, 103, 'shadow', 'rejected', 'paused')`;
    await sql`INSERT INTO signals (id, ts, strategy_id, strategy_type, symbol, timeframe, side, entry_type, entry_price, stop_price, tp_price, mode, position_id)
      VALUES ('s1:c', now(), 's1', 'sr_bounce', 'BTCUSDT', '15m', 'long', 'market', 100, 99, 103, 'shadow', 'pos:s1:c')`;
    await sql`INSERT INTO positions (id, mode, signal_id, strategy_id, symbol, timeframe, side, entry_price, qty, remaining_qty, sl_price, sl_initial, tp_price, highest_high, lowest_low, state, opened_at, meta)
      VALUES ('pos:s1:c', 'shadow', 's1:c', 's1', 'BTCUSDT', '15m', 'long', 100, 1, 1, 99.5, 99, 103, 101, 99.8, 'open', now(), '{"events": [{"bar": 1, "type": "sl_moved", "price": 99.5, "reason": "trailing"}]}')`;
  });
  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it("health and config", async () => {
    expect((await app.inject("/api/health")).json()).toEqual({ ok: true });
    expect((await app.inject("/api/config")).json().mode).toBe("shadow");
  });
  it("status counts open positions and today's signals", async () => {
    const s = (await app.inject("/api/status")).json();
    expect(s.open_positions).toBe(1);
    expect(s.today.signals).toBe(2);
    expect(s.today.rejected).toBe(1);
    expect(s.engine.paused).toBe(false);
  });
  it("config lists resampled chart timeframes", async () => {
    expect((await app.inject("/api/config")).json().chart_timeframes).toEqual(["15m", "30m", "1h", "2h", "4h", "1d"]);
  });
  it("resamples 2h candles from stored 15m rows", async () => {
    const h = (await app.inject("/api/candles?symbol=BTCUSDT&tf=2h")).json();
    expect(h).toHaveLength(3); // 20 x 15m = 5 hours -> buckets 00:00, 02:00, 04:00
    expect(h[0]).toMatchObject({ open: 100, high: 101, low: 99, close: 107, volume: 8 }); // closes 100..107 in the first two hours
    expect((await app.inject("/api/candles?tf=7m")).json()).toEqual([]);
  });
  it("candles are ascending unix seconds with numbers", async () => {
    const c = (await app.inject("/api/candles?symbol=BTCUSDT&tf=15m&limit=5")).json();
    expect(c).toHaveLength(5);
    expect(c[0].time).toBeLessThan(c[4].time);
    expect(typeof c[0].close).toBe("number");
  });
  it("signals filter and page", async () => {
    const all = (await app.inject("/api/signals")).json();
    expect(all.total).toBe(3);
    expect(typeof all.rows[0].entry_price).toBe("number");
    expect((await app.inject("/api/signals?outcome=win")).json().total).toBe(1);
    expect((await app.inject("/api/signals?outcome=open")).json().total).toBe(1);
    expect((await app.inject("/api/signals?limit=1&offset=2")).json().rows).toHaveLength(1);
  });
  it("signal detail includes the position and its events", async () => {
    const d = (await app.inject("/api/signals/s1:c")).json();
    expect(d.position.id).toBe("pos:s1:c");
    expect(d.events[0].type).toBe("sl_moved");
    expect((await app.inject("/api/signals/nope")).statusCode).toBe(404);
  });
  it("positions, scorecard, daily", async () => {
    expect((await app.inject("/api/positions")).json()).toHaveLength(1);
    const sc = (await app.inject("/api/scorecard")).json();
    expect(sc[0].trades).toBe(1);
    expect(sc[0].expectancy_r).toBe(1.5);
    expect((await app.inject("/api/daily")).json()[0].r).toBe(1.5);
  });
  it("commands are validated and published", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/commands", payload: { type: "pause", reason: "test" } });
    expect(ok.json().ok).toBe(true);
    expect(redis.streams.get("engine.commands")).toHaveLength(1);
    const bad = await app.inject({ method: "POST", url: "/api/commands", payload: { type: "dance" } });
    expect(bad.statusCode).toBe(500);
  });
  it("events come from redis newest first", async () => {
    await redis.xadd("engine.events", "*", "json", JSON.stringify({ v: 1, ts: "x", mode: "shadow", type: "heartbeat" }));
    await redis.xadd("engine.events", "*", "json", JSON.stringify({ v: 1, ts: "y", mode: "shadow", type: "alert" }));
    const ev = (await app.inject("/api/events?limit=10")).json();
    expect(ev[0].type).toBe("alert");
  });
});
