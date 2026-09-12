import pytest
import yaml

from research.config import AppConfig, load_config


def test_repo_config_loads(repo_root):
    cfg = load_config(repo_root / "config" / "strategies.yaml")
    assert cfg.mode == "shadow"
    assert cfg.enabled_strategies[0].id == "s1_btc_15m"
    assert cfg.timeframes == ["15m", "1h"]


def test_invalid_timeframe_rejected(repo_root):
    raw = yaml.safe_load((repo_root / "config" / "strategies.yaml").read_text())
    raw["strategies"][0]["entry_tf"] = "7m"
    with pytest.raises(ValueError):
        AppConfig.model_validate(raw)


def test_regime_must_be_slower_than_entry(repo_root):
    raw = yaml.safe_load((repo_root / "config" / "strategies.yaml").read_text())
    raw["strategies"][0]["regime_tf"] = "5m"
    with pytest.raises(ValueError, match="regime_tf"):
        AppConfig.model_validate(raw)


def test_unknown_key_rejected(repo_root):
    raw = yaml.safe_load((repo_root / "config" / "strategies.yaml").read_text())
    raw["risk"]["typo"] = 1
    with pytest.raises(ValueError):
        AppConfig.model_validate(raw)


def test_symbol_must_be_listed(repo_root):
    raw = yaml.safe_load((repo_root / "config" / "strategies.yaml").read_text())
    raw["strategies"][0]["symbol"] = "ETHUSDT"
    with pytest.raises(ValueError, match="not in symbols"):
        AppConfig.model_validate(raw)
