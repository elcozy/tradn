# Build plan

The full flow of work, in the order it gets done. No timelines. Each step names what is built, where it lives, what it depends on and how we know it is finished. Strategy rules, schema and reasoning are in [PLAN.md](PLAN.md); diagrams, payloads and config shape in [ARCHITECTURE.md](ARCHITECTURE.md); tick progress in [CHECKLIST.md](CHECKLIST.md).

Rules that apply to every step:

- Nothing is "done" until it is exercised: a test, a command run against real data, or a message seen in Telegram.
- Every decision taken while building gets one line in [DECISIONS.md](DECISIONS.md).
- Both languages read the same `.env` and the same `config/strategies.yaml`. No setting is duplicated.
- Closed candles only, everywhere. Any code path that reads an open candle is a bug.
- **Unit tests are written alongside every TypeScript file, not after.** Each module under `apps/engine/src` and `apps/dashboard/src` gets a matching `*.test.ts` (vitest) in the same milestone it is created. A step is not done while its tests are missing or red. Minimum coverage per module:
  - config loaders: valid config parses, invalid timeframe or missing param is rejected
  - market data: message parsing, closed-candle detection, reconnect and gap-fill logic with a fake socket
  - exit policy: the shared Python fixtures plus invariants (stop wins in a tie, trailing never lowers the stop)
  - signal consumer and risk manager: acceptance, each rejection reason, duplicate ids ignored
  - adapters: shadow and paper fills, fee and slippage maths, precision rounding with `decimal.js`
  - position manager and journaling: SL/TP moves persisted, outcome fields computed (R, MFE, MAE, duration)
  - API routes: each endpoint returns the expected shape against a seeded test database
  - Telegram: message formatting per event type, command parsing
  Exchange and network calls are behind interfaces so tests use fakes; nothing in the unit suite touches Binance, Postgres or Redis except the API route tests, which use a disposable database. `pnpm test` runs the whole suite and must be green before every commit. Python follows the same rule with pytest.

---

## M0 — Scaffold

Goal: an empty but fully wired repo where both test suites pass and infra starts with one command.

1. **Toolchain check**. Switch to Node 22 (or install pnpm 9 directly) so pnpm works; confirm uv and Docker. Record the versions used in the README.
2. **Repo skeleton**. Root files: `.gitignore` (node, python, env files, generated code, data), `.env.example` with every variable the system will ever read, `README.md` with the quick start, `pnpm-workspace.yaml`, root `package.json` scripts (`infra:up`, `infra:down`, `migrate`, `gen`, `test`, `lint`), `tsconfig.base.json`.
3. **Folders**: `apps/engine`, `apps/dashboard`, `services/research`, `packages/contracts`, `infra`, `config`.
4. **Strategy config**. `config/strategies.yaml` in the shape given in ARCHITECTURE.md, with S1 on BTCUSDT 15m/1h as the only instance. A loader in Python (pydantic) and in TypeScript (zod) that validates it and rejects unknown timeframes or missing params. Both loaders share one test fixture.
5. **Infra**. `infra/docker-compose.yml` with TimescaleDB and Redis, persistent volumes, health checks. `infra/migrations/001_init.sql` with every table and view from PLAN.md, a `mode` column on every engine-written table, and the `schema_migrations` tracking table.
6. **Python service**. `services/research/pyproject.toml` managed by uv; package `research` with `settings` (reads `.env`), `db` (engine, migration runner, candle upsert and load helpers), and a `typer` CLI exposing `migrate`, `ingest`, `backtest`, `run-live` as stubs. `pytest` configured with one passing test.
7. **Contracts**. `packages/contracts/schemas/` with `signal.json`, `engine_event.json`, `engine_command.json`. A generate script producing zod schemas into `src/gen` and pydantic models into `research/contracts/gen.py`. Fixture JSON files for each message, and a test in each language that the fixture validates and that an unknown version or extra field is rejected.
8. **TypeScript apps**. `apps/engine` with `package.json`, `tsconfig`, `src/main.ts` that loads config, connects to Postgres and Redis and exits cleanly; `vitest` with one passing test. `apps/dashboard` as a placeholder package.
9. **First run**: `pnpm infra:up`, `pnpm migrate`, `pnpm gen`, `pnpm test`, `uv run pytest`. All green. First commit.

Done when: a fresh clone can follow the README and reach green tests with no manual steps beyond copying `.env.example`.

---

## M1 — Data

Goal: a continuously growing candle database that both languages read identically.

1. **Historical ingest** (Python, `research/ingest.py`). Uses ccxt public endpoints, no keys. Resumes from the last stored candle, requests 1000 candles per call, drops the still-forming candle, upserts idempotently, respects the rate limiter, logs progress. Reads symbols and the union of all timeframes from the strategy config.
2. **Backfill**. Run ingest for BTCUSDT 15m and 1h from 2023-01-01. Sanity checks: row count equals expected bars for the period minus known exchange downtime; no duplicate open times; each 1h candle's high and low bound the four 15m candles inside it.
3. **Live stream** (TypeScript, `apps/engine/src/marketdata`). Combined kline WebSocket for every configured symbol and timeframe. Emits an event per update and a separate event per closed candle. Handles ping/pong, the 24-hour forced disconnect, exponential backoff reconnect, and a watchdog that forces reconnect after 3 minutes of silence.
4. **Gap fill**. On every reconnect, fetch missed candles via REST for each stream before emitting closed-candle events again. Test by killing the network for five minutes and confirming no gap in the table.
5. **Persistence**. Closed candles upserted with the same conflict rule Python uses. Open candles are never written.
6. **Cross-check**. A small script in each language prints the last ten 15m candles; outputs must match byte for byte after formatting.

Done when: the engine has run for 24 hours, the table has no gaps, and the cross-check passes.

---

## M2 — Backtest

Goal: prove or disprove S1 on history with realistic costs before it watches the live market.

1. **Indicators** (Python, `research/indicators.py`). EMA, SMA, RSI (Wilder), true range and ATR (Wilder), Bollinger bands and width, MACD, ADX, swing highs and lows with a confirmation delay, level clustering. Periods come from config. Unit tests against hand-computed values on a short series, and a comparison with pandas-ta on a longer one.
2. **Exit policy, Python** (`research/exit_policy.py`). The state machine from PLAN.md: open, breakeven, trailing, closed; partial TP1; ATR trailing stop; TP ratchet; time stop; worst-case ordering when stop and target are touched in the same bar. Emits an event list. JSON fixtures in `services/research/tests/fixtures` describing bars in, events and final state out.
3. **Exit policy, TypeScript** (`apps/engine/src/positions/exitPolicy.ts`). A line-for-line port. Its test reads the same fixture files from the Python folder, not copies. Any change to one implementation must break the other's test until both are updated.
4. **Regime filter** (`research/regime.py`). Trend, volatility and no-trade-window checks on the regime timeframe, params from config.
5. **Strategy interface** (`research/strategies/base.py`). `prepare` adds indicator columns; `signal` returns a signal or nothing for bar i, using only data up to and including bar i. A look-ahead guard test: shuffle future bars and assert the signal for bar i does not change.
6. **S1 support bounce** (`research/strategies/sr_bounce.py`). Levels from regime-timeframe swings, entry conditions, stop, target from the next resistance, minimum R filter, invalidation rule. Returns the reasons dict that becomes `meta` in the journal.
7. **Backtester** (`research/backtest/`). Event-driven, bar by bar: strategy signal → fill at next open plus slippage → exit policy each bar → fees on every fill → regime exit → trade record with the same columns as a closed signal row. Portfolio limits applied (max open, one per symbol).
8. **Metrics**. Net PnL, expectancy in R, win rate, profit factor, Sharpe, max drawdown, average MFE and MAE, median bars to TP1, trades per day, exposure.
9. **Baselines**. Buy and hold; random entries with the same exit policy and the same trade count. Both must be reproducible from a seed.
10. **Walk-forward**. Split history into rolling train and test windows; optimise a small parameter grid on train, evaluate on test, report only test results.
11. **Persistence**. Runs into `backtest_runs`, trades into `backtest_trades`. CLI: `research backtest sr_bounce --symbol BTCUSDT --since 2023-01-01`.
12. **Decision**. Compare S1 test-window results with the baselines. Write the verdict to DECISIONS.md: proceed to shadow, or adjust rules and repeat from step 6.

Done when: the backtest command runs end to end, results are stored, and the decision line exists.

---

## M3 — Shadow live

Goal: the bot watches the market, records every buy point and projected sell points, follows them to an outcome, and tells you on Telegram. No orders.

1. **Signal runner** (Python, `research/live/runner.py`). Wakes shortly after each closed entry-timeframe candle (polls the candles table, so it does not need its own exchange connection). Loads the last N candles for the entry and regime timeframes, runs every strategy instance from config, writes a `signals` row with a deterministic id, publishes the same payload to the `signals` stream. Logs "no signal" checks too, so silence is distinguishable from a crash.
2. **Signal consumer** (TypeScript, `apps/engine/src/signals`). Redis consumer group, acknowledges after processing, ignores ids already in `positions` (replay safe), validates with the zod schema.
3. **Risk manager** (`apps/engine/src/risk`). Max open positions, one per symbol, paused flag, no-trade windows. In shadow mode sizing is computed but only recorded. Every rejection writes `outcome = rejected` and the reason on the signal row and emits `signal_rejected`.
4. **Shadow adapter** (`apps/engine/src/execution/shadow.ts`). Implements the adapter interface with no side effects: "fill" at the signal's entry price, "protect" records stop and targets, "close" records the exit. The same interface later gets paper, testnet and live implementations.
5. **Position manager** (`apps/engine/src/positions`). On each closed candle for the position's timeframe, computes ATR from the candles table, steps the exit policy, persists SL/TP changes, highest high, lowest low, bars held, and emits `sl_moved`, `tp_moved`, `tp_partial`, `position_closed`. Regime invalidation checked on regime-timeframe closes.
6. **Outcome journaling**. On close, writes outcome, actual entry, exit price, realised R, PnL at the configured risk, fees at the configured rate, MFE, MAE, bars held, duration and close reason back to the signal row.
7. **Events publisher**. Every engine event is validated and written to `engine.events`. `heartbeat` every hour.
8. **Telegram** (`apps/dashboard/src/telegram`, can run as its own process). Consumes `engine.events`, sends one message per event with a consistent format, a daily summary at 00:00 UTC, and accepts `/status`, `/pause`, `/resume`, `/news on|off`, which it publishes to `engine.commands`.
9. **Command consumer** in the engine for pause, resume and news toggle.
10. **Watchdogs**. No candle for 3 minutes, no heartbeat for 10 minutes, signal runner silent for two candle periods: each raises a Telegram alert.
11. **Process management**. pm2 or launchd definitions so the three processes restart on crash and on reboot; logs to files.
12. **Soak**. Run for two weeks. Then backtest the same two weeks and compare signal ids and outcomes one to one. Differences are bugs (look-ahead, timing, ATR source) and get fixed before M4 is called complete. Record the comparison in DECISIONS.md.

Done when: two weeks of shadow signals exist, the comparison with the backtest is explained, and every Telegram message type has been seen at least once.

---

## M4 — Dashboard v1

Goal: review a week of signals without a terminal.

1. **API** (`apps/dashboard/src/api`, Fastify). Read endpoints over the SQL views and tables: candles for a symbol and timeframe with a time range, signals with filters and paging, positions, events, scorecard, daily PnL, engine status. A WebSocket that forwards `engine.events` and closed candles to the browser. A command endpoint that publishes to `engine.commands`.
2. **Chart page** (React + lightweight-charts). Candles from the API, live updates over the WebSocket, symbol and timeframe pickers limited to the configured set. Overlays: signal markers with reason on hover, entry/stop/TP1/TP2 price lines for positions in flight, trailing-stop path drawn from `sl_moved` events, detected levels, an "open on TradingView" link. Clicking a journal row zooms the chart to that trade.
3. **Overview page**. Signals in flight, today's count and outcomes, engine status, last candle time, paused state.
4. **Journal page**. Every signal with filters (strategy instance, symbol, outcome, date), expandable reason panel, mini chart.
5. **Scorecard page**. Per strategy instance: trades, win rate, expectancy, profit factor, MFE of losers, MAE of winners, median time to TP1, R distribution histogram.
6. **Controls**. Pause, resume, news toggle, mirroring Telegram.
7. **Auth**. Bound to localhost only for now; a single shared token if it is ever exposed.

Done when: each page renders real shadow data and the chart updates on a live candle close.

---

## M5 — Paper wallet

Goal: exercise sizing, fees, slippage and equity without an exchange.

1. **Paper adapter**. Simulated balance from config; market fills at next candle open plus slippage; fee per fill; stop and target fills simulated against candle high and low with the same worst-case ordering as the exit policy.
2. **Sizing**. Quantity from risk per trade, notional cap, rounded to a step size fetched once from exchange info.
3. **Equity snapshots** hourly and on every close; drawdown computed.
4. **Daily loss pause** and consecutive-loss cooldown, both writing `risk_events` and alerting.
5. **Overview page** gains equity curve and daily PnL versus the limit.
6. **Check**: over the same window, paper R values equal shadow R values and paper PnL equals R times risk minus fees.

Done when: the equality check passes over at least one week.

---

## M6 — Testnet

Goal: real orders against Binance testnet with the protection rules from PLAN.md.

1. **Exchange info and precision**. Fetch filters per symbol; `decimal.js` helpers to round price to tick and quantity down to step; reject below minimums.
2. **Binance spot adapter**. Market buy with client order id equal to the signal id; fill accounting from the user data stream, fee-asset-aware sellable quantity; two OCO sell orders for TP1 and TP2 with the shared stop; cancel-and-replace of the remaining OCO on stop or target moves, at most once per candle, re-checking fills between cancel and place.
3. **User data stream**. Listen key creation, keep-alive, reconnect; REST polling fallback for order status.
4. **Reconciliation**. On start and every five minutes: open orders and balances versus the database; re-protect any position without an exchange stop; alert and pause on unknown orders.
5. **Failure handling**. OCO placement failing three times closes the position at market and alerts.
6. **Tests on testnet**: open a position, kill the engine, confirm the OCO remains on the exchange, restart, confirm the position is re-adopted and continues trailing.

Done when: the kill test passes and a full open-trail-close cycle has completed on testnet.

---

## M7 — Live small

1. Live API keys with withdrawals disabled and IP restriction; stored only in `.env`.
2. Dry run in live mode with entries disabled: confirms balances, filters and streams work against the real account.
3. Enable entries with small capital, risk and daily loss limits from config.
4. Weekly review of the journal and scorecard; each review leaves a line in DECISIONS.md.

---

## M8 — More strategies

1. S2 indicator confluence and S3 range, each as a strategy module with its own config params and fixtures, run through the same backtest, shadow and scorecard path.
2. Additional S1 instances on other timeframes or symbols by config only.
3. Parameter optimisation with optuna inside the walk-forward harness.
4. Nightly job computing "rejected signals that would have won".
5. Backtests page and Controls page in the dashboard.

---

## M9 — Futures

1. Futures adapter: stop-market and take-profit-market with reduce-only, optional exchange-native trailing stop, leverage cap, liquidation-distance check in the risk manager, funding-rate awareness.
2. Short-side support in the exit policy and strategies, with mirrored fixtures.
3. Strategy and exit-policy code otherwise unchanged; futures testnet before live.
