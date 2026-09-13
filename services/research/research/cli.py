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
    symbol: str = typer.Option(None, help="Override: comma-separated symbols (default: all from config)"),
    tf: str = typer.Option(None, help="Override: comma-separated timeframes (default: all from config)"),
    since: datetime = typer.Option(None, help="ISO date to start from; also backfills before the earliest stored candle"),
) -> None:
    """Fetch historical klines into the candles table (fills backwards to `since` and forwards to now)."""
    from datetime import timedelta, timezone

    from .config import load_config
    from .ingest import ingest as run_ingest
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    symbols = [s.strip().upper() for s in symbol.split(",")] if symbol else cfg.symbols
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
    symbol: str = typer.Option(None, help="Run the instance on another symbol, a comma list, or 'all' (every configured symbol)"),
) -> None:
    """Run the event-driven backtest for one strategy instance (or one instance across many symbols)."""
    from .backtest.runner import pooled_summary, run_backtest
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    symbols = _symbols(cfg, symbol)
    if symbols is None:
        console.print(run_backtest(cfg, strategy_id, since=since, until=until, save=save).summary())
        return
    results = {}
    for s in symbols:
        try:
            results[s] = run_backtest(cfg, strategy_id, since=since, until=until, save=save, symbol=s)
        except RuntimeError as exc:
            console.print(f"[yellow]{s}: {exc}[/]")
            continue
        m = results[s].metrics
        console.print(f"{s:10} trades {m.get('trades', 0):4d}  win {m.get('win_rate') or 0:.0%}  exp {m.get('expectancy_r') or 0:+.3f}R  "
                      f"sum {m.get('sum_r') or 0:+.1f}R  max DD {m.get('max_drawdown_r') or 0}R  avg bars {m.get('avg_bars_held') or 0}")
    _, pooled = pooled_summary(results)
    console.print(f"[bold]pooled ({len(results)} symbols):[/] trades {pooled.get('trades', 0)}  win {pooled.get('win_rate') or 0:.0%}  "
                  f"exp {pooled.get('expectancy_r') or 0:+.3f}R  sum {pooled.get('sum_r') or 0:+.1f}R  max DD {pooled.get('max_drawdown_r')}R  "
                  f"profit factor {pooled.get('profit_factor')}  close reasons {pooled.get('close_reasons')}")


def _symbols(cfg, symbol: str | None) -> list[str] | None:
    """None: the instance's own symbol. 'all': every configured symbol. Otherwise a comma list."""
    if not symbol:
        return None
    if symbol.lower() == "all":
        return list(cfg.symbols)
    return [s.strip().upper() for s in symbol.split(",") if s.strip()]


def _instance_and_frames(strategy_id: str, since: datetime | None, symbol: str | None = None):
    """Config, instance and (entry, regime, range) candle frames for the walk-forward style commands."""
    from .backtest.runner import instance_for, load_frames
    from .config import load_config
    from .settings import settings

    cfg = load_config(settings.strategy_config_path)
    try:
        inst = instance_for(cfg, strategy_id, symbol)
    except ValueError as exc:
        raise typer.BadParameter(str(exc)) from exc
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
    symbol: str = typer.Option(None, help="Run the instance on another symbol, a comma list, or 'all' (every configured symbol)"),
) -> None:
    """Rolling walk-forward over the strategy's small parameter grid; prints out-of-sample metrics only."""
    import pandas as pd

    from .backtest.metrics import compute_metrics
    from .backtest.walkforward import walk_forward
    from .config import load_config
    from .settings import settings
    from .strategies.base import strategy_class

    symbols = _symbols(load_config(settings.strategy_config_path), symbol)
    oos_frames = []
    for sym in symbols or [None]:
        cfg, inst, (entry_df, regime_df, range_df) = _instance_and_frames(strategy_id, since, sym)
        if entry_df.empty or regime_df.empty:
            console.print(f"[yellow]{sym}: no candles[/]")
            continue
        cls = strategy_class(inst.type)
        res = walk_forward(cfg, inst, entry_df, regime_df, cls.WALK_FORWARD_GRID, cls.WALK_FORWARD_EXIT_GRID,
                           train_days=train_days, test_days=test_days, range_df=range_df)
        if symbols is None:
            _print_windows(res)
            return
        m = res["oos"]
        console.print(f"{sym:10} OOS trades {m.get('trades', 0):4d}  win {m.get('win_rate') or 0:.0%}  exp {m.get('expectancy_r') or 0:+.3f}R  "
                      f"sum {m.get('sum_r') or 0:+.1f}R  max DD {m.get('max_drawdown_r') or 0}R  "
                      f"picked {[w['params'] for w in res['windows'][-3:]]}")
        if not res["oos_trades"].empty:
            oos_frames.append(res["oos_trades"])
    pooled = compute_metrics(pd.concat(oos_frames), 0, 0, 1) if oos_frames else {"trades": 0}
    console.print(f"[bold]pooled out-of-sample ({len(oos_frames)} symbols with trades):[/] trades {pooled.get('trades', 0)}  "
                  f"win {pooled.get('win_rate') or 0:.0%}  exp {pooled.get('expectancy_r') or 0:+.3f}R  sum {pooled.get('sum_r') or 0:+.1f}R  "
                  f"max DD {pooled.get('max_drawdown_r')}R  profit factor {pooled.get('profit_factor')}")


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
def universe(
    apply: bool = typer.Option(False, help="Write the new symbols line and UNIVERSE block into the config"),
    ingest: bool = typer.Option(False, help="After --apply, backfill candles for newly added symbols"),
    since: datetime = typer.Option("2021-04-01", help="History start for the backfill of new symbols"),
) -> None:
    """Refresh the liquidity-filtered symbol universe (pinned coins + every pair above the volume/spread bar)."""
    from datetime import timedelta, timezone
    from pathlib import Path

    from .settings import settings
    from .universe import refresh, report

    path = Path(settings.strategy_config_path)
    r = refresh(path)
    cfg = load_config_for_report(path)
    report(r, cfg.universe)  # type: ignore[arg-type]  # refresh() raised already if there is no universe block
    if not apply:
        console.print("[dim]dry run; add --apply to write the config[/]")
        return
    path.write_text(r.text, encoding="utf-8")
    console.print(f"[green]wrote {path}[/]: {len(r.symbols)} symbols, {len(r.new_symbols)} new, {len(r.dropped)} dropped")
    if ingest and r.new_symbols:
        from .ingest import ingest as run_ingest

        cfg = load_config_for_report(path)
        u = cfg.universe
        template = next(s for s in cfg.strategies if s.id == u.template)  # type: ignore[union-attr]
        # full history for the timeframes the new instance trades on; other strategy timeframes get the
        # ingest default lookback (a year); chart-only timeframes the chart lookback
        deep = {template.entry_tf, template.regime_tf, template.range_tf} - {None}
        chart_only = set(cfg.chart_timeframes) - set(cfg.strategy_timeframes)
        for s in r.new_symbols:
            for t in cfg.timeframes:
                if t in chart_only:
                    start = datetime.now(timezone.utc) - timedelta(days=cfg.chart_lookback_days)
                else:
                    start = since if t in deep else None
                n = run_ingest(s, t, since=start)
                console.print(f"[green]{s} {t}: wrote {n} candles[/]")
    console.print("[bold]restart the engine, signal runner and dashboard to pick up the new symbols[/]")


def load_config_for_report(path):
    from .config import load_config

    return load_config(path)


@app.command()
def label(
    tf: str = typer.Option("15m", help="Entry timeframe to label"),
    symbol: str = typer.Option(None, help="Comma-separated symbols (default: all from config)"),
    side: str = typer.Option("both", help="long | short | both"),
    stop_atr: float = typer.Option(1.0),
    target_atr: float = typer.Option(2.0),
    max_bars: int = typer.Option(24, help="Time limit in bars"),
    since: datetime = typer.Option(None),
    out: str = typer.Option("data/research", help="Parquet output directory (relative to the repo root)"),
) -> None:
    """Hindsight-label every bar (triple barrier) and snapshot its features; one parquet per symbol and side."""
    from pathlib import Path

    from . import db
    from .config import load_config
    from .features import features
    from .labels import LabelParams
    from .labels import label as label_bars
    from .settings import REPO_ROOT, settings

    cfg = load_config(settings.strategy_config_path)
    symbols = [s.strip().upper() for s in symbol.split(",")] if symbol else cfg.symbols
    sides = ["long", "short"] if side == "both" else [side]
    out_dir = REPO_ROOT / out
    out_dir.mkdir(parents=True, exist_ok=True)
    btc_h1 = db.load_candles("BTCUSDT", "1h", since=since)
    for s in symbols:
        entry = db.load_candles(s, tf, since=since)
        if len(entry) < 500:
            console.print(f"[yellow]{s}: only {len(entry)} {tf} candles, skipped[/]")
            continue
        h1, h4, d1 = (db.load_candles(s, x, since=since) for x in ("1h", "4h", "1d"))
        feats = features(entry, tf, h1=h1, h4=h4, d1=d1, btc_h1=btc_h1 if s != "BTCUSDT" else None)
        for sd in sides:
            p = LabelParams(side=sd, stop_atr=stop_atr, target_atr=target_atr, max_bars=max_bars)
            lab = label_bars(entry, p)
            joined = lab.join(feats, how="inner")
            joined.insert(0, "symbol", s)
            path = Path(out_dir) / f"{s}_{tf}_{p.tag}.parquet"
            joined.to_parquet(path)
            console.print(f"[green]{s} {tf} {sd}[/]: {len(joined):,} bars, exp {joined['realized_r'].mean():+.3f}R -> {path.name}")


@app.command()
def explain(
    tf: str = typer.Option("15m"),
    side: str = typer.Option("long", help="long | short"),
    stop_atr: float = typer.Option(1.0),
    target_atr: float = typer.Option(2.0),
    max_bars: int = typer.Option(24),
    min_n: int = typer.Option(3000, help="Minimum bars in a bucket before it is reported"),
    data: str = typer.Option("data/research"),
    out: str = typer.Option("docs/research", help="Report directory (relative to the repo root)"),
) -> None:
    """Rank the conditions that preceded good trades, from the parquet files written by `research label`."""
    import pandas as pd

    from .explain import report
    from .labels import LabelParams
    from .settings import REPO_ROOT

    p = LabelParams(side=side, stop_atr=stop_atr, target_atr=target_atr, max_bars=max_bars)
    files = sorted((REPO_ROOT / data).glob(f"*_{tf}_{p.tag}.parquet"))
    if not files:
        raise typer.BadParameter(f"no label files for {tf} {p.tag} in {data}; run `research label` first")
    df = pd.concat([pd.read_parquet(f) for f in files])
    console.print(f"{len(df):,} labelled bars from {len(files)} files")
    path = report(df, side, tf, p.tag, min_n, REPO_ROOT / out)
    console.print(f"[green]report -> {path}[/]")


@app.command()
def forward(
    tf: str = typer.Option("15m"),
    side: str = typer.Option("long", help="long | short"),
    stop_atr: float = typer.Option(1.0),
    target_atr: float = typer.Option(2.0),
    max_bars: int = typer.Option(24),
    test_from: str = typer.Option("2024-01-01", help="First day of the out-of-sample years"),
    min_n: int = typer.Option(3000, help="Minimum training bars in a bucket before it becomes a rule"),
    data: str = typer.Option("data/research"),
    out: str = typer.Option("docs/research"),
) -> None:
    """Step 3: mine rules on the training years, score them (and a model ceiling) on the test years."""
    import pandas as pd

    from .forward import report, run
    from .labels import LabelParams
    from .settings import REPO_ROOT

    p = LabelParams(side=side, stop_atr=stop_atr, target_atr=target_atr, max_bars=max_bars)
    files = sorted((REPO_ROOT / data).glob(f"*_{tf}_{p.tag}.parquet"))
    if not files:
        raise typer.BadParameter(f"no label files for {tf} {p.tag} in {data}; run `research label` first")
    df = pd.concat([pd.read_parquet(f) for f in files])
    console.print(f"{len(df):,} labelled bars from {len(files)} files; fitting…")
    res = run(df, tf, test_from, min_n)
    path = report(res, side, tf, p.tag, test_from, REPO_ROOT / out)
    passing = [s for s in res.rules + res.model if s.passes]
    robust = [s for s in passing if s.robust]
    verdict = f"[bold green]{len(passing)} PASS, {len(robust)} ROBUST[/]" if passing else "[yellow]nothing passes[/]"
    console.print(f"[green]report -> {path}[/]  {verdict}")


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
