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
- [x] 2026-09-13: 14 coins × 15m/30m/2h/4h/1d since 2021-04-01 (or listing date) ingested, no gaps; see [DATA.md](DATA.md)
- [x] 1h since 2021-04-01 (or listing date) for all 14 coins, so S1/S2 backtests can start in 2021
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
- [ ] Run 2 weeks; compare shadow outcomes with a backtest over the same window (`research compare --mode shadow`); note in `DECISIONS.md` — soak started 2026-09-12, review ~2026-09-26

### M4 Dashboard v1

- [x] Fastify API over the SQL views + WS push
- [x] React pages: Chart (lightweight-charts over our candles, live updates, signal markers, SL/TP lines, trailing path, levels), Overview (signals in flight, today's count), Journal (every signal with reasons and outcome), Scorecard (per strategy instance)
- [x] pm2/launchd config so the bot survives reboots

### M5 Paper wallet

- [x] Simulated balance, fees, slippage, position sizing (1% risk, step/min-notional from exchangeInfo), equity snapshots (hourly + on close, `v_equity_curve`), daily-loss pause and consecutive-loss cooldown written to `risk_events` + `risk_limit_hit`; Overview shows the equity curve and today vs the daily limit
- [ ] Paper equity curve reproduces the backtest's R values over the same window — checker built (`research compare --mode paper`, exit 1 on any mismatch); needs a week of paper positions: `pm2 start ecosystem.config.cjs --only engine-paper`

### M6 Testnet

- [x] Binance spot adapter (ccxt implicit endpoints): market buy, two-OCO protection, cancel/replace once per candle, precision filters, idempotent client ids, price-constraint and stop-only fallbacks, 3-failure emergency exit
- [x] User data stream + 60s poll fallback; fee-asset-aware sellable qty
- [x] Reconciliation on start and every 5 min: unknown orders pause entries, unprotected positions re-protected, balance check
- [ ] Kill-mid-position test passed — needs `BINANCE_TESTNET_API_KEY/SECRET` in `.env`, then `MODE=testnet pnpm engine` (all of the above is verified against a fake exchange in `apps/engine/test/`)

### M7 Live small

- [x] Code path: `MODE=live` uses the same adapter on the real endpoint; `engine_state.entries_enabled` starts **false** in live (dry run: balances, filters, streams, reconciliation, no orders) and is armed with the `entries_on` command (Controls page)
- [ ] Live keys (no withdrawal, IP-restricted) in `.env`; dry run reviewed; entries enabled with small capital — your call, not automated
- [ ] Weekly journal review ritual noted in `DECISIONS.md`

### M8 More strategies · M9 Futures

- [x] S2 (`indicator_confluence`), S3 (`range`, 5m/15m/1h), second S1 instance by config (`s1_btc_1h`), optuna walk-forward (`research optimize`), nightly would-have-won job (`research would-have-won`, pm2 cron 00:30 UTC), Backtests page (runs, cumulative R, trades, would-have-won table) + Controls page
- [x] Liquidity-filtered symbol universe (`research universe --apply --ingest`): 14 pinned coins + every USDT pair with 30-day volume > $10M and spread < 0.05%, one S1 instance each in the auto-generated block of `strategies.yaml`; first run 2026-09-13 added 17 coins (31 total), backfilled and live in the engine since 2026-09-13 03:47 UTC. Refreshed weekly by the `universe-refresh` pm2 cron job (Monday 01:30), which restarts the readers when the config changed.
- [x] Pattern research pipeline (`research label` → `explain` → `forward`, [DATA.md](DATA.md#pattern-research-what-preceded-good-trades)): hindsight triple-barrier labels + 31 features for the 14 pinned coins since 2021, six barrier settings, forward test split at 2024-01-01 with a per-year and per-coin robustness flag. Findings in [PLAN.md](PLAN.md#pattern-research-findings).
- [x] S4 `dump_bounce` strategy class (two modes), `research backtest/walkforward --symbol all`, instances `s4_btc_15m` / `s4b_btc_15m` in config **disabled**. Backtest 2024→ on 32 coins: dump mode +0.159 R over 1,338 trades (profit factor 1.28); crash-bounce mode −0.03 R, dropped.
- [x] S4 walk-forward on all 28 coins (after the one-year listing-age rule): +0.114 R over 2,637 out-of-sample trades, profit factor 1.20, 22 of 28 coins positive → `dump` instances enabled in shadow for the 14 pinned coins (`s4_*_15m`) on 2026-09-13
- [x] S4 Optuna walk-forward (`scripts/s4-optimize.sh`): +0.042 R, worse than the fixed grid; parameters stay fixed. Exit variants with fixed entries (`scripts/s4-exit-variants.py`): runner exits (trail 2.5 ATR from +1R, target ratchets) adopted for the shadow instances
- [x] S4 on all 28 coins via `universe.templates`; `engine-paper` started 2026-09-13 (paper equity curve beside the shadow journal)
- [ ] S4 shadow signals reproduce the backtester on the same bars (`research compare --mode shadow`), and paper R equals backtest R (`research compare --mode paper`), after ~2 weeks (review ~2026-09-27)
- [x] `daily-check` pm2 cron posts both compare results, paper equity and open positions to Telegram every morning (07:05)
- [x] S1/S2/S3 disabled after losing on the 28-coin universe (S1 −0.36 R, S2 −0.16 R, S3 −0.56 R per trade, 2024→); S4 is the only enabled strategy and the only universe template
- [x] Telegram alerts: keys in `.env` since 2026-09-13, process restarted; `scripts/notify.sh` for ad-hoc messages
- [ ] Futures adapter, shorts, leverage cap, liquidation check
