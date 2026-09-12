from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

import pandas as pd
from sqlalchemy import text

from .. import db
from ..config import TIMEFRAME_MS, AppConfig, StrategyInstance
from ..strategies.base import make_strategy, strategy_class
from . import engine
from .baselines import buy_and_hold, random_baseline
from .metrics import compute_metrics


@dataclass
class BacktestResult:
    run_id: str
    strategy_id: str
    metrics: dict
    baselines: dict
    skip_reasons: dict
    trades: pd.DataFrame

    def summary(self) -> str:
        m = self.metrics
        lines = [f"run {self.run_id}  strategy {self.strategy_id}"]
        if m.get("trades", 0) == 0:
            lines.append("no trades")
        else:
            lines += [
                f"trades {m['trades']}  win rate {m['win_rate']:.0%}  expectancy {m['expectancy_r']:+.3f}R  sum {m['sum_r']:+.1f}R",
                f"profit factor {m['profit_factor']}  max DD {m['max_drawdown_r']}R  sharpe(daily) {m['sharpe_daily']}",
                f"avg bars held {m['avg_bars_held']}  trades/day {m['trades_per_day']}  exposure {m['exposure_pct']}%",
                f"pnl {m['total_pnl']:+.2f} (fees {m['total_fees']:.2f})  close reasons {m['close_reasons']}",
                f"MFE of losers {m['avg_mfe_of_losers']}R  MAE of winners {m['avg_mae_of_winners']}R",
            ]
        lines.append(f"baselines: buy&hold {self.baselines['buy_and_hold']}  random {self.baselines['random']}")
        top = sorted(self.skip_reasons.items(), key=lambda kv: -kv[1])[:6]
        lines.append(f"skip reasons: {top}")
        return "\n".join(lines)


def load_frames(
    cfg: AppConfig, inst: StrategyInstance, since: datetime | None, until: datetime | None
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame | None]:
    """Entry, regime and (when the instance has a range_tf) range candles from the database; the slower
    frames start early enough ahead of `since` for the strategy's warmup."""
    warm = strategy_class(inst.type).warmup_bars(inst, cfg.regime)

    def ahead(tf: str, bars: int) -> datetime | None:
        return since - pd.Timedelta(milliseconds=TIMEFRAME_MS[tf] * bars) if since is not None else None

    entry_df = db.load_candles(inst.symbol, inst.entry_tf, since=since, until=until)
    regime_df = db.load_candles(inst.symbol, inst.regime_tf, since=ahead(inst.regime_tf, warm["regime"]), until=until)
    range_df = None
    if inst.range_tf:
        range_df = db.load_candles(inst.symbol, inst.range_tf, since=ahead(inst.range_tf, warm["range"]), until=until)
    return entry_df, regime_df, range_df


def run_backtest(cfg: AppConfig, strategy_id: str, since: datetime | None, until: datetime | None, save: bool = True) -> BacktestResult:
    inst = next((s for s in cfg.strategies if s.id == strategy_id), None)
    if inst is None:
        raise ValueError(f"unknown strategy id {strategy_id}")
    since = since.replace(tzinfo=since.tzinfo or timezone.utc) if since else None
    until = until.replace(tzinfo=until.tzinfo or timezone.utc) if until else None
    entry_df, regime_df, range_df = load_frames(cfg, inst, since, until)
    if entry_df.empty or regime_df.empty or (range_df is not None and range_df.empty):
        raise RuntimeError("no candles loaded; run `research ingest` first")

    strat = make_strategy(inst, cfg.regime)
    out = engine.run(cfg, inst, strat, entry_df, regime_df, range_df=range_df)
    trades = out.frame()
    days = (out.end - out.start).total_seconds() / 86400
    metrics = compute_metrics(trades, out.bars, out.bars_in_position, days)
    baselines = {
        "buy_and_hold": buy_and_hold(entry_df),
        "random": random_baseline(cfg, inst, entry_df, regime_df, n_trades=max(metrics.get("trades", 0), 20), range_df=range_df),
    }
    run_id = f"bt_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{uuid.uuid4().hex[:6]}"
    if save:
        _save(run_id, inst, out, trades, metrics, baselines)
    return BacktestResult(run_id, strategy_id, metrics, baselines, out.skip_reasons, trades)


def _save(run_id, inst, out, trades: pd.DataFrame, metrics, baselines) -> None:
    with db.engine().begin() as conn:
        conn.execute(
            text(
                "INSERT INTO backtest_runs (id, strategy_id, symbol, timeframe, params, from_ts, to_ts, metrics) "
                "VALUES (:id, :sid, :sym, :tf, :params, :f, :t, :m)"
            ),
            {
                "id": run_id, "sid": inst.id, "sym": inst.symbol, "tf": inst.entry_tf,
                "params": json.dumps({"params": inst.params, "exit": inst.exit.model_dump()}),
                "f": out.start.to_pydatetime(), "t": out.end.to_pydatetime(),
                "m": json.dumps({**metrics, "baselines": baselines, "skip_reasons": out.skip_reasons}),
            },
        )
        if not trades.empty:
            rows = [
                {
                    "run_id": run_id, "signal_id": t.signal_id, "ts": t.ts.to_pydatetime(), "symbol": t.symbol, "timeframe": t.timeframe,
                    "entry_price": t.entry_price, "stop_price": t.stop_price, "tp1_price": t.tp1_price, "tp_price": t.tp_price,
                    "actual_entry": t.actual_entry, "exit_price": t.exit_price, "outcome": t.outcome, "realized_r": t.realized_r,
                    "realized_pnl": t.realized_pnl, "fees": t.fees, "mfe_r": t.mfe_r, "mae_r": t.mae_r, "bars_held": int(t.bars_held),
                    "close_reason": t.close_reason, "closed_at": t.closed_at.to_pydatetime(), "meta": json.dumps({**t.meta, "events": t.events}),
                }
                for t in out.trades
            ]
            conn.execute(
                text(
                    "INSERT INTO backtest_trades (run_id, signal_id, ts, symbol, timeframe, entry_price, stop_price, tp1_price, tp_price, "
                    "actual_entry, exit_price, outcome, realized_r, realized_pnl, fees, mfe_r, mae_r, bars_held, close_reason, closed_at, meta) "
                    "VALUES (:run_id, :signal_id, :ts, :symbol, :timeframe, :entry_price, :stop_price, :tp1_price, :tp_price, :actual_entry, "
                    ":exit_price, :outcome, :realized_r, :realized_pnl, :fees, :mfe_r, :mae_r, :bars_held, :close_reason, :closed_at, :meta) "
                    "ON CONFLICT (run_id, signal_id) DO NOTHING"
                ),
                rows,
            )
