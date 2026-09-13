#!/usr/bin/env bash
# Label + explain over a symbol list at three barrier settings (15m tight, 15m wide, 1h). Usage: scripts/label-explain.sh SYM1,SYM2,...
set -euo pipefail
cd "$(dirname "$0")/.."
SYMS="$1"
r() { uv run --project services/research research "$@"; }
r label --tf 15m --symbol "$SYMS" --side both --stop-atr 1 --target-atr 2 --max-bars 24
r label --tf 15m --symbol "$SYMS" --side both --stop-atr 2 --target-atr 4 --max-bars 96
r label --tf 1h --symbol "$SYMS" --side both --stop-atr 1.5 --target-atr 3 --max-bars 48
for s in long short; do
  r explain --tf 15m --side "$s" --stop-atr 1 --target-atr 2 --max-bars 24
  r explain --tf 15m --side "$s" --stop-atr 2 --target-atr 4 --max-bars 96
  r explain --tf 1h --side "$s" --stop-atr 1.5 --target-atr 3 --max-bars 48
done
