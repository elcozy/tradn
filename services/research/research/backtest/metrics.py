from __future__ import annotations

import math

import numpy as np
import pandas as pd


def compute_metrics(trades: pd.DataFrame, bars: int, bars_in_position: int, days: float) -> dict:
    if trades.empty:
        return {"trades": 0}
    r = trades["realized_r"].to_numpy()
    wins, losses = r[r > 0.05], r[r < -0.05]
    cum = np.cumsum(r)
    peak = np.maximum.accumulate(np.concatenate([[0.0], cum]))[1:]
    dd = cum - peak
    daily = trades.groupby(trades["closed_at"].dt.floor("D"))["realized_r"].sum()
    sharpe = float(daily.mean() / daily.std() * math.sqrt(365)) if len(daily) > 1 and daily.std() > 0 else None
    tp1_bars = []
    for evs in trades.get("events", pd.Series([[]] * len(trades))):
        pass
    losers = trades[trades["outcome"] == "loss"]
    winners = trades[trades["outcome"] == "win"]
    return {
        "trades": int(len(trades)),
        "wins": int(len(wins)),
        "losses": int(len(losses)),
        "win_rate": round(len(wins) / max(1, len(wins) + len(losses)), 4),
        "expectancy_r": round(float(r.mean()), 4),
        "sum_r": round(float(r.sum()), 3),
        "profit_factor": round(float(wins.sum() / -losses.sum()), 3) if len(losses) and losses.sum() < 0 else None,
        "max_drawdown_r": round(float(dd.min()), 3),
        "sharpe_daily": round(sharpe, 3) if sharpe is not None else None,
        "avg_mfe_of_losers": round(float(losers["mfe_r"].mean()), 3) if len(losers) else None,
        "avg_mae_of_winners": round(float(winners["mae_r"].mean()), 3) if len(winners) else None,
        "avg_bars_held": round(float(trades["bars_held"].mean()), 1),
        "trades_per_day": round(len(trades) / max(days, 1e-9), 3),
        "exposure_pct": round(bars_in_position / max(bars, 1) * 100, 2),
        "total_pnl": round(float(trades["realized_pnl"].sum()), 2),
        "total_fees": round(float(trades["fees"].sum()), 2),
        "close_reasons": trades["close_reason"].value_counts().to_dict(),
    }
