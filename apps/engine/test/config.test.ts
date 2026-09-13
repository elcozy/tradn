import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { TIMEFRAME_MS, type Timeframe } from "@trading/contracts";
import { AppConfigSchema, REPO_ROOT, configTimeframes, enabledStrategies, parseAppConfig, strategyTimeframes } from "../src/config.js";

const text = readFileSync(resolve(REPO_ROOT, "config/strategies.yaml"), "utf8");
const raw = () => parseYaml(text) as Record<string, any>;

describe("strategy config", () => {
  it("loads the repo config", () => {
    const cfg = parseAppConfig(text);
    expect(cfg.mode).toBe("shadow");
    expect(enabledStrategies(cfg)[0]?.id).toBe("s4_btc_15m"); // S1/S2/S3 disabled since 2026-09-13
    const tfs = strategyTimeframes(cfg);
    expect(tfs).toEqual(expect.arrayContaining(["15m", "1h"]));
    expect(tfs).toEqual([...tfs].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b])); // fastest first
    expect(configTimeframes(cfg)).toEqual([...new Set(["1m", ...tfs])].sort((a, b) => TIMEFRAME_MS[a as Timeframe] - TIMEFRAME_MS[b as Timeframe]));
  });
  it("rejects an invalid timeframe", () => {
    const r = raw();
    r.strategies[0].entry_tf = "7m";
    expect(() => AppConfigSchema.parse(r)).toThrow();
  });
  it("rejects a regime timeframe not slower than entry", () => {
    const r = raw();
    r.strategies[0].regime_tf = "5m";
    expect(() => AppConfigSchema.parse(r)).toThrow(/regime_tf/);
  });
  it("rejects unknown keys", () => {
    const r = raw();
    r.risk.typo = 1;
    expect(() => AppConfigSchema.parse(r)).toThrow();
  });
  it("rejects a strategy symbol not in the symbols list", () => {
    const r = raw();
    r.strategies[0].symbol = "NOPEUSDT";
    expect(() => AppConfigSchema.parse(r)).toThrow(/not in symbols/);
  });
  it("rejects duplicate strategy ids", () => {
    const r = raw();
    r.strategies.push({ ...r.strategies[0] });
    expect(() => AppConfigSchema.parse(r)).toThrow(/duplicate/);
  });
});
