"""Live-vs-backtest comparison (M3 shadow check, M5 paper check).

For every closed position of a mode in a window, run the backtester over the same window with the same
config and match trades by signal id. Shadow fills at the signal close, the backtester at the next open,
so shadow R values differ by the open-close gap; paper fills exactly like the backtester, so paper R must
be equal and its pnl must satisfy pnl == r_multiple * risk_amount (fees are already inside R).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

import pandas as pd
from sqlalchemy import text

from . import db
from .backtest.runner import run_backtest
from .config import AppConfig

# closes that no backtest can reproduce (manual intervention) or that never traded
EXCLUDED_CLOSE_REASONS = {"manual", "kill", "cancelled", "gap_at_fill", "below_minimum", "entries_disabled"}


@dataclass
class TradeMatch:
    signal_id: str
    live_r: float
    bt_r: float | None
    live_close: str
    bt_close: str | None
    live_entry: float
    bt_entry: float | None
    pnl_ok: bool
    status: str  # ok | r_mismatch | close_mismatch | missing_in_backtest | pnl_mismatch


@dataclass
class CompareReport:
    mode: str
    matches: list[TradeMatch] = field(default_factory=list)
    missing_live: list[str] = field(default_factory=list)  # backtest trades with no live position (rejected / engine down)

    @property
    def ok(self) -> bool:
        return all(m.status == "ok" for m in self.matches)

    def summary(self) -> str:
        n = len(self.matches)
        good = sum(m.status == "ok" for m in self.matches)
        lines = [f"[{self.mode}] {good}/{n} positions match the backtest; {len(self.missing_live)} backtest trades had no live position"]
        for m in self.matches:
            if m.status != "ok":
                lines.append(
                    f"  {m.status:20} {m.signal_id}  live {m.live_r:+.3f}R ({m.live_close}) entry {m.live_entry:.8g}"
                    + (f"  bt {m.bt_r:+.3f}R ({m.bt_close}) entry {m.bt_entry:.8g}" if m.bt_r is not None else "")
                )
        return "\n".join(lines)


def match_trades(live: list[dict], bt: pd.DataFrame, r_tol: float, pnl_tol: float = 1e-6) -> CompareReport:
    """Pure matcher. `live` rows: signal_id, r_multiple, pnl, close_reason, entry_price, risk_amount, strategy_id.
    `bt`: the backtester's trade frame (signal_id, realized_r, close_reason, actual_entry)."""
    report = CompareReport(mode="")
    by_id = {} if bt.empty else {t.signal_id: t for t in bt.itertuples(index=False)}
    seen: set[str] = set()
    for row in live:
        sid = row["signal_id"]
        seen.add(sid)
        t = by_id.get(sid)
        pnl_ok = abs(float(row["pnl"]) - float(row["r_multiple"]) * float(row["risk_amount"])) <= pnl_tol * max(1.0, abs(float(row["pnl"])))
        if t is None:
            status = "missing_in_backtest"
        elif not pnl_ok:
            status = "pnl_mismatch"
        elif str(t.close_reason) != str(row["close_reason"]):
            status = "close_mismatch"
        elif abs(float(t.realized_r) - float(row["r_multiple"])) > r_tol:
            status = "r_mismatch"
        else:
            status = "ok"
        report.matches.append(
            TradeMatch(
                signal_id=sid, live_r=float(row["r_multiple"]), bt_r=None if t is None else float(t.realized_r),
                live_close=str(row["close_reason"]), bt_close=None if t is None else str(t.close_reason),
                live_entry=float(row["entry_price"]), bt_entry=None if t is None else float(t.actual_entry),
                pnl_ok=pnl_ok, status=status,
            )
        )
    report.missing_live = [sid for sid in by_id if sid not in seen]
    return report


def load_positions(mode: str, since: datetime | None, until: datetime | None, strategy_id: str | None) -> list[dict]:
    clauses = ["p.mode = :mode", "p.closed_at IS NOT NULL", "p.r_multiple IS NOT NULL"]
    params: dict = {"mode": mode}
    if since is not None:
        clauses.append("p.opened_at >= :since")
        params["since"] = since
    if until is not None:
        clauses.append("p.closed_at < :until")
        params["until"] = until
    if strategy_id:
        clauses.append("p.strategy_id = :sid")
        params["sid"] = strategy_id
    sql = (
        "SELECT p.signal_id, p.strategy_id, p.entry_price, p.r_multiple, p.pnl, p.close_reason, p.opened_at, p.closed_at, "
        "(p.meta->>'risk_amount')::float AS risk_amount, s.ts AS signal_ts "
        "FROM positions p JOIN signals s ON s.id = p.signal_id WHERE " + " AND ".join(clauses) + " ORDER BY p.opened_at"
    )
    with db.engine().connect() as conn:
        rows = [dict(r._mapping) for r in conn.execute(text(sql), params)]
    return [r for r in rows if r["close_reason"] not in EXCLUDED_CLOSE_REASONS]


def compare(cfg: AppConfig, mode: str, since: datetime | None, until: datetime | None, strategy_id: str | None = None,
            r_tol: float | None = None) -> CompareReport:
    """Backtest each strategy instance over the live window and match by signal id."""
    if r_tol is None:
        r_tol = 1e-6 if mode == "paper" else 0.05
    live = load_positions(mode, since, until, strategy_id)
    report = CompareReport(mode=mode)
    if not live:
        return report
    by_strategy: dict[str, list[dict]] = {}
    for r in live:
        by_strategy.setdefault(r["strategy_id"], []).append(r)
    for sid, rows in by_strategy.items():
        if not any(s.id == sid for s in cfg.strategies):
            for r in rows:
                report.matches.append(TradeMatch(r["signal_id"], float(r["r_multiple"]), None, r["close_reason"], None, float(r["entry_price"]), None, True, "missing_in_backtest"))
            continue
        start = min(r["signal_ts"] for r in rows).astimezone(timezone.utc) - timedelta(hours=1)
        end = max(r["closed_at"] for r in rows).astimezone(timezone.utc) + timedelta(days=1)
        result = run_backtest(cfg, sid, since=start, until=end, save=False)
        part = match_trades(rows, result.trades, r_tol)
        report.matches += part.matches
        report.missing_live += part.missing_live
    return report
