# trading

Local crypto day-trading automation. Python for research, backtesting and signals; TypeScript for the live engine, dashboard and Telegram. Docs in [docs/](docs/): [PLAN.md](docs/PLAN.md), [PLAN_BUILD.md](docs/PLAN_BUILD.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [CHECKLIST.md](docs/CHECKLIST.md), [DECISIONS.md](docs/DECISIONS.md).

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

## Commands

```bash
uv run --project services/research research ingest            # backfill candles for the configured symbols/timeframes
uv run --project services/research research backtest s1_btc_15m   # full-history backtest, stored in backtest_runs
uv run --project services/research research walkforward s1_btc_15m # rolling walk-forward over a small grid
uv run --project services/research research candles --last 5       # cross-language row check (pnpm --filter @trading/engine candles)
uv run --project services/research research run-live          # signal runner (M3)
pnpm engine                                                    # TS engine (streams candles; shadow mode in M3)
```
