/** engine.commands consumer: pause / resume / news toggle / close / kill. */
import { EngineCommandSchema, STREAMS, type EngineCommand } from "@trading/contracts";
import type { Redis } from "ioredis";
import { EngineEventType, type EventSink } from "../events.js";
import { log } from "../log.js";
import { ExitReason } from "../positions/exitPolicy.js";
import type { PositionManager } from "../positions/manager.js";
import type { StateStore } from "../state.js";

export enum CommandType {
  ClosePosition = "close_position",
  CloseAll = "close_all",
  Pause = "pause",
  Resume = "resume",
  Kill = "kill",
  MoveSl = "move_sl",
  NewsOn = "news_on",
  NewsOff = "news_off",
  /** M7 live gate: a live engine boots with entries off and is armed on purpose. */
  EntriesOn = "entries_on",
  EntriesOff = "entries_off",
}

export async function applyCommand(cmd: EngineCommand, state: StateStore, manager: PositionManager, events: EventSink): Promise<void> {
  switch (cmd.type as CommandType) {
    case CommandType.Pause:
      await state.setPaused(true);
      await events.emit({ type: EngineEventType.Paused, reason: cmd.reason ?? cmd.source });
      break;
    case CommandType.Resume:
      await state.setPaused(false);
      await events.emit({ type: EngineEventType.Resumed, reason: cmd.reason ?? cmd.source });
      break;
    case CommandType.NewsOn:
      await state.setNewsBlock(true);
      await events.emit({ type: EngineEventType.Paused, reason: "news_block on" });
      break;
    case CommandType.NewsOff:
      await state.setNewsBlock(false);
      await events.emit({ type: EngineEventType.Resumed, reason: "news_block off" });
      break;
    case CommandType.EntriesOn:
      await state.setEntriesEnabled(true);
      await events.emit({ type: EngineEventType.Resumed, reason: `entries enabled (${cmd.source})` });
      break;
    case CommandType.EntriesOff:
      await state.setEntriesEnabled(false);
      await events.emit({ type: EngineEventType.Paused, reason: `entries disabled (${cmd.source}); open positions keep trailing` });
      break;
    case CommandType.ClosePosition:
      await manager.closeAll(ExitReason.Manual, cmd.position_id);
      break;
    case CommandType.CloseAll:
      await manager.closeAll(ExitReason.Manual);
      break;
    case CommandType.Kill: {
      const n = await manager.closeAll(ExitReason.Kill);
      await state.setPaused(true);
      await events.emit({ type: EngineEventType.KillSwitch, reason: cmd.reason ?? cmd.source, detail: { closed: n } });
      break;
    }
    case CommandType.MoveSl:
      log.warn("move_sl not implemented yet");
      break;
  }
}

export class CommandConsumer {
  private stopped = false;
  constructor(
    private redis: Redis,
    private handler: (cmd: EngineCommand) => Promise<void>,
    private group = "engine",
    private consumer = `engine-${process.pid}`,
  ) {}

  async run(): Promise<void> {
    try {
      await this.redis.xgroup("CREATE", STREAMS.engineCommands, this.group, "$", "MKSTREAM");
    } catch (err) {
      if (!String(err).includes("BUSYGROUP")) throw err;
    }
    while (!this.stopped) {
      try {
        const res = (await this.redis.xreadgroup(
          "GROUP", this.group, this.consumer, "COUNT", "10", "BLOCK", "5000", "STREAMS", STREAMS.engineCommands, ">",
        )) as [string, [string, string[]][]][] | null;
        if (!res) continue;
        for (const [, entries] of res) {
          for (const [id, fields] of entries) {
            const i = fields.indexOf("json");
            const parsed = i >= 0 ? EngineCommandSchema.safeParse(JSON.parse(fields[i + 1]!)) : null;
            if (parsed?.success) await this.handler(parsed.data);
            else log.warn({ fields }, "invalid command");
            await this.redis.xack(STREAMS.engineCommands, this.group, id);
          }
        }
      } catch (err) {
        if (this.stopped) return;
        log.error({ err }, "command consumer error");
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  stop() {
    this.stopped = true;
  }
}
