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

## Commands

```bash
uv run --project services/research research ingest            # backfill candles for the configured symbols/timeframes
uv run --project services/research research backtest s1_btc_15m
uv run --project services/research research run-live          # signal runner (M3)
pnpm engine                                                    # TS engine (streams candles; shadow mode in M3)
```
