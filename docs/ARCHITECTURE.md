# Architecture reference

Diagrams, layout and message shapes referenced from [PLAN.md](PLAN.md). The plan holds the reasoning; this file holds the technical detail.

## System diagram

```
                 ┌──────────────────────────┐
  Binance REST/WS│ Python: services/research │  strategies, indicators,
  (historical +  │  - ingest (klines→DB)     │  backtests, optimisation,
   live klines)──►  - backtest CLI           │  live signal runner
                 │  - signal runner (live)   │
                 └───────┬───────────▲───────┘
                         │ signals   │ candles / outcomes
                         ▼           │
        Redis Streams  ──────────────┼─────────────  Postgres (TimescaleDB)
        (signals, events, commands)  │               candles, signals (journal), orders,
                         │           │               positions, fills, equity, backtests
                         ▼           │
                 ┌───────────────────┴──────┐
                 │ TypeScript: apps/engine   │  risk manager, order manager,
  Binance REST/WS│  - market data (WS)       │  position/trailing state machine,
  (orders, user  │  - execution (paper/test/ │  reconciliation, kill switch,
   data stream)◄─┤    live)                  │  outcome journaling
                 └───────────┬──────────────┘
                             │ HTTP/WS
                 ┌───────────▼──────────────┐
                 │ TypeScript: apps/dashboard│  journal, scorecards, positions,
                 │ + Telegram alerts         │  equity curve, manual overrides
                 └──────────────────────────┘
```

## Runtime flow (shadow mode)

Three local processes (Python signal runner, TypeScript engine, dashboard) plus Postgres and Redis in Docker.

1. A candle closes. Binance pushes the final kline; the engine writes it to `candles`.
2. The signal runner wakes a few seconds after the close, loads recent entry-timeframe and regime-timeframe candles, computes indicators and levels, runs each configured strategy instance.
3. No setup: log "checked, no signal", sleep until the next close.
4. Setup found: write a `signals` row (entry, stop, TP1, TP2, projected R, reasons) and publish it to the `signals` stream.
5. The engine consumes the signal, runs risk checks. Rejected: mark the signal row rejected with the reason. Accepted: create a shadow position at the signal's entry price, emit `position_opened`, send Telegram.
6. On every following candle close the engine steps the exit policy for each open position: stop, TP1, breakeven, trailing, TP2, time stop. Each move is an `engine.events` entry and a Telegram message; `highest_high`, `lowest_low`, `bars_held` update on the position.
7. Position closes: outcome, realised R, exit price, duration, MFE, MAE and close reason are written back to the signal row. Telegram summary line.
8. The dashboard reads the database and the events stream; the chart shows markers, lines and the trailing path as they happen.
9. Daily at 00:00 UTC: Telegram summary of signals, outcomes and running expectancy.
10. Watchdogs: hourly heartbeat, alert if no candle for 3 minutes, reconnect and REST gap fill if the stream drops.

Paper mode adds a simulated wallet at step 5 and 6. Testnet and live replace "create a shadow position" with real orders and OCO protection. Nothing else changes.

## Repo layout (pnpm workspace + uv)

```
trading/
├── docs/                  PLAN.md, ARCHITECTURE.md, CHECKLIST.md, DECISIONS.md
├── apps/engine/           TS live execution engine
├── apps/dashboard/        TS Fastify API + React UI + Telegram bot
├── services/research/     Python ingest, indicators, strategies, backtest, signal runner
├── packages/contracts/    JSON Schema → zod + pydantic codegen
├── infra/                 docker-compose.yml (TimescaleDB, Redis), migrations/*.sql
├── .env.example, package.json, pnpm-workspace.yaml, tsconfig.base.json, README.md
```

## Message contracts (`packages/contracts`, JSON Schema → zod + pydantic)

Producer validates on write, consumer validates on read; an unknown `v` is rejected and logged.

### `signals` stream (Python → engine)

```json
{
  "v": 1,
  "id": "sr_bounce:BTCUSDT:15m:2026-09-12T14:00:00Z",
  "ts": "2026-09-12T14:15:00Z",
  "strategy": "sr_bounce",
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "side": "long",
  "entry": { "type": "market", "price": 61234.5 },
  "stop_price": 60698.0,
  "tp_price": 62500.0,
  "tp1_price": 61770.0,
  "size_hint": 1.0,
  "confidence": 0.7,
  "meta": { "level": 60850.0, "rsi": 38.0, "atr": 210.3, "wick_pct": 0.62 }
}
```

### `engine.events` stream (engine → dashboard / Telegram)

```json
{
  "v": 1,
  "ts": "2026-09-12T14:30:00Z",
  "mode": "shadow",
  "type": "sl_moved",
  "position_id": "pos_01J7",
  "symbol": "BTCUSDT",
  "sl_price": 61300.0,
  "reason": "trailing: highest_high - 2*ATR"
}
```

`type` is one of: `position_opened`, `sl_moved`, `tp_moved`, `tp_partial`, `position_closed`, `order_rejected`, `signal_rejected`, `risk_limit_hit`, `kill_switch`, `paused`, `resumed`, `reconcile_mismatch`, `heartbeat`.

### `engine.commands` stream (dashboard / Telegram → engine)

```json
{
  "v": 1,
  "ts": "2026-09-12T14:31:00Z",
  "source": "telegram",
  "type": "pause",
  "reason": "manual"
}
```

`type` is one of: `close_position`, `close_all`, `pause`, `resume`, `kill`, `move_sl`. `position_id`, `symbol` and `price` are added where the command needs them.

## Strategy config (shape)

One file, `config/strategies.yaml`, read by both Python and TypeScript. Each entry is a strategy instance; the same strategy can appear more than once with different timeframes.

```yaml
mode: shadow            # shadow | paper | testnet | live
symbols: [BTCUSDT]

strategies:
  - id: s1_btc_15m
    type: sr_bounce
    entry_tf: 15m
    regime_tf: 1h
    params:
      swing_width: 5
      level_tolerance_pct: 0.25
      touch_pct: 0.3
      rsi_len: 14
      rsi_max: 45
      wick_min_pct: 50
      min_r: 1.5
      max_risk_pct: 1.5
    exit:
      tp1_r: 1.0
      tp1_fraction: 0.5
      breakeven_r: 1.0
      trail_atr_k: 2.0
      tp_ratchet_atr: 1.0
      max_bars: null

regime:
  ema_fast: 50
  ema_slow: 200
  atr_len: 14
  atr_pct_min: 0.3
  atr_pct_max: 3.0

risk:
  per_trade_pct: 1.0
  daily_loss_pct: 3.0
  max_open: 3
  max_per_symbol: 1
```

## Formulas

- Position size: `qty = (equity × risk_pct) / (entry − stop)`, capped at 25% of equity notional, rounded down to the symbol's step size.
- Projected R: `(tp − entry) / (entry − stop)`.
- Breakeven stop: `entry × (1 + 2 × fee_pct)`.
- Trailing stop: `max(current_sl, highest_high − k × ATR)`, k = 2 by default.
- TP ratchet while trailing: `max(current_tp, highest_high + 1 × ATR)`.
- S1 stop: `min(level × (1 − 0.25%), candle_low − 0.1 × ATR)`.
