/**
 * Environment (.env at repo root) + strategy config (config/strategies.yaml).
 * Mirrors services/research/research/config.py — both must accept and reject the same files.
 */
import { config as loadDotenv } from "dotenv";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { TIMEFRAMES, TIMEFRAME_MS } from "@trading/contracts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const EnvSchema = z.object({
  DATABASE_URL: z.string().default("postgres://trading:trading@localhost:5435/trading"),
  REDIS_URL: z.string().default("redis://localhost:6375"),
  STRATEGY_CONFIG: z.string().default("config/strategies.yaml"),
  /** Overrides `mode:` in strategies.yaml so a second engine (e.g. paper) can run beside the shadow soak. */
  MODE: z.enum(["shadow", "paper", "testnet", "live"]).optional(),
  BINANCE_API_KEY: z.string().default(""),
  BINANCE_API_SECRET: z.string().default(""),
  BINANCE_TESTNET_API_KEY: z.string().default(""),
  BINANCE_TESTNET_API_SECRET: z.string().default(""),
  TELEGRAM_BOT_TOKEN: z.string().default(""),
  TELEGRAM_CHAT_ID: z.string().default(""),
  LOG_LEVEL: z.string().default("info"),
});
export type Env = z.infer<typeof EnvSchema>;

const Tf = z.enum(TIMEFRAMES);

export const ExitParamsSchema = z
  .object({
    tp1_r: z.number().default(1),
    tp1_fraction: z.number().min(0).max(1).default(0.5),
    breakeven_r: z.number().default(1),
    trail_atr_k: z.number().nullable().default(2), // null: never trail (mean-reversion strategies)
    tp_ratchet_atr: z.number().nullable().default(1), // null: target never ratchets
    fee_pct: z.number().default(0.1),
    max_bars: z.number().int().nullable().default(null),
  })
  .strict();
export type ExitParams = z.infer<typeof ExitParamsSchema>;

const StrategyInstanceSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    symbol: z.string(),
    entry_tf: Tf,
    regime_tf: Tf,
    range_tf: Tf.optional(),
    enabled: z.boolean().default(true),
    params: z.record(z.unknown()).default({}),
    exit: ExitParamsSchema.default({}),
  })
  .strict()
  .refine((s) => TIMEFRAME_MS[s.regime_tf] > TIMEFRAME_MS[s.entry_tf], {
    message: "regime_tf must be slower than entry_tf",
  });

export const AppConfigSchema = z
  .object({
    mode: z.enum(["shadow", "paper", "testnet", "live"]).default("shadow"),
    symbols: z.array(z.string()).min(1),
    chart_timeframes: z.array(Tf).default([]),
    chart_lookback_days: z.number().int().default(30),
    strategies: z.array(StrategyInstanceSchema),
    regime: z
      .object({
        ema_fast: z.number().int().default(50),
        ema_slow: z.number().int().default(200),
        atr_len: z.number().int().default(14),
        atr_pct_min: z.number().default(0.3),
        atr_pct_max: z.number().default(3),
        no_trade_minutes_after_daily_open: z.number().int().default(15),
      })
      .strict()
      .default({}),
    risk: z
      .object({
        per_trade_pct: z.number().default(1),
        daily_loss_pct: z.number().default(3),
        max_open: z.number().int().default(3),
        max_per_symbol: z.number().int().default(1),
        consecutive_loss_cooldown: z.number().int().default(3),
        cooldown_minutes: z.number().int().default(120),
        notional_cap_pct: z.number().default(25),
      })
      .strict()
      .default({}),
    paper: z
      .object({
        starting_balance: z.number().default(10_000),
        slippage_pct: z.number().default(0.05),
        fee_pct: z.number().default(0.1),
      })
      .strict()
      .default({}),
    /** Liquidity-filtered universe maintained by `research universe`; the engine only validates it. */
    universe: z
      .object({
        pinned: z.array(z.string()).default([]),
        min_volume_usd: z.number().default(10_000_000),
        max_spread_pct: z.number().default(0.05),
        lookback_days: z.number().int().default(30),
        min_age_days: z.number().int().default(365),
        max_symbols: z.number().int().default(50),
        exclude: z.array(z.string()).default([]),
        template: z.string().default("s1_btc_15m"),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const s of cfg.strategies) {
      if (ids.has(s.id)) ctx.addIssue({ code: "custom", message: `duplicate strategy id ${s.id}` });
      ids.add(s.id);
      if (!cfg.symbols.includes(s.symbol))
        ctx.addIssue({ code: "custom", message: `${s.id}: symbol ${s.symbol} not in symbols list` });
    }
    if (cfg.universe) {
      for (const s of cfg.universe.pinned)
        if (!cfg.symbols.includes(s)) ctx.addIssue({ code: "custom", message: `universe.pinned symbol ${s} not in symbols list` });
      if (!ids.has(cfg.universe.template)) ctx.addIssue({ code: "custom", message: `universe.template ${cfg.universe.template} is not a strategy id` });
    }
  });

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type StrategyInstance = AppConfig["strategies"][number];
export type Mode = AppConfig["mode"];

export function parseAppConfig(yamlText: string): AppConfig {
  return AppConfigSchema.parse(parseYaml(yamlText) ?? {});
}

export function loadEnv(): Env {
  loadDotenv({ path: resolve(REPO_ROOT, ".env") });
  return EnvSchema.parse(process.env);
}

export function loadAppConfig(env: Env): AppConfig {
  const p = isAbsolute(env.STRATEGY_CONFIG) ? env.STRATEGY_CONFIG : resolve(REPO_ROOT, env.STRATEGY_CONFIG);
  const cfg = parseAppConfig(readFileSync(p, "utf8"));
  return env.MODE ? { ...cfg, mode: env.MODE } : cfg;
}

/** Union of every timeframe any strategy needs, fastest first. */
export function strategyTimeframes(cfg: AppConfig): (typeof TIMEFRAMES)[number][] {
  const set = new Set<(typeof TIMEFRAMES)[number]>();
  for (const s of cfg.strategies) {
    set.add(s.entry_tf);
    set.add(s.regime_tf);
    if (s.range_tf) set.add(s.range_tf);
  }
  return [...set].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
}

/** Strategy timeframes plus chart-only ones: what the engine streams and stores. */
export function configTimeframes(cfg: AppConfig): (typeof TIMEFRAMES)[number][] {
  const set = new Set<(typeof TIMEFRAMES)[number]>([...strategyTimeframes(cfg), ...cfg.chart_timeframes]);
  return [...set].sort((a, b) => TIMEFRAME_MS[a] - TIMEFRAME_MS[b]);
}

export function enabledStrategies(cfg: AppConfig): StrategyInstance[] {
  return cfg.strategies.filter((s) => s.enabled);
}
