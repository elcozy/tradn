from __future__ import annotations

from datetime import datetime

import typer
from rich.console import Console

app = typer.Typer(help="Research CLI: migrate, ingest, backtest, run-live", no_args_is_help=True)
console = Console()


@app.command()
def migrate() -> None:
    """Apply infra/migrations/*.sql to the database."""
    from . import db

    applied = db.migrate()
    console.print(f"applied: {applied or 'nothing (up to date)'}")


@app.command()
def config() -> None:
    """Validate and print the strategy config."""
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    console.print(cfg.model_dump())


@app.command()
def ingest(
    symbol: str = typer.Option(None, help="Override: single symbol (default: all from config)"),
    tf: str = typer.Option(None, help="Override: comma-separated timeframes (default: all from config)"),
    since: datetime = typer.Option(None, help="ISO date to start from on first run"),
) -> None:
    """Fetch historical klines into the candles table (resumes from the last stored candle)."""
    from datetime import timedelta, timezone

    from .config import load_config
    from .ingest import ingest as run_ingest
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    symbols = [symbol] if symbol else cfg.symbols
    tfs = [t.strip() for t in tf.split(",")] if tf else cfg.timeframes
    chart_only = set(cfg.chart_timeframes) - set(cfg.strategy_timeframes)
    for s in symbols:
        for t in tfs:
            start = since
            if start is None and t in chart_only:
                start = datetime.now(timezone.utc) - timedelta(days=cfg.chart_lookback_days)
            n = run_ingest(s, t, since=start)
            console.print(f"[green]{s} {t}: wrote {n} candles[/]")


@app.command()
def backtest(
    strategy_id: str = typer.Argument(..., help="Strategy instance id from config, e.g. s1_btc_15m"),
    since: datetime = typer.Option(None),
    until: datetime = typer.Option(None),
    save: bool = typer.Option(True, help="Store run + trades in the database"),
) -> None:
    """Run the event-driven backtest for one strategy instance."""
    from .backtest.runner import run_backtest
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    result = run_backtest(cfg, strategy_id, since=since, until=until, save=save)
    console.print(result.summary())


def _instance_and_frames(strategy_id: str, since: datetime | None):
    """Config, instance and (entry, regime, range) candle frames for the walk-forward style commands."""
    from .backtest.runner import load_frames
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    inst = next((s for s in cfg.strategies if s.id == strategy_id), None)
    if inst is None:
        raise typer.BadParameter(f"unknown strategy id {strategy_id!r}; known: {[s.id for s in cfg.strategies]}")
    return cfg, inst, load_frames(cfg, inst, since, None)


def _print_windows(res: dict) -> None:
    for w in res["windows"]:
        console.print(f"{w['train'][0]}..{w['train'][1]} -> {w['test_end']}  params {w['params']} {w['exit']}  "
                      f"train {w['train_sum_r']}R  test {w['test'].get('trades', 0)} trades "
                      f"{w['test'].get('expectancy_r')}R exp, {w['test'].get('sum_r')}R sum")
    console.print("[bold]out-of-sample total:[/]", res["oos"])


@app.command()
def walkforward(
    strategy_id: str = typer.Argument(...),
    since: datetime = typer.Option(None),
    train_days: int = typer.Option(180),
    test_days: int = typer.Option(60),
) -> None:
    """Rolling walk-forward over the strategy's small parameter grid; prints out-of-sample metrics only."""
    from .backtest.walkforward import walk_forward
    from .strategies.base import strategy_class

    cfg, inst, (entry_df, regime_df, range_df) = _instance_and_frames(strategy_id, since)
    cls = strategy_class(inst.type)
    res = walk_forward(cfg, inst, entry_df, regime_df, cls.WALK_FORWARD_GRID, cls.WALK_FORWARD_EXIT_GRID,
                       train_days=train_days, test_days=test_days, range_df=range_df)
    _print_windows(res)


@app.command()
def optimize(
    strategy_id: str = typer.Argument(...),
    trials: int = typer.Option(30, help="optuna trials per train window"),
    since: datetime = typer.Option(None),
    train_days: int = typer.Option(180),
    test_days: int = typer.Option(60),
    seed: int = typer.Option(0, help="TPE sampler seed (same seed, same study)"),
) -> None:
    """Walk-forward with an optuna TPE study per train window over the strategy's SEARCH_SPACE (needs `uv sync --extra research`)."""
    from .backtest.optimize import optimize as _optimize

    cfg, inst, (entry_df, regime_df, range_df) = _instance_and_frames(strategy_id, since)
    res = _optimize(cfg, inst, entry_df, regime_df, range_df, trials=trials, train_days=train_days, test_days=test_days, seed=seed)
    _print_windows(res)


@app.command("would-have-won")
def would_have_won(
    since: datetime = typer.Option(None, help="Only signals at/after this time (default: every pending rejected signal)"),
) -> None:
    """Nightly job: replay the exit policy for every rejected signal and record how it would have ended."""
    from .jobs.would_have_won import run

    n = run(since=since)
    console.print(f"would_have_won: wrote {n} rows")


@app.command()
def compare(
    mode: str = typer.Option("shadow", help="shadow | paper | testnet | live"),
    since: datetime = typer.Option(None, help="Only positions opened at/after this time"),
    until: datetime = typer.Option(None),
    strategy_id: str = typer.Option(None),
    r_tol: float = typer.Option(None, help="Max |live R - backtest R| (default 1e-6 for paper, 0.05 otherwise)"),
) -> None:
    """Match every closed live position against a backtest of the same window (M3 shadow check, M5 paper check)."""
    from .compare import compare as _compare
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    rep = _compare(cfg, mode, since=since, until=until, strategy_id=strategy_id, r_tol=r_tol)
    console.print(rep.summary())
    raise typer.Exit(code=0 if rep.ok else 1)


@app.command()
def candles(symbol: str = typer.Option("BTCUSDT"), tf: str = typer.Option("15m"), last: int = typer.Option(5)) -> None:
    """Print the last N closed candles (cross-language check against `pnpm --filter @trading/engine candles`)."""
    from . import db

    df = db.load_candles(symbol, tf, limit=last)
    for ts, row in df.iterrows():
        print(f"{ts.isoformat()} o={row.open:.8g} h={row.high:.8g} l={row.low:.8g} c={row.close:.8g} v={row.volume:.8g}")


@app.command("run-live")
def run_live(
    once: bool = typer.Option(False, help="Evaluate the latest closed candle once and exit"),
) -> None:
    """Evaluate every enabled strategy on each closed candle and publish signals."""
    from .config import load_config
    from .live.runner import run_live as _run_live
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    _run_live(cfg, once=once)


if __name__ == "__main__":
    app()
