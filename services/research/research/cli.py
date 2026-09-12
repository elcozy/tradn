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
