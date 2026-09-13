from datetime import datetime, timezone

import pandas as pd
import pytest

from research.config import load_config
from research.contracts import Signal
from research.live import runner
from research.strategies.base import SignalDraft

from .synth import candles, resample


@pytest.fixture
def cfg(repo_root):
    """Repo config narrowed to one strategy instance, so these tests do not depend on the symbol list."""
    full = load_config(repo_root / "config" / "strategies.yaml")
    first = next(s for s in full.strategies if s.enabled)  # s4_btc_15m since S1/S2/S3 were disabled
    return full.model_copy(update={"strategies": [first], "symbols": [first.symbol]})


def test_signal_id_is_deterministic(cfg):
    inst = cfg.strategies[0]
    t = pd.Timestamp("2026-09-12 14:00", tz="UTC")
    assert runner.signal_id(inst, t) == f"{inst.id}:BTCUSDT:15m:2026-09-12T14:00:00Z" and inst.id == "s4_btc_15m"


def test_build_signal_validates_against_contract(cfg):
    inst = cfg.strategies[0]
    d = SignalDraft(entry=100.0, stop=99.0, tp=103.0, tp1=101.0, invalidation_level=99.2, confidence=0.7, meta={"level": 99.2})
    sig = runner.build_signal(inst, pd.Timestamp("2026-09-12 14:00", tz="UTC"), d)
    assert isinstance(sig, Signal)
    assert sig.ts.isoformat() == "2026-09-12T14:15:00+00:00"  # candle close time
    assert sig.exit.trail_atr_k == inst.exit.trail_atr_k
    assert sig.meta["invalidation_level"] == 99.2
    Signal.model_validate_json(sig.model_dump_json(exclude_none=True))


def test_run_once_evaluates_each_new_candle_only_once(cfg, monkeypatch):
    e = candles(700, "15m", seed=11)
    r = resample(e, "1h")
    monkeypatch.setattr(runner, "load_for", lambda inst, cfg, until=None: (e, r, None))
    published, written = [], []
    seen = {}
    evs = runner.run_once(cfg, seen, publish=published.append, write=lambda s: written.append(s) or True)
    assert len(evs) == 1 and evs[0].candle_time == e.index[-1]
    assert runner.run_once(cfg, seen, publish=published.append, write=lambda s: written.append(s) or True) == []
    assert len(published) == len(written)


def test_run_once_publishes_only_fresh_signals(cfg, monkeypatch):
    e = candles(700, "15m", seed=12)
    r = resample(e, "1h")
    monkeypatch.setattr(runner, "load_for", lambda inst, cfg, until=None: (e, r, None))
    d = SignalDraft(entry=100.0, stop=99.0, tp=103.0, tp1=101.0)
    monkeypatch.setattr(
        runner, "evaluate_instance",
        lambda cfg, inst, ed, rd, gd=None: runner.Evaluation(inst.id, ed.index[-1], runner.build_signal(inst, ed.index[-1], d), "signal"),
    )
    published = []
    runner.run_once(cfg, {}, publish=published.append, write=lambda s: False)  # duplicate in journal
    assert published == []
    runner.run_once(cfg, {}, publish=published.append, write=lambda s: True)
    assert len(published) == 1


def test_next_close_wait(cfg):
    now = datetime(2026, 9, 12, 14, 7, 30, tzinfo=timezone.utc)
    assert runner.next_close_wait(cfg, now) == pytest.approx(7 * 60 + 30 + 5)
