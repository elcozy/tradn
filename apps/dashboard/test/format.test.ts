import { describe, expect, it } from "vitest";
import { EngineEventSchema } from "@trading/contracts";
import { TelegramCommand, formatDaily, formatEvent, formatStatus, parseCommand } from "../src/telegram/format.js";

const ev = (over: Record<string, unknown>) =>
  EngineEventSchema.parse({ v: 1, ts: "2026-09-12T14:30:00Z", mode: "shadow", symbol: "BTCUSDT", timeframe: "15m", ...over });

describe("telegram formatting", () => {
  it("position_opened shows entry, stop, targets and projected R", () => {
    const t = formatEvent(ev({ type: "position_opened", strategy_id: "s1", entry_price: 61234.5, sl_price: 60698, tp1_price: 61770.5, tp_price: 62500, detail: { projected_r: 2.36 }, reason: "level 60850" }))!;
    expect(t).toContain("BUY signal");
    expect(t).toContain("61234");
    expect(t).toContain("+2.36R");
    expect(t).toContain("level 60850");
  });
  it("position_closed picks the icon from R", () => {
    expect(formatEvent(ev({ type: "position_closed", price: 62000, r_multiple: 1.5, pnl: 33, reason: "trailing", detail: { bars_held: 7, mfe_r: 2, mae_r: 0.3 } }))).toContain("✅");
    expect(formatEvent(ev({ type: "position_closed", price: 60000, r_multiple: -1, pnl: -22, reason: "stop", detail: {} }))).toContain("❌");
  });
  it("heartbeat is silent", () => {
    expect(formatEvent(ev({ type: "heartbeat" }))).toBeNull();
  });
  it("escapes html in reasons", () => {
    expect(formatEvent(ev({ type: "alert", reason: "<b>x</b>" }))).toContain("&lt;b&gt;");
  });
  it("status and daily render", () => {
    const s = formatStatus({ mode: "shadow", paused: false, newsBlock: true, lastCandleAt: new Date(Date.now() - 120_000), lastHeartbeat: null, open: [{ symbol: "BTCUSDT", entry: 61234, sl: 60698, tp: 62500, state: "open", bars: 3 }], today: { trades: 2, r: -0.5 } });
    expect(s).toContain("news block");
    expect(s).toContain("2 min ago");
    expect(s).toContain("heartbeat never");
    expect(s).toContain("BTCUSDT open");
    const d = formatDaily({ mode: "shadow", day: "2026-09-12", signals: 3, rejected: 1, closed: 2, wins: 1, losses: 1, r: 0.4, pnl: 8.8, expectancy30d: null });
    expect(d).toContain("3 (rejected 1)");
    expect(d).toContain("n/a");
  });
});

describe("command parsing", () => {
  it("parses commands with bot suffix and args", () => {
    expect(parseCommand("/status@my_bot")).toEqual({ cmd: TelegramCommand.Status, args: [] });
    expect(parseCommand("/close BTCUSDT")).toEqual({ cmd: TelegramCommand.Close, args: ["BTCUSDT"] });
    expect(parseCommand("/news off")).toEqual({ cmd: TelegramCommand.News, args: ["off"] });
  });
  it("ignores unknown commands and plain text", () => {
    expect(parseCommand("/dance")).toBeNull();
    expect(parseCommand("hello")).toBeNull();
  });
});
