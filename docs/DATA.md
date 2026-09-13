# Data reference

What is in the database, where it comes from and what each table is for. Schema source of truth: [001_init.sql](../infra/migrations/001_init.sql) and [002_paper_and_m8.sql](../infra/migrations/002_paper_and_m8.sql).

## The database

**TimescaleDB is the database software, not a dataset.** It is PostgreSQL with a time-series extension, run from the `timescale/timescaledb` Docker image as the `trading-db` container (host port 5435, database `trading`). Every table below lives in it.

The extension is used in two places only:

- `candles` is a **hypertable**: split into 30-day chunks behind the scenes, so "last 600 15m candles for BTCUSDT" reads one chunk instead of scanning millions of rows. A plain row count on the parent table can show 0; the rows are in the chunks.
- The dashboard resamples stored candles into other timeframes with `time_bucket()` instead of storing them.

Redis (`trading-redis`, host port 6375) is separate: it carries messages between processes (signals, engine events, commands), not history.

## How the data flows

```
candles ──► signals ──► positions ──► equity_snapshots
 (market)   (decisions)  (trades)      (account value)
```

Everything else is bookkeeping around that line or offline analysis.

## Tables

### Market data

| table | one row per | written by |
|---|---|---|
| `candles` | symbol × timeframe × candle open time: open, high, low, close, volume. Only closed candles are stored. | Python `research ingest` (history), TypeScript engine (live, plus a REST gap-fill after reconnects) |

Both writers use the same upsert rule, so it does not matter which side wrote a row.

### The trading journal

| table | one row per | written by |
|---|---|---|
| `signals` | every strategy decision: entry, stop, TP1, TP, projected R, reasons in `meta`. The engine later writes the outcome onto the same row (`outcome`, `realized_r`, `close_reason`, MFE/MAE, bars held). | Python signal runner (projection), engine (outcome) |
| `positions` | every signal the engine accepted, per mode: live stop and target as they trail, highest high, bars held, state | engine |
| `orders` / `fills` | exchange orders (entry market order, OCO legs, market exits) and their fills | engine, testnet and live only |

`signals` and `positions` are separate because several modes (shadow, paper, testnet) can act on the same signal; each gets its own position row. The first mode to act on a signal owns its outcome columns.

### Engine bookkeeping

| table | purpose |
|---|---|
| `engine_state` | one row per mode: paused, news block, entries enabled, last heartbeat, last candle, paper balance |
| `equity_snapshots` | hourly and on every close, paper mode and up: balance at cost, unrealised PnL, drawdown |
| `risk_events` | a limit triggered: daily loss, loss-streak cooldown, reconciliation mismatch, unprotected position |
| `schema_migrations` | which migration files have been applied |

### Research (offline)

| table | purpose |
|---|---|
| `backtest_runs` | one row per `research backtest` run: strategy, params, window, metrics |
| `backtest_trades` | the trades of a run, with the same columns as a closed signal so live and backtest results compare with the same query |
| `would_have_won` | nightly verdict on rejected signals: would the trade have hit its target before its stop? |

### Views (saved queries, no data of their own)

| view | used for |
|---|---|
| `v_strategy_scorecard` | Scorecard page: trades, win rate, expectancy, profit factor per strategy instance |
| `v_open_positions` | open positions with their signal's reasons |
| `v_daily_pnl` | trades, R and PnL per mode per UTC day |
| `v_equity_curve` | Overview equity chart, one point per hour |
| `v_rejected_would_have_won` | rejected signals joined to the nightly verdict |

## Candle history

Backfilled on 2026-09-13 with:

```bash
uv run --project services/research research ingest \
  --symbol BTCUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,TRXUSDT,LINKUSDT,AVAXUSDT,XLMUSDT,SHIBUSDT,ENAUSDT,C98USDT,ALICEUSDT \
  --tf 15m,30m,2h,4h,1d --since 2021-04-01
```

Binance spot, public endpoint, no keys. Counts as of 2026-09-13:

| symbol | history from | 15m | 30m | 2h | 4h | 1d |
|---|---|---|---|---|---|---|
| BTC, BNB, SOL, XRP, DOGE, ADA, TRX, LINK, AVAX, XLM, ALICE | 2021-04-01 | 191,072 | 95,537 | 23,887 | 11,945 | 1,990 |
| SHIB | 2021-05-10 (listing) | 187,312 | 93,656 | 23,416 | 11,709 | 1,951 |
| C98 | 2021-07-23 (listing) | 180,204 | 90,102 | 22,527 | 11,264 | 1,877 |
| ENA | 2024-04-02 (listing) | 85,787 | 42,893 | 10,723 | 5,361 | 893 |

Other timeframes already in the table (as of 2026-09-13):

| timeframe | original ten coins | SHIB, ENA, C98, ALICE |
|---|---|---|
| 1m | since 2023-01-01 (1,945,314 each) | engine bootstrap only (~500 bars, from 2026-09-12) |
| 1h | since 2021-04-01 (47,771 each) | ALICE since 2021-04-01 (47,771); SHIB since 2021-05-10 (46,829); C98 since 2021-07-23 (45,052); ENA since 2024-04-02 (21,447) |
| 5m | BTCUSDT since 2025-01-01 (178,550); others ~500 bars from 2026-09-11 | ~500 bars from 2026-09-11 |

1h was backfilled from 2021-04-01 on 2026-09-13, so S1/S2 backtests (which need 1h regime candles) can start at each coin's history date. 1m depth for the four new coins is optional and large: `research ingest --symbol SHIBUSDT,ENAUSDT,C98USDT,ALICEUSDT --tf 1m --since 2023-01-01` adds about 1.9M rows per coin.

**Missing candles:** the only gaps are Binance exchange-wide downtime, identical for every coin listed at the time. For 1h that is 12 bars in total (open times, UTC): 2021-04-20 02:00 and 03:00; 2021-04-25 05:00–07:00; 2021-08-13 02:00–05:00; 2021-09-29 07:00 and 08:00; 2023-03-24 13:00. BTCUSDT 15m is missing 59 slots, consistent with the same outages plus halts shorter than an hour.

Notes:

- `1000SHIBUSDT` exists only on Binance futures; the spot pair `SHIBUSDT` is used instead.
- From now on the engine appends every closed candle live for the symbols in `config/strategies.yaml`, so history keeps growing without re-running ingest.
- Re-running `ingest` is safe: it upserts, fills backwards to `--since` and forwards to the last closed candle.
- The engine only streams the timeframes the config uses: currently 1m, 5m, 15m, 1h and 4h. The 30m, 2h and 1d history is backfill for research; it does not grow live unless a strategy instance uses those timeframes or they are added to `chart_timeframes`.
- The chart reads 1m, 5m, 15m, 1h and 4h straight from stored rows. It builds 3m from 1m, and 30m, 2h and 1d from 15m, so the stored 30m/2h/1d rows are not what the chart shows.

## Symbols watched live

The `symbols:` line in [config/strategies.yaml](../config/strategies.yaml) decides which coins the engine streams and the chart offers: the fourteen above. A coin is only evaluated for trades when it also has a strategy instance (an `- id:` block) in that file. History in `candles` is independent of both: any stored symbol can be backtested.
