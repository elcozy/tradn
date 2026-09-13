#!/usr/bin/env bash
# Daily 07:05 (pm2 cron): compare the last 14 days of shadow and paper positions with the backtester, add the paper
# equity, and post the result to Telegram. Exit code is always 0 so pm2 does not flag a mismatch as a crash.
set -uo pipefail
cd "$(dirname "$0")/.."
since=$(date -u -v-14d +%Y-%m-%d 2>/dev/null || date -u -d '14 days ago' +%Y-%m-%d)
r() { uv run --project services/research research "$@"; }
shadow=$(r compare --mode shadow --since "$since" 2>&1 | tail -1)
paper=$(r compare --mode paper --since "$since" 2>&1 | tail -1)
equity=$(docker exec trading-db psql -U trading -d trading -tAc "select round((balance_quote+unrealised)::numeric,2)||' USDT, drawdown '||round(drawdown_pct::numeric,2)||'%' from equity_snapshots where mode='paper' order by ts desc limit 1" 2>/dev/null)
open=$(docker exec trading-db psql -U trading -d trading -tAc "select mode||': '||count(*) from positions where state<>'closed' group by mode order by mode" 2>/dev/null | paste -sd ', ' -)
signals=$(docker exec trading-db psql -U trading -d trading -tAc "select count(*)||' signals in 7d, '||coalesce(sum(case when outcome in ('win','loss','breakeven') then 1 else 0 end),0)||' closed, '||coalesce(round(sum(realized_r)::numeric,2),0)||' R' from signals where ts >= now() - interval '7 days'" 2>/dev/null)
msg="Daily check ($(date -u +%Y-%m-%d))
last 7d: ${signals:-no data}
open positions: ${open:-none}
paper equity: ${equity:-no snapshot yet}
shadow vs backtest (14d): ${shadow}
paper vs backtest (14d): ${paper}"
echo "$msg"
scripts/notify.sh "$msg" >/dev/null || echo "telegram send failed"
exit 0
