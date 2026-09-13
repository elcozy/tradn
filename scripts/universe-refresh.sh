#!/usr/bin/env bash
# Weekly universe refresh (pm2 cron, see ecosystem.config.cjs): rescan Binance liquidity, rewrite the
# symbols line + UNIVERSE block in config/strategies.yaml, backfill history for new coins, and restart the
# processes that read the config only when it actually changed.
set -euo pipefail
cd "$(dirname "$0")/.."

before=$(shasum config/strategies.yaml)
uv run --project services/research research universe --apply --ingest
after=$(shasum config/strategies.yaml)

if [ "$before" = "$after" ]; then
  echo "universe unchanged; nothing to restart"
  exit 0
fi
echo "universe changed; restarting engine, signal-runner, dashboard"
node_modules/.bin/pm2 restart engine signal-runner dashboard --update-env
