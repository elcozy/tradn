# Decisions log

One line per decision, newest last: date, decision, reason.

- 2026-09-12 — Exchange: **Binance**. Best liquidity, free spot + futures testnets, ccxt support in both languages.
- 2026-09-12 — Market: **spot first, futures later**. No liquidation risk while the bot is being proven; adapter interface keeps futures a drop-in.
- 2026-09-12 — Languages: **Python for research/backtest/signals, TypeScript for execution/dashboard/alerts**. Python has the backtesting ecosystem; you are strongest in TS for the long-running service. Shared via Postgres + Redis + JSON contracts, never cross-calls.
- 2026-09-12 — Timeframes: **5m/15m entries, 1h regime filter**. Matches how you traded; keeps trade count high enough to learn from the journal.
- 2026-09-12 — Risk: **1% per trade, 3% max daily loss**, max 3 open positions, 1 per symbol.
- 2026-09-12 — MVP: **S1 support bounce, BTCUSDT, paper mode, Telegram-supervised**. Smallest thing that produces a real journal.
- 2026-09-12 — Journal: **every signal is recorded, including rejected ones**, with projection at signal time and outcome written back on close. This is the dataset for judging strategies.
- 2026-09-12 — Protection: **exchange-side OCO always**; two half-size OCOs for TP1/TP2; bot only ever ratchets them. No open position without an exchange stop.
- 2026-09-12 — Migrations: **small runner inside the Python CLI** instead of dbmate; one fewer tool to install.
- 2026-09-12 — Node: **use Node 22 (or `npm i -g pnpm@9`)** because the corepack pnpm 11 shim crashes on Node 20.

---
