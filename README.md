# trading

Local crypto day-trading automation. Python for research, backtesting and signals; TypeScript for the live engine, dashboard and Telegram. Docs in [docs/](docs/): [PLAN.md](docs/PLAN.md), [PLAN_BUILD.md](docs/PLAN_BUILD.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [CHECKLIST.md](docs/CHECKLIST.md), [DECISIONS.md](docs/DECISIONS.md), [DATA.md](docs/DATA.md) (database tables and candle history).

## Prerequisites

- Node 22 (`nvm use` reads `.nvmrc`) with pnpm via corepack
- Python 3.10+ and [uv](https://docs.astral.sh/uv/)
- Docker Desktop

Versions used while building: Node 22.14.0, pnpm 11.5.1, Python 3.10.2, uv (brew).

## Quick start

```bash
cp .env.example .env
nvm use
pnpm install
uv sync --project services/research --all-extras
pnpm infra:up          # TimescaleDB + Redis in Docker
pnpm migrate           # applies infra/migrations/*.sql
pnpm gen               # generates zod + pydantic models from packages/contracts/schemas
pnpm test              # vitest (all packages) + pytest
```

Everything is configured in `config/strategies.yaml` (mode, symbols, strategy instances, timeframes, risk) and `.env` (connection strings, keys, Telegram).

## Running shadow mode (M3 + M4)

Four processes: the TypeScript engine, the Python signal runner, the dashboard API (serves the built UI on http://127.0.0.1:8787) and the Telegram bot. All are defined in `ecosystem.config.cjs` for pm2:

```bash
pnpm start:all # builds the web UI, then starts engine, signal-runner, dashboard, telegram under pm2
pnpm ps        # process list
pnpm logs      # tail all logs (also in ./logs/)
pnpm stop:all  # stop everything (other pm2 apps on the machine are untouched)
```

Or run them individually in separate terminals: `pnpm engine`, `pnpm runner`, `pnpm dashboard`, `pnpm telegram`. Dashboard dev mode with hot reload: `pnpm --filter @trading/dashboard dev:web` (proxies to the API on 8787).

Telegram commands: `/status /pause /resume /news on|off /close SYMBOL|all /kill /help`.

## Run modes (M5–M7)

One engine process per mode; `MODE=` in the environment overrides `mode:` in `strategies.yaml`, and every mode has its own consumer group, positions, equity and `engine_state` row, so modes can run side by side against the same signal runner.

| mode | entry fill | protection | wallet | needs |
| --- | --- | --- | --- | --- |
| `shadow` | signal price, immediately | none (exit policy only) | none (sizing against `paper.starting_balance`) | nothing |
| `paper` | next candle open + `paper.slippage_pct` (like the backtester) | none | simulated, persisted in `engine_state.balance_quote` | nothing |
| `testnet` | market order on testnet.binance.vision | two OCO sell lists, reconciled every 5 min | exchange balance | `BINANCE_TESTNET_API_KEY/SECRET` |
| `live` | market order | same | exchange balance | `BINANCE_API_KEY/SECRET`; boots with **entries disabled** |

```bash
pnpm dlx pm2 start ecosystem.config.cjs --only engine-paper   # paper engine beside the shadow soak (logs/engine-paper.out.log)
MODE=testnet pnpm engine                                      # testnet: real orders, OCO protection, user data stream
MODE=live pnpm engine                                         # live dry run: no entries until `entries on` in Controls (or POST /api/commands {type:"entries_on"})
uv run --project services/research research compare --mode paper   # paper positions vs a backtest of the same window (exit 1 on mismatch)
```

Testnet kill test (M6 done criterion): open a position on testnet, `pm2 stop engine` (or Ctrl-C), confirm the OCO lists are still open on the exchange, restart, and check the log line `start-up reconciliation` reports nothing re-protected and the position keeps trailing.

## Commands

```bash
uv run --project services/research research ingest            # backfill candles for the configured symbols/timeframes
uv run --project services/research research universe --apply --ingest  # refresh the liquidity-filtered symbol list by hand (the universe-refresh pm2 job does it weekly)
uv run --project services/research research backtest s1_btc_15m   # full-history backtest, stored in backtest_runs
uv run --project services/research research walkforward s1_btc_15m # rolling walk-forward over the strategy's small grid
uv run --project services/research research optimize s2_btc_15m --trials 30  # optuna TPE per train window (uv sync --extra research)
uv run --project services/research research compare --mode shadow  # live positions vs backtest over the same window
uv run --project services/research research would-have-won         # nightly: replay rejected signals (pm2 cron 00:30 UTC)
uv run --project services/research research candles --last 5       # cross-language row check (pnpm --filter @trading/engine candles)
uv run --project services/research research run-live          # signal runner (M3)
pnpm engine                                                    # TS engine in the config's mode (MODE= to override)
```

Strategies: S1 `sr_bounce` (support bounce), S2 `indicator_confluence` (RSI/Bollinger/MACD), S3 `range` (5m entries in a 15m range, 1h ADX/BB-width regime). Instances are config only — see the comment blocks in `config/strategies.yaml`.
