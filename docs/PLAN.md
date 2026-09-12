# Crypto Day-Trading Automation Tool — Plan

## Context

You used to day-trade crypto manually (support/resistance, indicator confluence, range trading) but work keeps you off the charts. The goal is a locally-run tool that:

1. **Records** every decision: each signal with its projected entry / SL / TP / R and the "why", and later the real outcome (win/loss, realised R, duration, how far it went for and against you). This journal is how you judge what works.
2. **Automates** your style: buy at "low" (support / oversold / bottom of range), exit at a breakpoint with SL and TP, and **trail** both upward as price moves in your favour. The bot runs the trades; you supervise from a dashboard and Telegram.
3. Starts on **Binance spot**, designed so futures/perps can be added later.
4. Uses **both languages**: Python for research, backtesting and signal generation; TypeScript/Node for live execution, dashboard and alerts. They share Postgres and Redis with a versioned JSON contract.

Decisions made so far: Binance; spot first then futures; default 5m/15m entries with a 1h trend filter, all timeframes configurable per strategy; 1% risk per trade, 3% max daily loss; **the first running version places no orders at all** (shadow mode: it records buy points, projected sell points and what happened next, with a dashboard and Telegram notifications).

### Run modes

The engine has one `MODE` setting that gates everything else:

- **shadow** (first): no exchange keys, no orders. Every signal is written to the journal with its projected entry, stop, targets and reasons. The engine then follows live candles with the same exit policy it will use later and marks the hypothetical outcome (would have hit TP1, stopped out, trailed to X, took N hours). Telegram sends a message at each of those points. This is the "is the bot seeing what I would have seen?" phase.
- **paper**: same as shadow plus a simulated wallet, fees and slippage, so equity curves and sizing are exercised.
- **testnet**: real orders against Binance testnet.
- **live**: real money, small capital, hard limits.

Shadow and paper share the same code path; paper only adds the simulated wallet. Nothing above shadow is built until the shadow journal has been reviewed for at least two weeks.

Honest framing: no bot is guaranteed profitable. The pipeline (backtest with fees → walk-forward → shadow → paper → testnet → small live) plus hard risk limits is the real product. Strategies are plugins that must earn their place with data.

---

## Documents in the repo

- `docs/PLAN.md` — this document: goals, decisions, strategy rules, phases.
- `docs/ARCHITECTURE.md` — diagrams, repo tree, runtime flow, message payloads and formulas (all code-like detail lives there).
- `docs/PLAN_BUILD.md` — the full flow of work, milestone by milestone, with done criteria and no timelines.
- `docs/CHECKLIST.md` — the step-by-step checklist, ticked as we go. Every session starts by reading it.
- `docs/DECISIONS.md` — one line per decision with date and reason (e.g. "2026-09-12 spot first: no liquidation risk while learning the bot").

---

## Architecture

Three services and two shared stores. The diagram, repo tree and message shapes are in [ARCHITECTURE.md](ARCHITECTURE.md).

- **Python research service**: ingests Binance klines into Postgres, runs indicators, strategies and backtests, and in live mode evaluates each closed candle and publishes signals to Redis.
- **TypeScript engine**: streams live candles, consumes signals, applies risk limits, follows each signal with the exit policy and, depending on the run mode, either only records what would have happened (shadow) or places and trails orders through a paper, testnet or live adapter. It writes positions, orders and outcomes back to Postgres.
- **TypeScript dashboard and Telegram bot**: read-only views over the database plus manual overrides sent to the engine as commands.
- **Postgres (TimescaleDB)** holds candles, the signal journal, positions, orders, fills, equity and backtest results. **Redis Streams** carry signals, engine events and commands.

Python owns anything that needs pandas or vectorised backtesting. Node owns anything long-running with websockets and order state. They never call each other's code; they only agree on database tables and JSON messages.

### Repo layout

A pnpm workspace for the TypeScript apps and a uv project for Python: engine and dashboard under `apps/`, the research service under `services/`, shared contracts under `packages/`, Docker Compose and SQL migrations under `infra/`, and these documents under `docs/`. Full tree in [ARCHITECTURE.md](ARCHITECTURE.md).

### Tools, libraries, APIs

| Layer             | Choice                                                                                                                                                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Binance access    | `ccxt` in both languages (REST); raw `ws` for kline stream and user data stream                                                                                                                                                                    |
| Python            | `pandas`, `numpy`, `pydantic`, `sqlalchemy` + `psycopg`, `redis`, `typer`; `vectorbt` for sweeps, own event-driven backtester for the exit policy; `optuna` for walk-forward optimisation; `uv`, `ruff`, `pytest`                                  |
| TypeScript        | `zod`, `postgres` (porsager) or `drizzle-orm`, `ioredis`, `decimal.js` (never floats for qty/price), `pino`, `grammy` (Telegram), `fastify` + `react` + `vite`, `lightweight-charts` (candles + overlays) and `recharts` (equity, histograms); `vitest`, `tsx`, `pnpm`                                               |
| Infra             | Docker Compose: `timescale/timescaledb`, `redis:7`; SQL migrations run by `research migrate` (small runner, no dbmate)                                                                                                                             |
| Binance endpoints | klines `GET /api/v3/klines`; kline WS `wss://stream.binance.com:9443/stream`; OCO `POST /api/v3/orderList/oco`; user data stream via listenKey; spot testnet `https://testnet.binance.vision`; futures testnet `https://testnet.binancefuture.com` |
| Keys              | withdrawals disabled, IP-restricted, separate testnet and live keys, never committed                                                                                                                                                               |

Environment notes (checked on this Mac): Python 3.10.2, Node 20.19.4 and 22.14.0 via nvm, Docker running, `uv` installed via brew. The `pnpm` on PATH is a corepack shim for pnpm 11 that crashes on Node 20; Phase 0 must `nvm use 22` or `npm i -g pnpm@9` first.

---

## Strategy rules in detail

All prices/indicators computed on **closed** candles only. Timeframes are **configuration, not code**: each strategy has an `entry_tf` and a `regime_tf` (plus S3's `range_tf`) in a strategy config file, and the same strategy can run several instances with different timeframes side by side (each instance gets its own journal rows and scorecard). Defaults below are 15m entries with a 1h regime filter (S3: 5m entries, 15m range, 1h regime). Changing a timeframe must require no code change, only a config edit and restart; supported values are 1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 1d. Indicator periods (RSI length, ATR length, EMA lengths, swing width) are config too, with the defaults stated in each strategy.

### Shared regime filter (1h)

- **Trend OK**: 1h EMA(50) > EMA(200) and 1h close > EMA(50). (Long-only on spot.)
- **Volatility OK**: 1h ATR(14) / close between 0.3% and 3%. Too quiet = fees eat you; too wild = stops get hunted.
- **No-trade windows** (config): first 15 min after 00:00 UTC daily open, and a manual "news" toggle from Telegram.

### S1 — Support/resistance bounce (15m) — the MVP strategy

1. **Levels** from 1h swing points: a swing low is a bar whose low is the lowest of 5 bars either side (confirmed 5 bars later, so no look-ahead). Cluster swings within 0.25% into one level. Keep levels touched ≥ 2 times in the last 30 days, drop levels broken by a 1h close 0.5% below.
2. **Entry** when a 15m candle: (a) low comes within 0.3% of a support level, (b) closes bullish above the level, (c) lower wick ≥ 50% of the candle range (rejection), (d) 15m RSI(14) < 45.
3. **Stop**: the lower of 0.25% below the level and a tenth of an ATR below the candle low. If the resulting risk is more than 1.5% of price, skip (level too far).
4. **Target**: next resistance level above. Require projected R ≥ 1.5 else skip. TP1 at +1R (sell 50%).
5. **Invalidation**: a 1h close below the level closes the remainder at market (regime exit).

Worked example (BTC 15m): support 60,850; candle low 60,900, close 61,234, wick 62% of range, RSI 38 → entry ≈ 61,234 (market). SL = min(60,698, 60,900 − 21) = 60,698 → risk 536 (0.88%). Next resistance 62,500 → R = 2.36 ✓. TP1 = 61,770. Size = (equity × 1%) / 536.

### S2 — Indicator confluence (15m)

1. Regime filter passes.
2. **Entry** when all in the same or the previous 3 bars: RSI(14) crosses back **up** through 30; close touched or went below lower Bollinger(20, 2); MACD histogram rising (hist[i] > hist[i−1]).
3. **Stop**: entry − 1.5 × ATR(14). **Target**: entry + 2 × risk (R = 2). TP1 at +1R.
4. **Time stop**: 24 bars (6h) if breakeven not reached.

### S3 — Range / grid (5m entries, 15m range)

1. **Ranging regime**: 1h ADX(14) < 20 and 1h Bollinger width in the bottom 40% of its 30-day distribution. Trend filter is _not_ required (ranges happen in chop).
2. **Range**: highest high / lowest low of the last 48 × 15m bars (12h). Require range height ≥ 3 × ATR15m so there is room after fees.
3. **Entry**: 5m close in the bottom 20% of the range and bullish (close > open). One entry per range touch; optional ladder of up to 3 entries 0.5 × ATR apart (config).
4. **Stop**: range low − 0.5 × ATR. **TP1**: range midpoint (sell 50%). **TP2**: top 20% of range. Trailing off by default (mean reversion), configurable `trail_atr_k`.
5. **Exit** remainder at market if 1h ADX rises above 25 (range breaking).

### Shared exit policy (the SL/TP + trailing)

State machine per position, evaluated on each closed candle; hard SL checked against the bar's low, worst-case ordering (stop before TP in the same bar).

| State     | Rule                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| open      | initial SL/TP from the strategy; TP1 at +1R                                                                                           |
| breakeven | when close ≥ entry + 1R → SL = entry + round-trip fees                                                                                |
| trailing  | after TP1 fills → SL = max(SL, highest_high − k × ATR), k = 2 default; TP ratchets to highest_high + 1 × ATR so runners aren't capped |
| closed    | via stop, TP, time stop, regime invalidation, manual, or kill                                                                         |

Reference implementation in Python; identical port in TypeScript; both run the same JSON fixtures in CI (this is the key cross-language test).

### Position sizing & portfolio limits

- Quantity = 1% of equity divided by the distance from entry to stop, capped at 25% of equity notional, rounded **down** to the symbol's step size; skip if below the exchange's minimum quantity or notional. Formula in [ARCHITECTURE.md](ARCHITECTURE.md).
- Max 3 open positions, max 1 per symbol, daily loss ≥ 3% → pause until next UTC day, 3 consecutive losses → 2h cooldown. Every rejection is journaled with its reason.

---

## Order handling on Binance spot

1. **Entry**: market buy (S1/S2) or limit at signal price with a 2-candle TTL (S3). Idempotent `newClientOrderId = signal_id` so a retry never double-buys.
2. **Fill accounting** from the user data stream `executionReport`: `actual_entry` = quote spent / base received. If the fee asset is the base coin (no BNB discount) the **sellable qty = filled − fee**; if fees are in BNB the full qty is sellable. Get this wrong and every OCO is rejected for insufficient balance.
3. **Protection** placed immediately after fill, as **two OCO sell orders** (Binance OCO cannot do partial TPs, but two OCOs on half the qty each are allowed):
    - OCO-A: 50% qty, limit (TP1), stop = SL, stopLimit = SL × (1 − 0.2%)
    - OCO-B: 50% qty, limit (TP2), stop = SL, stopLimit = SL × (1 − 0.2%)
      Binance rule for a sell OCO: limit price > current price > stop price; if the market has already moved past that, fall back to a plain stop-loss-limit + separate TP limit and alert.
4. **Trailing / breakeven updates** once per candle close: if new SL > old SL by at least 1 tick and 0.05%: cancel OCO-B (`orderListId`), confirm cancelled, **re-check fills** (price may have hit during the gap), then place the new OCO-B with the new SL and ratcheted TP. Never more than one replace per candle per position.
5. **Invariant**: no open position without an exchange-side stop. If OCO placement fails 3 times → market-sell the remainder and alert. Reconciliation on start and every 5 min: `fetchOpenOrders` + `fetchBalance` vs DB; a DB position with no exchange stop is re-protected immediately; unknown open orders raise an alert and pause new entries.
6. **Precision**: from `exchangeInfo` filters `PRICE_FILTER.tickSize`, `LOT_SIZE.stepSize/minQty`, `NOTIONAL.minNotional`, `PERCENT_PRICE_BY_SIDE`. Prices rounded to tick, quantities rounded down to step, all with `decimal.js`.
7. **Streams**: kline WS (public), user data stream (listenKey, keep-alive every 30 min, reconnect before the 24h cut). Poll `fetchOrder` every 60s as a fallback for missed fills.
8. **Rate limits**: 6000 request weight per minute per IP (klines cost 2, most order calls 1), 50 orders per 10 seconds, 160k orders per day. WebSocket: 1024 streams per connection, 300 connections per 5 minutes, forced disconnect every 24h with a ping every 20s. Our load is a handful of calls per hour; log the `X-MBX-USED-WEIGHT` header anyway, back off on HTTP 429, and treat 418 as a ban.
9. **Reconnect gap fill**: after every WebSocket reconnect, fetch the missed candles over REST before evaluating strategies, so a dropped connection never produces a missing or partial candle in the journal.
10. **Paper adapter**: fills a market order at the next candle open + 0.05% slippage, fee 0.1%; simulates OCOs against candle high/low with the same worst-case ordering as the backtester. Paper and backtest must agree on the same candles.
11. **Testnet** (`testnet.binance.vision`): supports OCO and user data stream; liquidity is thin so expect odd fills. Used to validate the mechanics, not the strategy.
12. **Futures later**: same adapter interface; `STOP_MARKET` + `TAKE_PROFIT_MARKET` with `reduceOnly`, optional exchange-native `TRAILING_STOP_MARKET`, leverage cap, liquidation-distance check.

---

## Data & dashboard schema

### Tables (Postgres / TimescaleDB, one `mode` column = shadow | paper | testnet | live on every row the engine writes)

- `candles(symbol, timeframe, open_time, open, high, low, close, volume, closed)` — hypertable. Python writes history, TS writes live.
- `signals` — **the journal**, one row per strategy decision:
    - projection (Python): `id` (deterministic: strategy:symbol:tf:candle_time), `ts, strategy, symbol, timeframe, side, entry_type, entry_price, stop_price, tp_price, tp1_price, projected_r, confidence, meta` (indicator snapshot / level / reasons)
    - outcome (TS, written on reject or close): `outcome` (win | loss | breakeven | rejected | expired), `reject_reason, position_id, actual_entry, slippage_pct, exit_price, realized_r, realized_pnl, fees, mfe_r, mae_r, bars_held, duration_s, close_reason, closed_at`
- `positions(id, mode, signal_id, symbol, strategy, side, entry_price, qty, remaining_qty, sl_price, tp_price, tp1_price, tp1_done, highest_high, lowest_low, bars_held, state, opened_at, closed_at, close_reason, pnl, r_multiple, meta)`
- `orders(id, mode, exchange_order_id, order_list_id, position_id, symbol, type, side, price, stop_price, qty, status, created_at, updated_at, raw)`
- `fills(id, order_id, price, qty, fee, fee_asset, ts)`
- `equity_snapshots(ts, mode, balance_quote, unrealised, drawdown_pct)` — hourly + on every close
- `backtest_runs(id, strategy, symbol, timeframe, params, from_ts, to_ts, metrics, created_at)` + `backtest_trades(run_id, …same columns as a closed signal…)` so backtest and live trades are compared with the same queries
- `risk_events(id, ts, env, type, detail)` — pauses, kill switches, reconciliation mismatches
- `schema_migrations(name, applied_at)`

### SQL views for the dashboard

- `v_strategy_scorecard`: per strategy × symbol × mode: trades, win rate, expectancy (avg R), profit factor, avg MFE of losers, avg MAE of winners, median time to TP1, max drawdown.
- `v_open_positions`: with live unrealised R and distance to SL/TP.
- `v_daily_pnl`: per mode per UTC day.
- `v_rejected_would_have_won`: rejected signals whose TP would have been hit before SL on subsequent candles (computed by a nightly Python job).

### Dashboard pages

1. **Chart** — a candlestick chart drawn from our own candles table (TradingView Lightweight Charts, open source), updating live over the dashboard WebSocket. Overlays: a marker on every candle where a signal fired (hover shows the reason), entry / stop / TP1 / TP2 lines for signals in flight, the trailing-stop path as it moved, and the support and resistance levels the strategy detected. Symbol and timeframe selectable from the configured set. A link opens the same symbol on TradingView for manual analysis; Binance itself cannot be embedded because it blocks iframes.
2. **Overview** — equity curve, today's PnL vs the 3% limit, open positions with SL/TP lines, engine status (mode, paused?, last candle, last heartbeat).
3. **Journal** — every signal, filterable by strategy/symbol/outcome, expandable "why" panel with indicator snapshot and a mini-chart of the trade (same chart component, zoomed to the trade).
4. **Scorecard** — the view above as a table plus R-distribution histogram per strategy.
5. **Backtests** — runs list, metrics, equity curves, side-by-side with live results for the same window; backtest trades can be replayed on the Chart page.
6. **Controls** — pause / resume / close position / close all / kill; also available as Telegram commands `/status /pause /resume /close SYMBOL /kill`.

### Message contracts

Three Redis streams, each with a versioned JSON Schema in `packages/contracts` from which zod and pydantic models are generated: **signals** (Python to engine), **engine events** (engine to dashboard and Telegram) and **engine commands** (dashboard and Telegram to engine). The producer validates on write, the consumer validates on read, and an unknown version is rejected and logged. Example payloads and the full list of event and command types are in [ARCHITECTURE.md](ARCHITECTURE.md).

---

## MVP scope and phase order

**MVP = shadow mode: one strategy (S1) on one symbol (BTCUSDT), no orders, every buy point and projected sell point marked in the database and followed to its outcome, viewed on a dashboard and pushed to Telegram.** Execution (paper wallet, testnet, live) comes only after the shadow journal has been reviewed for at least two weeks.

| Milestone | Deliverable | Done when |
| --- | --- | --- |
| M0 Scaffold | repo layout, docker compose, migrations, contracts codegen, strategy config file, CI lint/test | tests green on an empty project |
| M1 Data | historical ingest for the configured symbol and timeframes; engine streams live candles into the same table | Python and TS read the same row for the same candle time |
| M2 Backtest | exit policy (Python + TS, shared fixtures), S1 strategy, event-driven backtester with fees and slippage, metrics, walk-forward split, results stored | S1 beats buy-and-hold and random-entry baselines out-of-sample after fees, or we iterate on S1 first |
| M3 Shadow live | signal runner writes signals and publishes them; engine in shadow mode follows each signal on live candles with the exit policy and marks the hypothetical outcome; Telegram notification at signal, TP1, stop, trailing moves and close | two weeks of shadow signals; shadow outcomes match a backtest over the same window |
| M4 Dashboard v1 | Overview, Journal, Scorecard pages over the shadow journal; pause/resume via Telegram | you can review a week of signals without opening a terminal |
| M5 Paper wallet | simulated balance, fees, slippage, sizing, equity snapshots, daily-loss pause | paper equity curve reproduces the shadow journal's R values |
| M6 Testnet | Binance spot adapter, two-OCO protection, cancel/replace, user data stream, reconciliation | kill the engine mid-position, confirm exchange stop survives, restart re-adopts it |
| M7 Live small | live keys, small capital, 1%/3% limits enforced | one month live with journal reviewed weekly |
| M8 More strategies | S2, S3, extra timeframe instances, parameter optimisation, rejected-would-have-won job, Backtests and Controls pages | each strategy instance has its own scorecard |
| M9 Futures | futures adapter, shorts, leverage cap, liquidation check | strategy and exit code unchanged |

---

## Verification

- **Unit**: exit policy fixtures produce identical event streams in Python and TS; position sizing; precision rounding; contract validation both sides.
- **Backtest sanity**: baselines (buy-and-hold, random entry with same exit policy) reproducible; strategy must beat both out-of-sample after fees.
- **Integration (shadow)**: start infra → ingest → backtest → run the signal runner and engine in shadow mode → a signal appears in the journal, is followed on live candles, closes with an outcome; Telegram messages received at each step.
- **Integration (paper and up)**: same flow with a position opening, trailing and closing against the wallet or exchange.
- **Testnet**: place / cancel / replace OCO; engine killed mid-position keeps exchange stop; restart reconciles.
- **Ops**: engine under `pm2` or launchd; hourly heartbeat; alert if no candle for 3 minutes or no heartbeat for 10.

## Risks / open decisions

- Overfitting: walk-forward + paper period; never tune on the validation window.
- Laptop uptime (sleep, wifi): exchange-side OCO protects open positions; a small VPS is an option after M6.
- Spot is long-only until M8.
- Two-OCO protection doubles order count; if Binance rejects for balance rounding, fall back to one OCO at TP2 and a bot-managed TP1.

---

## Decisions and checklist

- Decisions log: [DECISIONS.md](DECISIONS.md)
- Step-by-step checklist: [CHECKLIST.md](CHECKLIST.md)
