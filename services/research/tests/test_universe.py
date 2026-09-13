import time

import pytest
import yaml

from research.config import AppConfig, UniverseConfig, load_config
from research.universe import (
    BEGIN_MARK,
    END_MARK,
    Candidate,
    hand_written_symbols_from_text,
    instance_id,
    refresh,
    render_instances,
    rewrite_config,
    scan,
    select,
)

U = UniverseConfig(pinned=["BTCUSDT"], min_volume_usd=10e6, max_spread_pct=0.05, lookback_days=30, max_symbols=4, exclude=["USDC"])


def cand(symbol, vol, spread=0.01, days=30):
    return Candidate(symbol=symbol, base=symbol[:-4], avg_volume_usd=vol, spread_pct=spread, history_days=days)


def test_select_keeps_pinned_and_filters_by_every_bar():
    cs = [
        cand("BTCUSDT", 500e6), cand("ETHUSDT", 300e6), cand("USDCUSDT", 900e6), cand("NEWUSDT", 50e6, days=12),
        cand("WIDEUSDT", 40e6, spread=0.2), cand("THINUSDT", 4e6), cand("PEPEUSDT", 30e6), cand("SUIUSDT", 20e6), cand("TONUSDT", 15e6),
    ]
    sel = select(["BTCUSDT", "C98USDT"], cs, U)
    assert sel.kept == ["BTCUSDT", "C98USDT"]
    assert [c.symbol for c in sel.added] == ["ETHUSDT", "PEPEUSDT"]  # volume order, capped at max_symbols=4 including kept
    reasons = {c.symbol: why for c, why in sel.rejected}
    assert reasons["USDCUSDT"] == "excluded"
    assert "history" in reasons["NEWUSDT"]
    assert "spread" in reasons["WIDEUSDT"]
    assert "volume" in reasons["THINUSDT"]
    assert "max_symbols" in reasons["SUIUSDT"] and "max_symbols" in reasons["TONUSDT"]


def test_render_copies_the_template_per_symbol(repo_root):
    cfg = load_config(repo_root / "config" / "strategies.yaml")
    tpl = next(s for s in cfg.strategies if s.id == "s1_btc_15m")
    text = render_instances(tpl, ["ZZZUSDT", "1000SATSUSDT"])
    assert instance_id(tpl, "1000SATSUSDT") == "s1_1000sats_15m"
    parsed = yaml.safe_load(text)
    assert [p["id"] for p in parsed] == ["s1_zzz_15m", "s1_1000sats_15m"]
    assert parsed[0]["params"] == tpl.params and parsed[0]["exit"]["max_bars"] is None
    # the rendered block validates as part of a full config
    raw = yaml.safe_load((repo_root / "config" / "strategies.yaml").read_text())
    raw["symbols"] += ["ZZZUSDT", "1000SATSUSDT"]
    raw["strategies"] += parsed
    AppConfig.model_validate(raw)


FIXTURE = """mode: shadow
symbols: [BTCUSDT, OLDUSDT]
strategies:
- id: s1_btc_15m
  type: sr_bounce
  symbol: BTCUSDT
  entry_tf: 15m
  regime_tf: 1h
""" + BEGIN_MARK + """
# refreshed yesterday
- id: s1_old_15m
  type: sr_bounce
  symbol: OLDUSDT
  entry_tf: 15m
  regime_tf: 1h
""" + END_MARK + """
regime: {ema_fast: 50}
"""


def test_rewrite_replaces_symbols_line_and_block_only():
    out = rewrite_config(FIXTURE, ["BTCUSDT", "ETHUSDT"], "- id: s1_eth_15m\n  symbol: ETHUSDT", "now")
    assert "symbols: [BTCUSDT, ETHUSDT]" in out
    assert "s1_old_15m" not in out and "s1_eth_15m" in out and "# refreshed now" in out
    assert out.count(BEGIN_MARK) == 1 and out.count(END_MARK) == 1
    assert "regime: {ema_fast: 50}" in out and "- id: s1_btc_15m" in out
    # no markers yet: the block is inserted before regime:
    bare = FIXTURE.split(BEGIN_MARK)[0] + "regime: {ema_fast: 50}\n"
    out2 = rewrite_config(bare, ["BTCUSDT"], "", "now")
    assert out2.index(BEGIN_MARK) < out2.index("regime:")
    assert hand_written_symbols_from_text(FIXTURE) == {"BTCUSDT"}


class FakeMarket:
    rateLimit = 0

    def __init__(self):
        self.now = int(time.time() * 1000)

    def load_markets(self):
        mk = lambda b: {"id": f"{b}USDT", "base": b, "quote": "USDT", "spot": True, "active": True}
        return {f"{b}/USDT": mk(b) for b in ["BTC", "ZZZ", "USDC", "TINY"]} | {"ETH/BTC": {"id": "ETHBTC", "base": "ETH", "quote": "BTC", "spot": True, "active": True}}

    def fetch_tickers(self):
        return {"BTC/USDT": {"quoteVolume": 600e6}, "ZZZ/USDT": {"quoteVolume": 200e6}, "USDC/USDT": {"quoteVolume": 900e6}, "TINY/USDT": {"quoteVolume": 1e6}}

    def publicGetTickerBookTicker(self):
        return [{"symbol": "BTCUSDT", "bidPrice": "100", "askPrice": "100.01"}, {"symbol": "ZZZUSDT", "bidPrice": "10", "askPrice": "10.002"}]

    def publicGetKlines(self, params):
        vol = {"BTCUSDT": 500e6, "ZZZUSDT": 150e6}[params["symbol"]]
        day = 86_400_000
        # 31 candles, the last one still forming
        return [[self.now - (31 - i) * day, "0", "0", "0", "0", "0", self.now - (30 - i) * day - 1, str(vol), 0, "0", "0", "0"] for i in range(31)]


def test_scan_measures_lookback_volume_and_spread():
    cs = {c.symbol: c for c in scan(FakeMarket(), U, sleep=False)}
    assert set(cs) == {"BTCUSDT", "ZZZUSDT"}  # USDC excluded, TINY under the ticker prefilter, ETH/BTC wrong quote
    assert cs["ZZZUSDT"].avg_volume_usd == pytest.approx(150e6)
    assert cs["ZZZUSDT"].history_days == 30
    assert cs["ZZZUSDT"].spread_pct == pytest.approx(0.02, abs=1e-4)


def test_refresh_end_to_end(tmp_path, repo_root):
    src = (repo_root / "config" / "strategies.yaml").read_text()
    p = tmp_path / "strategies.yaml"
    p.write_text(src)
    r = refresh(p, ex=FakeMarket(), sleep=False)
    assert r.new_symbols == ["ZZZUSDT"]
    assert r.symbols[:14] == load_config(p).symbols[:14]  # pinned order preserved
    p.write_text(r.text)
    cfg = load_config(p)  # the rewritten file validates in the strict loader
    assert "ZZZUSDT" in cfg.symbols and any(s.id == "s1_zzz_15m" for s in cfg.strategies)
    # a second refresh with ZZZ gone drops it again, hand-written instances untouched
    class Quiet(FakeMarket):
        def fetch_tickers(self):
            return {"BTC/USDT": {"quoteVolume": 600e6}}
    r2 = refresh(p, ex=Quiet(), sleep=False)
    assert r2.dropped == ["ZZZUSDT"] and r2.new_symbols == []
    p.write_text(r2.text)
    assert load_config(p).symbols == cfg.symbols[:-1]
