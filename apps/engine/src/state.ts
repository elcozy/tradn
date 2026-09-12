/** engine_state row: paused / news_block flags and heartbeat, one row per mode. */
import type { Mode } from "./config.js";
import type { Sql } from "./db.js";

export interface EngineFlags {
  paused: boolean;
  news_block: boolean;
  /** M7 safety gate: a live engine starts with entries disabled until this is flipped on purpose. */
  entries_enabled: boolean;
}

export interface StateStore {
  load(): Promise<EngineFlags>;
  setPaused(v: boolean): Promise<void>;
  setNewsBlock(v: boolean): Promise<void>;
  setEntriesEnabled(v: boolean): Promise<void>;
  heartbeat(): Promise<void>;
  lastCandle(t: Date): Promise<void>;
}

export class PgStateStore implements StateStore {
  constructor(private sql: Sql, private mode: Mode) {}
  async load(): Promise<EngineFlags> {
    // A live engine must be armed explicitly (UPDATE engine_state SET entries_enabled = true WHERE mode = 'live').
    await this.sql`INSERT INTO engine_state (mode, entries_enabled) VALUES (${this.mode}, ${this.mode !== "live"}) ON CONFLICT (mode) DO NOTHING`;
    const rows = await this.sql<EngineFlags[]>`SELECT paused, news_block, entries_enabled FROM engine_state WHERE mode = ${this.mode}`;
    return rows[0] ?? { paused: false, news_block: false, entries_enabled: this.mode !== "live" };
  }
  async setPaused(v: boolean) {
    await this.sql`UPDATE engine_state SET paused = ${v}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async setNewsBlock(v: boolean) {
    await this.sql`UPDATE engine_state SET news_block = ${v}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async setEntriesEnabled(v: boolean) {
    await this.sql`UPDATE engine_state SET entries_enabled = ${v}, updated_at = now() WHERE mode = ${this.mode}`;
  }
  async heartbeat() {
    await this.sql`UPDATE engine_state SET last_heartbeat = now(), updated_at = now() WHERE mode = ${this.mode}`;
  }
  async lastCandle(t: Date) {
    await this.sql`UPDATE engine_state SET last_candle_at = ${t}, updated_at = now() WHERE mode = ${this.mode}`;
  }
}

export class MemoryStateStore implements StateStore {
  flags: EngineFlags = { paused: false, news_block: false, entries_enabled: true };
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
  async setEntriesEnabled(v: boolean) {
    this.flags.entries_enabled = v;
  }
  async heartbeat() {
    this.heartbeats += 1;
  }
  async lastCandle() {}
}
