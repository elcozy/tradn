/** Redis Streams consumer group for `signals`. Validates each entry against the contract, hands it to a
 * handler, acks on success. Pending (unacked) entries from a previous run are replayed first. */
import { SignalSchema, STREAMS, type Signal } from "@trading/contracts";
import type { Redis } from "ioredis";
import { log } from "../log.js";

export type StreamEntry = [id: string, fields: string[]];

export function parseEntry(fields: string[]): Signal | null {
  const i = fields.indexOf("json");
  if (i < 0 || i + 1 >= fields.length) return null;
  const res = SignalSchema.safeParse(JSON.parse(fields[i + 1]!));
  if (!res.success) {
    log.warn({ issues: res.error.issues }, "invalid signal on stream");
    return null;
  }
  return res.data;
}

export class SignalConsumer {
  private stopped = false;
  constructor(
    private redis: Redis,
    private handler: (sig: Signal) => Promise<void>,
    private group = "engine",
    private consumer = `engine-${process.pid}`,
    private stream: string = STREAMS.signals,
  ) {}

  async ensureGroup(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", this.stream, this.group, "$", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
  }

  /** One read: pending first (id "0"), then new (">"). Returns number processed. */
  async readOnce(blockMs = 5000): Promise<number> {
    let n = 0;
    for (const id of ["0", ">"]) {
      const res = (await this.redis.xreadgroup(
        "GROUP", this.group, this.consumer, "COUNT", "10", "BLOCK", id === ">" ? String(blockMs) : "0", "STREAMS", this.stream, id,
      )) as [string, StreamEntry[]][] | null;
      if (!res) continue;
      for (const [, entries] of res) {
        for (const [entryId, fields] of entries) {
          const sig = parseEntry(fields);
          if (sig) {
            try {
              await this.handler(sig);
            } catch (err) {
              log.error({ err, signal: sig.id }, "signal handler failed; will retry on next start");
              continue; // leave unacked
            }
          }
          await this.redis.xack(this.stream, this.group, entryId);
          n += 1;
        }
      }
    }
    return n;
  }

  async run(): Promise<void> {
    await this.ensureGroup();
    while (!this.stopped) {
      try {
        await this.readOnce();
      } catch (err) {
        if (this.stopped) return;
        log.error({ err }, "signal consumer error");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
