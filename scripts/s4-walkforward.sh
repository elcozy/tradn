#!/usr/bin/env bash
# Walk-forward for the S4 dump-bounce instance on every configured symbol, after the plain backtest has finished.
set -euo pipefail
cd "$(dirname "$0")/.."
while ! grep -q '^EXIT' logs/s4-backtest-2024.log; do sleep 20; done
r() { uv run --project services/research research "$@"; }
r walkforward s4_btc_15m --symbol all --since 2022-01-01 --train-days 180 --test-days 90
