import pytest
import yaml

from research.config import AppConfig, load_config


def test_repo_config_loads(repo_root):
    cfg = load_config(repo_root / "config" / "strategies.yaml")
    assert cfg.mode == "shadow"
    assert cfg.enabled_strategies[0].id == "s1_btc_15m"
    assert cfg.strategy_timeframes == ["5m", "15m", "1h", "4h"]  # S3 5m/15m/1h, S1 15m/1h and 1h/4h, S2 15m/1h
    assert cfg.timeframes == ["1m", "5m", "15m", "1h", "4h"]
    assert cfg.chart_timeframes == ["1m"]
    by_id = {s.id: s for s in cfg.strategies}
    assert by_id["s2_btc_15m"].type == "indicator_confluence" and by_id["s2_btc_15m"].exit.max_bars == 24
    assert by_id["s3_btc_5m"].type == "range" and by_id["s3_btc_5m"].range_tf == "15m"
    assert by_id["s3_btc_5m"].exit.trail_atr_k is None and by_id["s3_btc_5m"].exit.tp_ratchet_atr is None
    assert by_id["s1_btc_1h"].params == by_id["s1_btc_15m"].params


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
    raw["strategies"][0]["symbol"] = "NOPEUSDT"
    with pytest.raises(ValueError, match="not in symbols"):
        AppConfig.model_validate(raw)
