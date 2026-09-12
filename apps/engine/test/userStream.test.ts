import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReport } from "../src/execution/binance/adapter.js";
import { UserDataStream, parseExecutionReport } from "../src/execution/binance/userStream.js";
import type { SocketLike } from "../src/marketdata/binanceWs.js";
import { FakeBinance } from "./fakeBinance.js";

class FakeSocket extends EventEmitter implements SocketLike {
  constructor(public url: string) {
    super();
  }
  close() {
    this.emit("close", 1000);
  }
  terminate() {
    this.emit("close", 1006);
  }
  pong() {}
}

const report = JSON.stringify({
  e: "executionReport", E: 1, s: "BTCUSDT", c: "e-abc", S: "BUY", o: "MARKET", x: "TRADE", X: "FILLED", i: 42, g: -1,
  l: "0.04000000", L: "61234.50000000", z: "0.04000000", Z: "2449.38", n: "2.44938", N: "USDT", t: 7, T: 1700000000000,
});

describe("parseExecutionReport", () => {
  it("maps the single-letter fields", () => {
    const r = parseExecutionReport(report)!;
    expect(r).toMatchObject<Partial<ExecutionReport>>({ symbol: "BTCUSDT", orderId: "42", clientOrderId: "e-abc", orderListId: null, execType: "TRADE", status: "FILLED", lastQty: 0.04, lastPrice: 61234.5, commission: 2.44938, commissionAsset: "USDT", tradeId: "7", time: 1700000000000 });
    expect(parseExecutionReport(JSON.stringify({ e: "outboundAccountPosition" }))).toBeNull();
  });
});

describe("UserDataStream", () => {
  let sockets: FakeSocket[];
  let ex: FakeBinance;
  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    ex = new FakeBinance();
  });
  afterEach(() => vi.useRealTimers());

  it("connects with a fresh listen key, keeps it alive, emits reports, rotates before 24h and reconnects", async () => {
    const stream = new UserDataStream(ex, { wsBase: "wss://x/ws", socketFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; }, keepAliveMs: 1000, reconnectAfterMs: 5000, initialBackoffMs: 10 });
    const reports: ExecutionReport[] = [];
    stream.on("report", (r) => reports.push(r));
    await stream.start();
    expect(sockets[0]!.url).toBe("wss://x/ws/key1");
    sockets[0]!.emit("open");
    sockets[0]!.emit("message", report);
    expect(reports).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2100);
    expect(ex.keepAlives).toBe(2);
    await vi.advanceTimersByTimeAsync(3000); // 24h-style rotation closes the socket
    await vi.advanceTimersByTimeAsync(50); // backoff, then a new key + socket
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.url).toBe("wss://x/ws/key2");
    expect(stream.reconnects).toBe(1);
    await stream.stop();
  });
});
