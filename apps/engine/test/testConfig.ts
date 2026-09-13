/** Test helper: the repo config with the S1 fixture strategy re-enabled. S1/S2/S3 are disabled in the live config
 * (they lost on the universe, DECISIONS.md 2026-09-13) but the contract fixture signal still references s1_btc_15m. */
import type { AppConfig } from "../src/config.js";

export function withFixtureStrategyEnabled(cfg: AppConfig): AppConfig {
  return { ...cfg, strategies: cfg.strategies.map((s) => (s.id === "s1_btc_15m" ? { ...s, enabled: true } : s)) };
}
