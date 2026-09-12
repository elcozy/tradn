import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BinanceKlineStream, parseKline, streamUrl, type SocketLike } from "../src/marketdata/binanceWs.js";

class FakeSocket extends EventEmitter implements SocketLike {
  closed = false;
  pongs = 0;
  close() {
    this.closed = true;
    this.emit("close", 1000);
  }
  terminate() {
    this.closed = true;
    this.emit("close", 1006);
  }
  pong() {
    this.pongs += 1;
  }
}

const kline = (over: Partial<{ x: boolean; t: number; c: string; i: string }> = {}) =>
  JSON.stringify({
    stream: "btcusdt@kline_15m",
    data: {
      e: "kline",
      s: "BTCUSDT",
      k: { t: over.t ?? 1_700_000_000_000, T: 0, i: over.i ?? "15m", o: "1", h: "2", l: "0.5", c: over.c ?? "1.5", v: "10", x: over.x ?? false },
    },
  });

describe("streamUrl / parseKline", () => {
  it("builds the combined stream url", () => {
    expect(streamUrl(["BTCUSDT", "ETHUSDT"], ["15m", "1h"])).toBe(
      "wss://stream.binance.com:9443/stream?streams=btcusdt@kline_15m/btcusdt@kline_1h/ethusdt@kline_15m/ethusdt@kline_1h",
    );
  });
  it("parses a kline into a candle with numbers and a Date", () => {
    const c = parseKline(kline({ x: true, c: "42.5" }))!;
    expect(c.symbol).toBe("BTCUSDT");
    expect(c.close).toBe(42.5);
    expect(c.openTime).toBeInstanceOf(Date);
    expect(c.closed).toBe(true);
  });
  it("ignores non-kline messages", () => {
    expect(parseKline(JSON.stringify({ stream: "x", data: { e: "trade" } }))).toBeNull();
  });
});

describe("BinanceKlineStream", () => {
  let sockets: FakeSocket[];
  let now: number;
  const factory = () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  const make = () =>
    new BinanceKlineStream(["BTCUSDT"], ["15m"], {
      socketFactory: factory,
      initialBackoffMs: 10,
      maxBackoffMs: 40,
      silenceMs: 1000,
      watchdogIntervalMs: 100,
      now: () => now,
    });

  beforeEach(() => {
    sockets = [];
    now = 0;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("emits candle for every update and candleClosed only when final", () => {
    const s = make();
    const candles: unknown[] = [];
    const closed: unknown[] = [];
    s.on("candle", (c) => candles.push(c));
    s.on("candleClosed", (c) => closed.push(c));
    s.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", kline({ x: false }));
    sockets[0]!.emit("message", kline({ x: false }));
    sockets[0]!.emit("message", kline({ x: true }));
    expect(candles).toHaveLength(3);
    expect(closed).toHaveLength(1);
    s.stop();
  });

  it("answers pings with pongs", () => {
    const s = make();
    s.start();
    sockets[0]!.emit("ping");
    expect(sockets[0]!.pongs).toBe(1);
    s.stop();
  });

  it("reconnects with backoff after close and reports it as a reconnect", () => {
    const s = make();
    const connected: { reconnect: boolean }[] = [];
    s.on("connected", (e) => connected.push(e));
    s.start();
    sockets[0]!.emit("open");
    sockets[0]!.emit("close", 1006);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(10);
    expect(sockets).toHaveLength(2);
    sockets[1]!.emit("open");
    expect(connected).toEqual([{ reconnect: false }, { reconnect: true }]);
    expect(s.reconnects).toBe(1);
    s.stop();
  });

  it("does not reconnect after stop()", () => {
    const s = make();
    s.start();
    s.stop();
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(1);
  });

  it("watchdog terminates a silent socket", () => {
    const s = make();
    const silences: number[] = [];
    s.on("silence", () => silences.push(1));
    s.start();
    sockets[0]!.emit("open");
    now = 5000; // > silenceMs since last message
    vi.advanceTimersByTime(100);
    expect(silences).toHaveLength(1);
    expect(sockets[0]!.closed).toBe(true);
    s.stop();
  });

  it("survives a malformed message", () => {
    const s = make();
    s.start();
    expect(() => sockets[0]!.emit("message", "{not json")).not.toThrow();
    s.stop();
  });
});
