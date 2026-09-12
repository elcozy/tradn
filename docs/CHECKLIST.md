# Checklist

Tick items as they are done. Every session starts by reading this file. Milestones are defined in [PLAN.md](PLAN.md).

### M0 Scaffold

- [ ] `nvm use 22` (or `npm i -g pnpm@9`), confirm `pnpm --version`
- [ ] `git init`, `.gitignore`, `.env.example`, `README.md`, `docs/PLAN.md`, `docs/CHECKLIST.md`, `docs/DECISIONS.md`
- [ ] pnpm workspace (`apps/*`, `packages/*`), `tsconfig.base.json`
- [ ] `services/research/pyproject.toml` (uv), `research` CLI skeleton (`migrate`, `ingest`, `backtest`, `run-live`)
- [ ] `infra/docker-compose.yml` (TimescaleDB + Redis) and `infra/migrations/001_init.sql` with all tables above
- [ ] `packages/contracts`: 3 JSON schemas, zod codegen, pydantic codegen, fixture tests both sides
- [ ] root scripts: `infra:up`, `migrate`, `gen`, `test`, `lint`; first commit

### M1 Data

- [ ] Python `ingest` (resumable, idempotent upsert, skips the still-open candle)
- [ ] BTCUSDT 15m + 1h since 2023-01-01 ingested; row counts sanity-checked
- [ ] TS engine: config, logger, DB, kline WS with reconnect + watchdog, upsert closed candles
- [ ] Same-row check across languages

### M2 Backtest

- [ ] Indicators (EMA, RSI, ATR, Bollinger, MACD, ADX, swing points, level clustering)
- [ ] Exit policy in Python + fixtures; TS port + shared-fixture test
- [ ] Strategy interface + regime filter + S1
- [ ] Event-driven backtester (fees, slippage, exit policy, time stop, regime exit)
- [ ] Metrics + baselines + walk-forward split; results into `backtest_runs` / `backtest_trades`
- [ ] Decision recorded in `DECISIONS.md`: S1 good enough for paper, or iterate

### M3 Paper live

- [ ] Signal runner: evaluates on closed candles, deterministic ids, writes signal row, publishes to Redis
- [ ] Engine: signal consumer (consumer group, dedupe), risk manager, paper adapter, position manager, outcome journaling, equity snapshots
- [ ] Telegram: alerts on every engine event, `/status /pause /resume /close /kill`
- [ ] Reconciliation loop (paper: DB self-consistency)
- [ ] Run 2 weeks; compare with backtest over the same window

### M4 Dashboard v1

- [ ] Fastify API over the SQL views + WS push
- [ ] React pages: Overview, Journal, Scorecard
- [ ] pm2/launchd config, heartbeat and no-candle alerts

### M5 Testnet

- [ ] Binance spot adapter (ccxt): market buy, two-OCO protection, cancel/replace, precision filters, idempotent client ids
- [ ] User data stream + poll fallback; fee-asset-aware sellable qty
- [ ] Reconciliation against exchange; unprotected-position repair
- [ ] Kill-mid-position test passed

### M6 Live small

- [ ] Live keys (no withdrawal, IP-restricted); `BINANCE_ENV=live`; limits verified in a dry run
- [ ] Weekly journal review ritual noted in `DECISIONS.md`

### M7 More strategies · M8 Futures

- [ ] S2, S3, optuna walk-forward, would-have-won job, Backtests + Controls pages
- [ ] Futures adapter, shorts, leverage cap, liquidation check
