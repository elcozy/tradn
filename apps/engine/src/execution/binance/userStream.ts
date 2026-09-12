/**
 * Binance user data stream: executionReport events for our orders, over a listenKey WebSocket.
 * Keep-alive every 30 minutes, proactive reconnect before the 24h cut, exponential backoff, a fresh
 * listen key on every (re)connect. The socket factory and timers are injectable for tests.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../../log.js";
import type { SocketFactory, SocketLike } from "../../marketdata/binanceWs.js";
import type { ExecutionReport } from "./adapter.js";
import type { BinanceRest } from "./rest.js";

export const USER_WS = "wss://stream.binance.com:9443/ws";
export const USER_WS_TESTNET = "wss://stream.testnet.binance.vision/ws";

export interface UserStreamOptions {
  wsBase?: string;
  socketFactory?: SocketFactory;
  keepAliveMs?: number;
  reconnectAfterMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Parse one raw user-stream message; only executionReport is of interest. */
export function parseExecutionReport(raw: string): ExecutionReport | null {
  const m = JSON.parse(raw) as Record<string, unknown>;
  if (m["e"] !== "executionReport") return null;
  const n = (k: string) => Number(m[k] ?? 0);
  return {
    symbol: String(m["s"]),
    orderId: String(m["i"]),
    clientOrderId: String(m["c"] ?? ""),
    orderListId: Number(m["g"] ?? -1) >= 0 ? String(m["g"]) : null,
    side: m["S"] as "BUY" | "SELL",
    execType: String(m["x"]),
    status: String(m["X"]),
    lastQty: n("l"),
    lastPrice: n("L"),
    cumQty: n("z"),
    cumQuote: n("Z"),
    commission: n("n"),
    commissionAsset: String(m["N"] ?? ""),
    tradeId: String(m["t"] ?? ""),
    time: n("T") || n("E"),
  };
}

export class UserDataStream extends EventEmitter {
  private ws?: SocketLike;
  private key?: string;
  private stopped = false;
  private backoffMs: number;
  private keepAlive?: NodeJS.Timeout;
  private rotate?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly opts: Required<UserStreamOptions>;
  reconnects = 0;

  constructor(private rest: BinanceRest, options: UserStreamOptions = {}) {
    super();
    this.opts = {
      wsBase: options.wsBase ?? USER_WS,
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      keepAliveMs: options.keepAliveMs ?? 30 * 60_000,
      reconnectAfterMs: options.reconnectAfterMs ?? 23 * 3_600_000,
      initialBackoffMs: options.initialBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
    };
    this.backoffMs = this.opts.initialBackoffMs;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    if (this.key) await this.rest.closeListenKey(this.key).catch(() => {});
  }

  private clearTimers() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    if (this.rotate) clearTimeout(this.rotate);
  }

  private async connect(): Promise<void> {
    try {
      this.key = await this.rest.createListenKey();
    } catch (err) {
      log.error({ err }, "listen key creation failed");
      this.scheduleReconnect();
      return;
    }
    const ws = this.opts.socketFactory(`${this.opts.wsBase}/${this.key}`);
    this.ws = ws;
    ws.on("open", () => {
      this.backoffMs = this.opts.initialBackoffMs;
      this.clearTimers();
      this.keepAlive = setInterval(() => void this.rest.keepAliveListenKey(this.key!).catch((err) => log.warn({ err }, "listen key keep-alive failed")), this.opts.keepAliveMs);
      this.rotate = setTimeout(() => {
        log.info("user stream: proactive reconnect before the 24h cut");
        ws.close();
      }, this.opts.reconnectAfterMs);
      this.emit("connected", { reconnect: this.reconnects > 0 });
    });
    ws.on("message", (raw: Buffer | string) => {
      try {
        const r = parseExecutionReport(raw.toString());
        if (r) this.emit("report", r);
      } catch (err) {
        log.warn({ err }, "unparseable user stream message");
      }
    });
    ws.on("ping", () => ws.pong());
    ws.on("error", (err: unknown) => log.error({ err }, "user stream error"));
    ws.on("close", (code: number) => {
      this.clearTimers();
      this.emit("disconnected", code);
      if (this.stopped) return;
      this.reconnects += 1;
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    log.warn({ retryInMs: this.backoffMs }, "user stream closed, reconnecting");
    this.reconnectTimer = setTimeout(() => void this.connect(), this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
  }
}
