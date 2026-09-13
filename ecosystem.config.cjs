// pm2 process definitions: `pnpm dlx pm2 start ecosystem.config.cjs` (see README). Logs go to ./logs.
const path = require("node:path");
// tsx is a devDependency of each app, so its pnpm shell shim lives in that app's node_modules/.bin
const tsx = (app) => path.join(__dirname, app, "node_modules/.bin/tsx");
module.exports = {
  apps: [
    {
      name: "engine",
      cwd: path.join(__dirname, "apps/engine"),
      script: "src/main.ts",
      interpreter: tsx("apps/engine"),
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/engine.out.log"),
      error_file: path.join(__dirname, "logs/engine.err.log"),
    },
    {
      // M5: a second engine in paper mode beside the shadow soak (own consumer group, own positions/equity rows).
      // Start it explicitly: `pnpm dlx pm2 start ecosystem.config.cjs --only engine-paper`
      name: "engine-paper",
      cwd: path.join(__dirname, "apps/engine"),
      script: "src/main.ts",
      interpreter: tsx("apps/engine"),
      env: { MODE: "paper" },
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/engine-paper.out.log"),
      error_file: path.join(__dirname, "logs/engine-paper.err.log"),
    },
    {
      // M8 nightly job: replay rejected signals and record whether they would have won (00:30 UTC).
      name: "would-have-won",
      cwd: path.join(__dirname, "services/research"),
      script: "uv",
      args: "run research would-have-won",
      interpreter: "none",
      autorestart: false,
      cron_restart: "30 0 * * *",
      out_file: path.join(__dirname, "logs/would-have-won.out.log"),
      error_file: path.join(__dirname, "logs/would-have-won.err.log"),
    },
    {
      // Weekly (Monday 01:30 machine time): refresh the liquidity-filtered universe, backfill new coins,
      // restart the readers if the config changed. Runs once when started, then on the cron.
      name: "universe-refresh",
      cwd: __dirname,
      script: "scripts/universe-refresh.sh",
      interpreter: "bash",
      autorestart: false,
      cron_restart: "30 1 * * 1",
      out_file: path.join(__dirname, "logs/universe-refresh.out.log"),
      error_file: path.join(__dirname, "logs/universe-refresh.err.log"),
    },
    {
      name: "daily-check",
      cwd: __dirname,
      script: "scripts/daily-check.sh",
      interpreter: "bash",
      autorestart: false,
      cron_restart: "5 7 * * *",
      out_file: path.join(__dirname, "logs/daily-check.out.log"),
      error_file: path.join(__dirname, "logs/daily-check.err.log"),
    },
    {
      name: "signal-runner",
      cwd: path.join(__dirname, "services/research"),
      script: "uv",
      args: "run research run-live",
      interpreter: "none",
      autorestart: true,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/runner.out.log"),
      error_file: path.join(__dirname, "logs/runner.err.log"),
    },
    {
      name: "dashboard",
      cwd: path.join(__dirname, "apps/dashboard"),
      script: "src/api/main.ts",
      interpreter: tsx("apps/dashboard"),
      autorestart: true,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/dashboard.out.log"),
      error_file: path.join(__dirname, "logs/dashboard.err.log"),
    },
    {
      name: "telegram",
      cwd: path.join(__dirname, "apps/dashboard"),
      script: "src/telegram/main.ts",
      interpreter: tsx("apps/dashboard"),
      autorestart: true,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/telegram.out.log"),
      error_file: path.join(__dirname, "logs/telegram.err.log"),
    },
  ],
};
