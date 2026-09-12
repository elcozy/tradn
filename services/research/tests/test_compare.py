import pandas as pd

from research.compare import match_trades


def live_row(sid, r, close="stop", entry=100.0, risk=10.0, pnl=None):
    return {"signal_id": sid, "strategy_id": "s1", "entry_price": entry, "r_multiple": r, "pnl": r * risk if pnl is None else pnl,
            "close_reason": close, "risk_amount": risk}


def bt_frame(rows):
    return pd.DataFrame(rows, columns=["signal_id", "realized_r", "close_reason", "actual_entry"])


def test_exact_match_and_missing_both_ways():
    live = [live_row("a", -1.0), live_row("b", 1.8, "trailing")]
    bt = bt_frame([("a", -1.0, "stop", 100.0), ("b", 1.8, "trailing", 100.0), ("c", 0.5, "take_profit", 100.0)])
    rep = match_trades(live, bt, r_tol=1e-6)
    assert [m.status for m in rep.matches] == ["ok", "ok"]
    assert rep.missing_live == ["c"]
    assert rep.ok
    rep2 = match_trades([live_row("z", 1.0)], bt, r_tol=1e-6)
    assert rep2.matches[0].status == "missing_in_backtest"


def test_r_tolerance_distinguishes_shadow_from_paper():
    live = [live_row("a", -0.98)]
    bt = bt_frame([("a", -1.0, "stop", 100.05)])
    assert match_trades(live, bt, r_tol=0.05).matches[0].status == "ok"
    assert match_trades(live, bt, r_tol=1e-6).matches[0].status == "r_mismatch"


def test_close_reason_and_pnl_identity():
    bt = bt_frame([("a", -1.0, "stop", 100.0)])
    assert match_trades([live_row("a", -1.0, "regime")], bt, 1e-6).matches[0].status == "close_mismatch"
    bad = live_row("a", -1.0, pnl=-7.0)  # pnl != r * risk
    m = match_trades([bad], bt, 1e-6).matches[0]
    assert m.status == "pnl_mismatch" and not m.pnl_ok
    assert "pnl_mismatch" in match_trades([bad], bt, 1e-6).summary()
