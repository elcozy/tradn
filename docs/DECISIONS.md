# Decisions log

One line per decision, newest last: date, decision, reason.

- 2026-09-12 — Exchange: **Binance**. Best liquidity, free spot + futures testnets, ccxt support in both languages.
- 2026-09-12 — Market: **spot first, futures later**. No liquidation risk while the bot is being proven; adapter interface keeps futures a drop-in.
- 2026-09-12 — Languages: **Python for research/backtest/signals, TypeScript for execution/dashboard/alerts**. Python has the backtesting ecosystem; you are strongest in TS for the long-running service. Shared via Postgres + Redis + JSON contracts, never cross-calls.
- 2026-09-12 — Timeframes: **default 15m entries with a 1h regime filter (S3: 5m entries, 15m range), all configurable per strategy instance** in a config file, no code change to switch. Matches how you traded; keeps trade count high enough to learn from the journal; lets the same strategy be compared across timeframes.
- 2026-09-12 — Risk: **1% per trade, 3% max daily loss**, max 3 open positions, 1 per symbol.
- 2026-09-12 — MVP: **shadow mode, no orders**. S1 support bounce on BTCUSDT; the bot marks buy points, projected sell points and follows them to an outcome in the database, with a dashboard and Telegram notifications. Paper wallet, testnet and live come only after two weeks of reviewed shadow signals. Reason: prove the bot sees what you would have seen before any money or simulated money is involved.
- 2026-09-12 — Run modes: **shadow → paper → testnet → live**, one `MODE` setting; shadow and paper share a code path, paper adds the simulated wallet.
- 2026-09-12 — Journal: **every signal is recorded, including rejected ones**, with projection at signal time and outcome written back on close. This is the dataset for judging strategies.
- 2026-09-12 — Protection: **exchange-side OCO always**; two half-size OCOs for TP1/TP2; bot only ever ratchets them. No open position without an exchange stop.
- 2026-09-12 — Migrations: **small runner inside the Python CLI** instead of dbmate; one fewer tool to install.
- 2026-09-12 — Node: **use Node 22 (or `npm i -g pnpm@9`)** because the corepack pnpm 11 shim crashes on Node 20.
- 2026-09-12 — Dashboard chart: **TradingView Lightweight Charts over our own candles**, with signals, stops, targets, trailing path and levels drawn on it; a link to TradingView for manual analysis. Binance cannot be iframed (blocks embedding), and the free TradingView widget cannot show our own markers.
