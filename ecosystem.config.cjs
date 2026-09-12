// pm2 process definitions: `pnpm dlx pm2 start ecosystem.config.cjs` (see README). Logs go to ./logs.
const path = require("node:path");
const node = process.execPath;
module.exports = {
  apps: [
    {
      name: "engine",
      cwd: path.join(__dirname, "apps/engine"),
      script: "node_modules/.bin/tsx",
      args: "src/main.ts",
      interpreter: node,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/engine.out.log"),
      error_file: path.join(__dirname, "logs/engine.err.log"),
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
      name: "telegram",
      cwd: path.join(__dirname, "apps/dashboard"),
      script: "node_modules/.bin/tsx",
      args: "src/telegram/main.ts",
      interpreter: node,
      autorestart: true,
      restart_delay: 5000,
      out_file: path.join(__dirname, "logs/telegram.out.log"),
      error_file: path.join(__dirname, "logs/telegram.err.log"),
    },
  ],
};
