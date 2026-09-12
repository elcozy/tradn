import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SignalSchema } from "@trading/contracts";
import { REPO_ROOT, parseAppConfig } from "../src/config.js";
import { RejectReason, checkSignal, type RiskContext } from "../src/risk/riskManager.js";

const cfg = parseAppConfig(readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8"));
const sig = SignalSchema.parse(JSON.parse(readFileSync(resolve(REPO_ROOT, "packages/contracts/fixtures/signal.valid.json"), "utf8")));
const base = (): RiskContext => ({
  now: new Date(new Date(sig.ts).getTime() + 60_000),
  paused: false,
  newsBlock: false,
  openPositions: [],
  knownSignalIds: new Set(),
  consecutiveLosses: 0,
  lastLossAt: null,
  dailyR: 0,
  balance: 10_000,
});

describe("risk manager", () => {
  it("sizes by risk when the notional cap allows it", () => {
    const wide = { ...sig, stop_price: sig.entry.price * 0.9 }; // 10% stop -> notional 10% of equity
    const d = checkSignal(cfg, wide, base());
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.riskAmount).toBeCloseTo(100, 6); // 1% of 10k
      expect(d.qty).toBeCloseTo(100 / (wide.entry.price - wide.stop_price), 10);
    }
  });
  it("on spot the notional cap limits effective risk to cap x stop distance", () => {
    const d = checkSignal(cfg, sig, base()); // 0.88% stop, 1% target risk -> needs 114% notional
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.qty * sig.entry.price).toBeCloseTo(2500, 6);
      expect(d.riskAmount).toBeCloseTo(2500 * ((sig.entry.price - sig.stop_price) / sig.entry.price), 6); // ~21.9
      expect(d.riskAmount).toBeLessThan(100);
    }
  });
  it("caps notional", () => {
    const tight = { ...sig, stop_price: sig.entry.price - 1 }; // would need huge qty
    const d = checkSignal(cfg, tight, base());
    expect(d.ok && d.qty * sig.entry.price).toBeCloseTo(2500, 6); // 25% of 10k
  });
  const cases: [string, Partial<RiskContext>, RejectReason][] = [
    ["paused", { paused: true }, RejectReason.Paused],
    ["news", { newsBlock: true }, RejectReason.NewsBlock],
    ["duplicate", { knownSignalIds: new Set([sig.id]) }, RejectReason.Duplicate],
    ["max open", { openPositions: [{ symbol: "A", signal_id: "1" }, { symbol: "B", signal_id: "2" }, { symbol: "C", signal_id: "3" }] }, RejectReason.MaxOpen],
    ["per symbol", { openPositions: [{ symbol: "BTCUSDT", signal_id: "1" }] }, RejectReason.MaxPerSymbol],
    ["daily loss", { dailyR: -3 }, RejectReason.DailyLoss],
    ["cooldown", { consecutiveLosses: 3, lastLossAt: new Date(new Date(sig.ts).getTime()) }, RejectReason.Cooldown],
    ["stale", { now: new Date(new Date(sig.ts).getTime() + 3 * 15 * 60_000) }, RejectReason.Stale],
  ];
  for (const [name, over, reason] of cases) {
    it(`rejects: ${name}`, () => {
      const d = checkSignal(cfg, sig, { ...base(), ...over });
      expect(d).toMatchObject({ ok: false, reason });
    });
  }
  it("rejects bad geometry and unknown strategy", () => {
    expect(checkSignal(cfg, { ...sig, stop_price: sig.entry.price + 1 }, base())).toMatchObject({ ok: false, reason: RejectReason.BadGeometry });
    expect(checkSignal(cfg, { ...sig, strategy_id: "nope" }, base())).toMatchObject({ ok: false, reason: RejectReason.UnknownStrategy });
  });
  it("cooldown expires", () => {
    const d = checkSignal(cfg, sig, { ...base(), consecutiveLosses: 3, lastLossAt: new Date(new Date(sig.ts).getTime() - 3 * 3600_000) });
    expect(d.ok).toBe(true);
  });
});
