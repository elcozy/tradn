import json
from pathlib import Path

import pytest

from research.config import ExitParams
from research.exit_policy import Bar, close_manual, open_position, realized_r, step

FIXTURES = Path(__file__).parent / "fixtures"


def run_case(case: dict) -> dict:
    p = ExitParams(**case["params"])
    pos = open_position(case["entry"], case["qty"], case["sl"], case["tp"], p, tp1=case.get("tp1"))
    for b in case["bars"]:
        step(pos, Bar(**b), p)
    return {
        "state": pos.state,
        "sl": round(pos.sl, 6),
        "tp": round(pos.tp, 6),
        "remaining_qty": pos.remaining_qty,
        "highest_high": pos.highest_high,
        "lowest_low": pos.lowest_low,
        "events": pos.events,
    }


@pytest.mark.parametrize("path", sorted(FIXTURES.glob("exit_policy_case_*.json")), ids=lambda p: p.stem)
def test_fixture(path):
    case = json.loads(path.read_text())
    assert run_case(case) == case["expected"], json.dumps(run_case(case), indent=2)


def test_rejects_bad_geometry():
    p = ExitParams()
    with pytest.raises(ValueError):
        open_position(100, 1, 101, 110, p)
    with pytest.raises(ValueError):
        open_position(100, 1, 95, 99, p)


def test_trailing_never_lowers_stop():
    p = ExitParams(trail_atr_k=1.0)
    pos = open_position(100, 1, 95, 130, p)
    step(pos, Bar(high=106, low=99, close=106, atr=1), p)
    sl_after = pos.sl
    step(pos, Bar(high=106, low=104, close=104, atr=3), p)
    assert pos.sl == sl_after


def test_manual_close_and_realized_r():
    p = ExitParams(fee_pct=0.0)
    pos = open_position(100, 2, 96, 116, p)  # R = 4
    step(pos, Bar(high=104.5, low=100, close=104, atr=1), p)  # tp1 sells 1 @104 -> +1R on half
    close_manual(pos, 106, "regime")  # remaining 1 @106 -> +1.5R on half
    r, fees = realized_r(pos, fee_pct=0.0)
    assert r == pytest.approx(1.25)
    assert fees == 0
    assert pos.state == "closed"


def test_fees_reduce_realized_r():
    p = ExitParams(fee_pct=0.1)
    pos = open_position(100, 1, 99, 110, p)  # R = 1, per_r = 1
    close_manual(pos, 100, "manual")  # flat trade
    r, fees = realized_r(pos, fee_pct=0.1)
    assert r == pytest.approx(-0.2)  # 0.1% in + 0.1% out on notional 100 = 0.2 = 0.2R
    assert fees == pytest.approx(0.2)


def test_mfe_mae():
    p = ExitParams()
    pos = open_position(100, 1, 95, 120, p)  # R=5
    step(pos, Bar(high=110, low=97.5, close=105, atr=1), p)
    assert pos.mfe_r == pytest.approx(2.0)
    assert pos.mae_r == pytest.approx(0.5)
