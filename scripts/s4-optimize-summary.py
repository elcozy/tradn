"""Pool the out-of-sample results of scripts/s4-optimize.sh (one log per coin) into one table."""
import ast
import re
from pathlib import Path

rows, tot_trades, tot_r, tot_wins, tot_losses = [], 0, 0.0, 0, 0
for log in sorted(Path("logs/s4-optimize").glob("*USDT.log")):
    text = log.read_text()
    m = re.search(r"out-of-sample total:\s*(\{.*?\})\s*$", text.replace("\n", " "), re.DOTALL)
    if not m:
        rows.append((log.stem, None)); continue
    d = ast.literal_eval(m.group(1))
    rows.append((log.stem, d))
    if d.get("trades"):
        tot_trades += d["trades"]; tot_r += d["sum_r"]; tot_wins += d["wins"]; tot_losses += d["losses"]
    picks = re.findall(r"params (\{.*?\}) (\{.*?\})", text)
for sym, d in rows:
    if not d or not d.get("trades"):
        print(f"{sym:10} no OOS trades" if d else f"{sym:10} FAILED or still running")
        continue
    print(f"{sym:10} OOS trades {d['trades']:4d}  win {d['win_rate']:.0%}  exp {d['expectancy_r']:+.3f}R  sum {d['sum_r']:+.1f}R  "
          f"max DD {d['max_drawdown_r']}R  PF {d['profit_factor']}  avg bars {d['avg_bars_held']}  {d['close_reasons']}")
if tot_trades:
    print(f"\npooled: trades {tot_trades}  win {tot_wins / max(1, tot_wins + tot_losses):.0%}  exp {tot_r / tot_trades:+.3f}R  sum {tot_r:+.1f}R")
