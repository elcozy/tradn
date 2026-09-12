/** engine_state row: paused / news_block flags and heartbeat, one row per mode. */
import type { Mode } from "./config.js";
import type { Sql } from "./db.js";

export interface EngineFlags {
  paused: boolean;
  news_block: boolean;
}

export interface StateStore {
  load(): Promise<EngineFlags>;
  setPaused(v: boolean): Promise<void>;
  setNewsBlock(v: boolean): Promise<void>;
  heartbeat(): Promise<void>;
  lastCandle(t: Date): Promise<void>;
}

export class PgStateStore implements StateStore {
  constructor(private sql: Sql, private mode: Mode) {}
  async load(): Promise<EngineFlags> {
    await this.sql`INSERT INTO engine_state (mode) VALUES (${this.mode}) ON CONFLICT (mode) DO NOTHING`;
    const rows = await this.sql<EngineFlags[]>`SELECT paused, news_block FROM engine_state WHERE mode = ${this.mode}`;
    return rows[0] ?? { paused: false, news_block: false };
  }
  async setPaused(v: boolean) {
    await this.sql`UPDATE engine_state SET paused = ${v}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async setNewsBlock(v: boolean) {
    await this.sql`UPDATE engine_state SET news_block = ${v}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async heartbeat() {
    await this.sql`UPDATE engine_state SET last_heartbeat = now(), updated_at = now() WHERE mode = ${this.mode}`;
  }
  async lastCandle(t: Date) {
    await this.sql`UPDATE engine_state SET last_candle_at = ${t}, updated_at = now() WHERE mode = ${this.mode}`;
  }
}

export class MemoryStateStore implements StateStore {
  flags: EngineFlags = { paused: false, news_block: false };
  heartbeats = 0;
  async load() {
    return { ...this.flags };
  }
  async setPaused(v: boolean) {
    this.flags.paused = v;
  }
  async setNewsBlock(v: boolean) {
    this.flags.news_block = v;
  }
  async heartbeat() {
    this.heartbeats += 1;
  }
  async lastCandle() {}
}
