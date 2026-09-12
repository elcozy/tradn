export * from "./gen/index.js";

/** Redis stream names. Keep in sync with services/research/research/contracts/streams.py */
export const STREAMS = {
  signals: "signals",
  engineEvents: "engine.events",
  engineCommands: "engine.commands",
} as const;

export const CONTRACT_VERSION = 1 as const;

export const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export const TIMEFRAME_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};
