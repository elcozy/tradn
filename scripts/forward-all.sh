#!/usr/bin/env bash
# Step 3 for every barrier setting and side, once the label/explain run has finished.
set -euo pipefail
cd "$(dirname "$0")/.."
while ! grep -q '^EXIT' logs/label-explain.log; do sleep 20; done
r() { uv run --project services/research research "$@"; }
for s in long short; do
  r forward --tf 15m --side "$s" --stop-atr 1 --target-atr 2 --max-bars 24
  r forward --tf 15m --side "$s" --stop-atr 2 --target-atr 4 --max-bars 96
  r forward --tf 1h --side "$s" --stop-atr 1.5 --target-atr 3 --max-bars 48
done
