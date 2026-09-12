import pino from "pino";

const level = process.env.VITEST ? "silent" : (process.env.LOG_LEVEL ?? "info");

export const log = pino({
  level,
  transport: process.stdout.isTTY && !process.env.VITEST ? { target: "pino-pretty", options: { colorize: true } } : undefined,
});
