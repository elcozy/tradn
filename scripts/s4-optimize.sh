#!/usr/bin/env bash
# Optuna walk-forward for S4 on every configured symbol, four coins at a time. Each coin: rolling 180-day train
# windows (40 TPE trials over entry thresholds + trailing/take-profit/time exits) followed by 90-day test windows;
# only test-window trades are reported. Per-coin logs in logs/s4-optimize/<SYMBOL>.log; summary printed at the end.
set -uo pipefail
cd "$(dirname "$0")/.."
TRIALS="${TRIALS:-40}"
symbols=$(uv run --project services/research python -c "from research.config import load_config; print(' '.join(load_config('config/strategies.yaml').symbols))")
one() {
  s="$1"
  uv run --project services/research research optimize s4_btc_15m --symbol "$s" --trials "$TRIALS" \
    --since 2022-01-01 --train-days 180 --test-days 90 > "logs/s4-optimize/$s.log" 2>&1
  echo "$s done (exit $?)"
}
export -f one; export TRIALS
printf '%s\n' $symbols | xargs -P 4 -I{} bash -c 'one {}'
uv run --project services/research python scripts/s4-optimize-summary.py
