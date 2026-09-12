import json

import pytest
from pydantic import ValidationError

from research.contracts import EngineCommand, EngineEvent, Signal

FIX = "packages/contracts/fixtures"


def load(repo_root, name):
    return json.loads((repo_root / FIX / name).read_text())


def test_signal_fixture_validates(repo_root):
    s = Signal.model_validate(load(repo_root, "signal.valid.json"))
    assert s.symbol == "BTCUSDT"
    assert s.exit.trail_atr_k == 2.0


def test_signal_rejects_unknown_version(repo_root):
    raw = load(repo_root, "signal.valid.json")
    raw["v"] = 2
    with pytest.raises(ValidationError):
        Signal.model_validate(raw)


def test_signal_rejects_extra_field(repo_root):
    raw = load(repo_root, "signal.valid.json")
    raw["extra"] = 1
    with pytest.raises(ValidationError):
        Signal.model_validate(raw)


def test_event_and_command_fixtures(repo_root):
    assert EngineEvent.model_validate(load(repo_root, "engine_event.valid.json")).type.value == "sl_moved"
    assert EngineCommand.model_validate(load(repo_root, "engine_command.valid.json")).type.value == "pause"
