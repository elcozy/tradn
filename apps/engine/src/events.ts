/** engine.events publisher: validates against the contract, XADDs to Redis, logs. */
import { EngineEventSchema, STREAMS, type EngineEvent } from "@trading/contracts";
import type { Redis } from "ioredis";
import type { Mode } from "./config.js";
import { log } from "./log.js";

export enum EngineEventType {
  PositionOpened = "position_opened",
  SlMoved = "sl_moved",
  TpMoved = "tp_moved",
  TpPartial = "tp_partial",
  PositionClosed = "position_closed",
  OrderRejected = "order_rejected",
  SignalRejected = "signal_rejected",
  RiskLimitHit = "risk_limit_hit",
  KillSwitch = "kill_switch",
  Paused = "paused",
  Resumed = "resumed",
  ReconcileMismatch = "reconcile_mismatch",
  Heartbeat = "heartbeat",
  Alert = "alert",
}

export type EventInput = Omit<EngineEvent, "v" | "ts" | "mode" | "type"> & { type: EngineEventType };

export interface EventSink {
  emit(ev: EventInput): Promise<void>;
}

export class RedisEventPublisher implements EventSink {
  constructor(private redis: Redis, private mode: Mode, private now: () => Date = () => new Date()) {}
  async emit(ev: EventInput): Promise<void> {
    const full = EngineEventSchema.parse({ v: 1, ts: this.now().toISOString(), mode: this.mode, ...ev });
    await this.redis.xadd(STREAMS.engineEvents, "MAXLEN", "~", "10000", "*", "json", JSON.stringify(full));
    log.info({ event: full.type, symbol: full.symbol, position: full.position_id, reason: full.reason }, "event");
  }
}

export class MemoryEventSink implements EventSink {
  events: EventInput[] = [];
  async emit(ev: EventInput) {
    EngineEventSchema.parse({ v: 1, ts: new Date().toISOString(), mode: "shadow", ...ev });
    this.events.push(ev);
  }
  ofType(t: EngineEventType) {
    return this.events.filter((e) => e.type === t);
  }
}
