# Checklist

Tick items as they are done. Every session starts by reading this file. Milestones are defined in [PLAN.md](PLAN.md).

### Every milestone

- [x] Each new TypeScript file has a `*.test.ts` next to it and `pnpm test` is green before commit; Python files have pytest coverage the same way

### M0 Scaffold

- [x] `nvm use 22` (or `npm i -g pnpm@9`), confirm `pnpm --version`
- [x] `.gitignore`, `.env.example`, `README.md`; docs folder committed
- [x] pnpm workspace (`apps/*`, `packages/*`), `tsconfig.base.json`
- [x] `services/research/pyproject.toml` (uv), `research` CLI skeleton (`migrate`, `ingest`, `backtest`, `run-live`)
- [x] Strategy config file (`config/strategies.yaml`): symbol, `entry_tf`, `regime_tf`, indicator periods, exit-policy params per strategy instance; loaded by both Python and TS
- [x] `infra/docker-compose.yml` (TimescaleDB + Redis) and `infra/migrations/001_init.sql` with all tables, `mode` column everywhere the engine writes
- [x] `packages/contracts`: 3 JSON schemas, zod codegen, pydantic codegen, fixture tests both sides
- [x] root scripts: `infra:up`, `migrate`, `gen`, `test`, `lint`; first commit

### M1 Data

- [x] Python `ingest` (resumable, idempotent upsert, skips the still-open candle) for every timeframe in the config
- [x] BTCUSDT 15m + 1h since 2023-01-01 ingested; row counts sanity-checked
- [x] TS engine: config, logger, DB, kline WS for the configured timeframes with reconnect + watchdog, upsert closed candles
- [x] Same-row check across languages

### M2 Backtest

- [x] Indicators (EMA, RSI, ATR, Bollinger, MACD, ADX, swing points, level clustering), periods from config
- [x] Exit policy in Python + fixtures; TS port + shared-fixture test
- [x] Strategy interface + regime filter + S1, timeframes from config
- [x] Event-driven backtester (fees, slippage, exit policy, time stop, regime exit)
- [x] Metrics + baselines + walk-forward split; results into `backtest_runs` / `backtest_trades`
- [x] Decision recorded in `DECISIONS.md`: S1 good enough for shadow, or iterate

### M3 Shadow live (no orders)

- [x] Signal runner: evaluates on closed candles, deterministic ids, writes the signal row (entry, stop, TP1, TP2, projected R, reasons), publishes to Redis
- [x] Engine shadow mode: consumes signals, creates a shadow position, follows live candles with the exit policy, records SL/TP moves, MFE/MAE, bars held, and writes the outcome back to the signal row
- [x] Telegram: message on signal, TP1, stop, trailing move, close, daily summary; `/status /pause /resume`
- [x] Heartbeat and no-candle alerts
- [ ] Run 2 weeks; compare shadow outcomes with a backtest over the same window; note in `DECISIONS.md`

### M4 Dashboard v1

- [x] Fastify API over the SQL views + WS push
- [x] React pages: Chart (lightweight-charts over our candles, live updates, signal markers, SL/TP lines, trailing path, levels), Overview (signals in flight, today's count), Journal (every signal with reasons and outcome), Scorecard (per strategy instance)
- [x] pm2/launchd config so the bot survives reboots

### M5 Paper wallet

- [ ] Simulated balance, fees, slippage, position sizing (1% risk), equity snapshots, daily-loss pause, consecutive-loss cooldown
- [ ] Paper equity curve reproduces shadow R values over the same window

### M6 Testnet

- [ ] Binance spot adapter (ccxt): market buy, two-OCO protection, cancel/replace, precision filters, idempotent client ids
- [ ] User data stream + poll fallback; fee-asset-aware sellable qty
- [ ] Reconciliation against exchange; unprotected-position repair
- [ ] Kill-mid-position test passed

### M7 Live small

- [ ] Live keys (no withdrawal, IP-restricted); `MODE=live`; limits verified in a dry run
- [ ] Weekly journal review ritual noted in `DECISIONS.md`

### M8 More strategies · M9 Futures

- [ ] S2, S3, second timeframe instances of S1, optuna walk-forward, would-have-won job, Backtests + Controls pages
- [ ] Futures adapter, shorts, leverage cap, liquidation check
