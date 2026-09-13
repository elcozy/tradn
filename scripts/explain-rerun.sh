#!/usr/bin/env bash
# Rewrite the six explain reports under their setting-specific names, after the forward run is done.
set -euo pipefail
cd "$(dirname "$0")/.."
while ! grep -q '^EXIT' logs/forward.log; do sleep 20; done
r() { uv run --project services/research research "$@"; }
for s in long short; do
  r explain --tf 15m --side "$s" --stop-atr 1 --target-atr 2 --max-bars 24
  r explain --tf 15m --side "$s" --stop-atr 2 --target-atr 4 --max-bars 96
  r explain --tf 1h --side "$s" --stop-atr 1.5 --target-atr 3 --max-bars 48
done
