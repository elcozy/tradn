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
    from .config import load_config
    from .ingest import ingest as run_ingest
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    symbols = [symbol] if symbol else cfg.symbols
    tfs = [t.strip() for t in tf.split(",")] if tf else cfg.timeframes
    for s in symbols:
        for t in tfs:
            n = run_ingest(s, t, since=since)
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


@app.command()
def walkforward(
    strategy_id: str = typer.Argument(...),
    since: datetime = typer.Option(None),
    train_days: int = typer.Option(180),
    test_days: int = typer.Option(60),
) -> None:
    """Rolling walk-forward over a small parameter grid; prints out-of-sample metrics only."""
    from . import db
    from .backtest.walkforward import walk_forward
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    inst = next(s for s in cfg.strategies if s.id == strategy_id)
    entry_df = db.load_candles(inst.symbol, inst.entry_tf, since=since)
    regime_df = db.load_candles(inst.symbol, inst.regime_tf, since=since)
    grid = {
        "min_r": [1.5, 2.0], "max_fee_r": [0.4, 1.0], "stop_below_level_pct": [0.25, 0.75],
        "invalidation_pct": [0.0, 0.5],
    }
    exit_grid = {"trail_atr_k": [2.0, 3.0]}
    res = walk_forward(cfg, inst, entry_df, regime_df, grid, exit_grid, train_days=train_days, test_days=test_days)
    for w in res["windows"]:
        console.print(f"{w['train'][0]}..{w['train'][1]} -> {w['test_end']}  params {w['params']} {w['exit']}  "
                      f"train {w['train_sum_r']}R  test {w['test'].get('trades', 0)} trades "
                      f"{w['test'].get('expectancy_r')}R exp, {w['test'].get('sum_r')}R sum")
    console.print("[bold]out-of-sample total:[/]", res["oos"])


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
