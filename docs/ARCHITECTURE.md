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
  "env": "paper",
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

## Formulas

- Position size: `qty = (equity × risk_pct) / (entry − stop)`, capped at 25% of equity notional, rounded down to the symbol's step size.
- Projected R: `(tp − entry) / (entry − stop)`.
- Breakeven stop: `entry × (1 + 2 × fee_pct)`.
- Trailing stop: `max(current_sl, highest_high − k × ATR)`, k = 2 by default.
- TP ratchet while trailing: `max(current_tp, highest_high + 1 × ATR)`.
- S1 stop: `min(level × (1 − 0.25%), candle_low − 0.1 × ATR)`.
