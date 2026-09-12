/**
 * Binance spot combined kline stream -> typed candle events.
 * Public stream, no API key. Binance closes every connection after 24h and pings every 20s;
 * reconnecting is normal operation. A watchdog forces a reconnect after 3 minutes of silence.
 *
 * The WebSocket constructor is injectable so tests can drive a fake socket.
 */
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { log } from "../log.js";
import type { Candle } from "../db.js";

export const SPOT_WS = "wss://stream.binance.com:9443/stream";

export interface KlinePayload {
  stream: string;
  data: {
    e: "kline";
    s: string;
    k: { t: number; T: number; i: string; o: string; h: string; l: string; c: string; v: string; x: boolean };
  };
}

export interface SocketLike extends EventEmitter {
  close(): void;
  terminate(): void;
  pong(): void;
}
export type SocketFactory = (url: string) => SocketLike;

export interface KlineStreamOptions {
  socketFactory?: SocketFactory;
  silenceMs?: number; // watchdog threshold
  watchdogIntervalMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export function streamUrl(symbols: string[], timeframes: string[]): string {
  const streams = symbols.flatMap((s) => timeframes.map((tf) => `${s.toLowerCase()}@kline_${tf}`)).join("/");
  return `${SPOT_WS}?streams=${streams}`;
}

export function parseKline(raw: string): Candle | null {
  const msg = JSON.parse(raw) as Partial<KlinePayload>;
  if (msg.data?.e !== "kline") return null;
  const k = msg.data.k;
  return {
    symbol: msg.data.s,
    timeframe: k.i,
    openTime: new Date(k.t),
    open: Number(k.o),
    high: Number(k.h),
    low: Number(k.l),
    close: Number(k.c),
    volume: Number(k.v),
    closed: k.x,
  };
}

export class BinanceKlineStream extends EventEmitter {
  private ws?: SocketLike;
  private backoffMs: number;
  private stopped = false;
  private lastMessageAt: number;
  private watchdog?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly factory: SocketFactory;
  private readonly opts: Required<KlineStreamOptions>;
  reconnects = 0;

  constructor(
    private readonly symbols: string[],
    private readonly timeframes: string[],
    options: KlineStreamOptions = {},
  ) {
    super();
    this.opts = {
      socketFactory: options.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike),
      silenceMs: options.silenceMs ?? 180_000,
      watchdogIntervalMs: options.watchdogIntervalMs ?? 30_000,
      initialBackoffMs: options.initialBackoffMs ?? 1_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      now: options.now ?? Date.now,
    };
    this.factory = this.opts.socketFactory;
    this.backoffMs = this.opts.initialBackoffMs;
    this.lastMessageAt = this.opts.now();
  }

  start(): void {
    this.stopped = false;
    this.connect();
    this.watchdog = setInterval(() => {
      if (this.opts.now() - this.lastMessageAt > this.opts.silenceMs) {
        log.warn("kline stream silent, forcing reconnect");
        this.emit("silence");
        this.ws?.terminate();
      }
    }, this.opts.watchdogIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  private connect(): void {
    const url = streamUrl(this.symbols, this.timeframes);
    log.info({ symbols: this.symbols, timeframes: this.timeframes }, "connecting to binance kline stream");
    const ws = this.factory(url);
    this.ws = ws;

    ws.on("open", () => {
      this.backoffMs = this.opts.initialBackoffMs;
      this.lastMessageAt = this.opts.now();
      this.emit("connected", { reconnect: this.reconnects > 0 });
    });
    ws.on("message", (raw: Buffer | string) => {
      this.lastMessageAt = this.opts.now();
      let candle: Candle | null;
      try {
        candle = parseKline(raw.toString());
      } catch (err) {
        log.warn({ err }, "unparseable kline message");
        return;
      }
      if (!candle) return;
      this.emit("candle", candle);
      if (candle.closed) this.emit("candleClosed", candle);
    });
    ws.on("ping", () => ws.pong());
    ws.on("error", (err: unknown) => log.error({ err }, "kline ws error"));
    ws.on("close", (code: number) => {
      this.emit("disconnected", code);
      if (this.stopped) return;
      log.warn({ code, retryInMs: this.backoffMs }, "kline ws closed, reconnecting");
      this.reconnects += 1;
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs);
    });
  }
}
